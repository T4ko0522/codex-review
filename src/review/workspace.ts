import { mkdirSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { execa } from "execa";
import type { Logger } from "../logger.ts";

export interface Workspace {
  path: string;
  cleanup: () => void;
}

export interface PrepareArgs {
  workspacesDir: string;
  repo: string; // owner/name
  repoUrl: string; // https://github.com/owner/name
  sha: string;
  /** clone の shallow depth。0 以下で full clone */
  depth: number;
  githubToken?: string;
  /** fork PR の場合、head 側リポジトリの URL */
  headRepoUrl?: string;
  logger: Logger;
}

/**
 * GITHUB_TOKEN を URL やコマンドラインに露出させず、
 * git の設定用環境変数で認証ヘッダを注入する (Git 2.31+)。
 */
function gitAuthEnv(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/**
 * 対象コミット (sha) を含む作業ディレクトリを用意する。
 * shallow clone → fetch sha → checkout の順で行う。
 */
export async function prepareWorkspace(args: PrepareArgs): Promise<Workspace> {
  const { workspacesDir, repo, repoUrl, sha, depth, githubToken, headRepoUrl, logger } = args;
  mkdirSync(workspacesDir, { recursive: true });
  const dir = join(workspacesDir, `${repo.replace("/", "__")}-${sha.slice(0, 12)}-${Date.now()}`);

  const authEnv = gitAuthEnv(githubToken);
  const execOpts = (cwd?: string) => ({
    stdio: "pipe" as const,
    env: { ...process.env, ...authEnv },
    ...(cwd ? { cwd } : {}),
  });

  // base repo を clone
  const cloneArgs = ["clone", "--quiet", "--filter=blob:none"];
  if (depth > 0) cloneArgs.push(`--depth=${depth}`);
  cloneArgs.push(repoUrl, dir);

  logger.debug({ dir, depth }, "git clone");
  await execa("git", cloneArgs, execOpts());

  // fork PR: head repo をリモートとして追加し、SHA を fetch
  if (headRepoUrl) {
    logger.debug({ headRepoUrl }, "adding fork remote");
    await execa("git", ["remote", "add", "fork", headRepoUrl], execOpts(dir));
    await execa("git", ["fetch", "--quiet", "--depth=200", "fork", sha], execOpts(dir));
  } else {
    await execa("git", ["fetch", "--quiet", "--depth=200", "origin", sha], execOpts(dir));
  }

  await execa("git", ["checkout", "--quiet", sha], execOpts(dir));

  // 実際の HEAD が期待 SHA と一致するか検証 (fail-fast)
  const { stdout: actualSha } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
  if (!actualSha.startsWith(sha.slice(0, 12))) {
    throw new Error(`SHA mismatch: expected ${sha}, got ${actualSha.trim()}`);
  }

  return {
    path: dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ dir, err: (err as Error).message }, "workspace cleanup failed");
      }
    },
  };
}

/**
 * base..head の diff を取得。base が深さ外なら fetch を試みる。
 */
export async function getDiff(
  workdir: string,
  baseSha: string | undefined,
  headSha: string,
  logger: Logger,
  githubToken?: string,
): Promise<string> {
  const authEnv = gitAuthEnv(githubToken);
  const opts = { cwd: workdir, env: { ...process.env, ...authEnv } };

  if (baseSha) {
    try {
      await execa("git", ["fetch", "--quiet", "--depth=200", "origin", baseSha], opts);
    } catch {
      /* ignore */
    }
    try {
      const { stdout } = await execa("git", ["diff", "--no-color", `${baseSha}..${headSha}`], {
        cwd: workdir,
      });
      return stdout;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "diff with base failed, falling back to HEAD^");
    }
  }
  try {
    const { stdout } = await execa("git", ["show", "--no-color", "--format=", headSha], {
      cwd: workdir,
    });
    return stdout;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "show head failed");
    return "";
  }
}

export interface DiffFilterOpts {
  includeExtensions: string[];
  excludePaths: string[];
}

/**
 * unified diff をファイル単位で分割し、includeExtensions / excludePaths でフィルタする。
 */
export function filterDiff(raw: string, opts: DiffFilterOpts): string {
  if (opts.includeExtensions.length === 0 && opts.excludePaths.length === 0) return raw;

  // "diff --git a/..." で始まるファイル単位のハンクに分割
  const parts = raw.split(/(?=^diff --git )/m);
  const filtered = parts.filter((part) => {
    const headerMatch = part.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (!headerMatch?.[2]) return true; // diff ヘッダでなければ保持
    const filePath = headerMatch[2];

    if (opts.excludePaths.length > 0 && matchAny(filePath, opts.excludePaths)) return false;
    if (opts.includeExtensions.length > 0) {
      const ext = extname(filePath).replace(/^\./, "");
      return opts.includeExtensions.includes(ext);
    }
    return true;
  });
  return filtered.join("");
}

function matchAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.includes("*")) {
      const re = new RegExp(`^${p.replace(/\./g, "\\.").replace(/\*\*/g, ".*").replace(/(?<!\.\*)\*/g, "[^/]*")}$`);
      return re.test(filePath);
    }
    return filePath === p || filePath.startsWith(`${p}/`);
  });
}
