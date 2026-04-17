import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { execa } from "execa";
import picomatch from "picomatch";
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

const REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{40}$/;

function assertRepo(value: string): void {
  if (!REPO_RE.test(value)) throw new Error(`invalid repo format: ${value}`);
}

function assertSha(value: string): void {
  if (!SHA_RE.test(value)) throw new Error(`invalid SHA format: ${value}`);
}

export function createIsolatedWorkspace(workspacesDir: string, logger: Logger): Workspace {
  mkdirSync(workspacesDir, { recursive: true });
  const dir = mkdtempSync(join(workspacesDir, "session-"));
  return {
    path: dir,
    cleanup: () => cleanupWorkspace(dir, logger),
  };
}

export function getFollowUpWorkspace(
  workspacesDir: string,
  workspacePath: string | undefined,
  logger: Logger,
): Workspace {
  if (workspacePath && existsSync(workspacePath)) {
    return {
      path: workspacePath,
      cleanup: () => {},
    };
  }
  return createIsolatedWorkspace(workspacesDir, logger);
}

export interface CloneDefaultBranchArgs {
  workspacesDir: string;
  repo: string; // owner/name
  repoUrl: string;
  depth: number;
  githubToken?: string;
  logger: Logger;
}

/**
 * リポジトリのデフォルトブランチを shallow clone して workspace を作成する。
 * Issue レビューや follow-up で Codex に実ファイルを参照させるために使用する。
 */
export async function cloneRepoAtDefaultBranch(args: CloneDefaultBranchArgs): Promise<Workspace> {
  const { workspacesDir, repo, repoUrl, depth, githubToken, logger } = args;
  assertRepo(repo);
  mkdirSync(workspacesDir, { recursive: true });
  // 同ミリ秒で複数ジョブが到来してもディレクトリが衝突しないよう mkdtempSync で一意性を担保する。
  // git clone は空ディレクトリ上では失敗するため、作成後に削除してからパス名のみを使う。
  const holder = mkdtempSync(join(workspacesDir, `${repo.replaceAll("/", "__")}-default-`));
  rmSync(holder, { recursive: true, force: true });
  const dir = holder;

  const authEnv = gitAuthEnv(githubToken);
  const cloneArgs = ["clone", "--quiet", "--filter=blob:none"];
  if (depth > 0) cloneArgs.push(`--depth=${depth}`);
  cloneArgs.push(repoUrl, dir);

  logger.debug({ dir, depth, repo }, "git clone (default branch)");
  try {
    await execa("git", cloneArgs, {
      stdio: "pipe",
      env: { ...process.env, ...authEnv },
    });
  } catch (err) {
    cleanupWorkspace(dir, logger);
    throw err;
  }

  return {
    path: dir,
    cleanup: () => cleanupWorkspace(dir, logger),
  };
}

/**
 * トークンを URL やコマンドラインに露出させず、
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
  assertRepo(repo);
  assertSha(sha);
  mkdirSync(workspacesDir, { recursive: true });
  // 同ミリ秒での衝突を避けるため mkdtempSync で一意名を確保してから git clone 先として使う。
  const holder = mkdtempSync(
    join(workspacesDir, `${repo.replaceAll("/", "__")}-${sha.slice(0, 12)}-`),
  );
  rmSync(holder, { recursive: true, force: true });
  const dir = holder;

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
  try {
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
    const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
    const actualSha = stdout.trim();
    if (!actualSha.startsWith(sha.slice(0, 12))) {
      throw new Error(`SHA mismatch: expected ${sha}, got ${actualSha}`);
    }
  } catch (err) {
    cleanupWorkspace(dir, logger);
    throw err;
  }

  return {
    path: dir,
    cleanup: () => cleanupWorkspace(dir, logger),
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
  assertSha(headSha);
  if (baseSha) assertSha(baseSha);

  const authEnv = gitAuthEnv(githubToken);
  const opts = { cwd: workdir, env: { ...process.env, ...authEnv } };

  if (baseSha) {
    try {
      await execa("git", ["fetch", "--quiet", "--depth=200", "origin", baseSha], opts);
    } catch {
      /* ignore */
    }
    try {
      const { stdout } = await execa("git", ["diff", "--no-color", baseSha, headSha], opts);
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

  // パターンを一度だけコンパイル
  const matchers = compilePatterns(opts.excludePaths);
  const extSet = opts.includeExtensions.length > 0 ? new Set(opts.includeExtensions) : null;

  const parts = raw.split(/(?=^diff --git )/m);
  const filtered = parts.filter((part) => {
    const filePath = parseDiffHeaderPath(part);
    if (!filePath) return true;

    if (matchers.length > 0 && matchAny(filePath, matchers)) return false;
    if (extSet) return extSet.has(extname(filePath).replace(/^\./, ""));
    return true;
  });
  return filtered.join("");
}

/**
 * `diff --git` ヘッダから b 側のファイル名を抽出する。
 * 通常は `a/foo b/bar`、スペース等を含む場合は `"a/foo" "b/bar"` でクォートされる。
 * クォート内は \\t / \\n / \\\\ / \\" 等の C-escape も使われる。
 */
function parseDiffHeaderPath(part: string): string | null {
  // 1. クォート付き両端: diff --git "a/…" "b/…"
  const quoted = part.match(/^diff --git "a\/((?:\\.|[^"\\])*)" "b\/((?:\\.|[^"\\])*)"/);
  if (quoted?.[2]) return unescapeGitQuoted(quoted[2]);
  // 2. b 側のみクォート: diff --git a/… "b/…"
  const bQuoted = part.match(/^diff --git a\/\S+ "b\/((?:\\.|[^"\\])*)"/);
  if (bQuoted?.[1]) return unescapeGitQuoted(bQuoted[1]);
  // 3. 通常 (スペースなし)
  const plain = part.match(/^diff --git a\/(\S+) b\/(\S+)/);
  if (plain?.[2]) return plain[2];
  return null;
}

function unescapeGitQuoted(s: string): string {
  // git が出すクォート内エスケープを概ね復元する (制御文字までは完全復元しないが、
  // フィルタ判定に使うパス文字列として十分な程度にする)。
  return s.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\t/g, "\t").replace(/\\n/g, "\n");
}

type PatternMatcher = ((s: string) => boolean) | { literal: string };

function compilePatterns(patterns: string[]): PatternMatcher[] {
  return patterns.map((p) => {
    if (p.includes("*") || p.includes("?") || p.includes("[") || p.includes("{")) {
      // picomatch で glob を堅牢にマッチ (** / *.ext / {a,b} などをサポート)
      return picomatch(p, { dot: true });
    }
    return { literal: p };
  });
}

function matchAny(filePath: string, matchers: PatternMatcher[]): boolean {
  return matchers.some((m) => {
    if (typeof m === "function") return m(filePath);
    return filePath === m.literal || filePath.startsWith(`${m.literal}/`);
  });
}

function cleanupWorkspace(dir: string, logger: Logger): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ dir, err: (err as Error).message }, "workspace cleanup failed");
  }
}
