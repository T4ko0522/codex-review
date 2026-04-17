import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
  logger: Logger;
}

/**
 * 対象コミット (sha) を含む作業ディレクトリを用意する。
 * shallow clone → fetch sha → checkout の順で行う。
 */
export async function prepareWorkspace(args: PrepareArgs): Promise<Workspace> {
  const { workspacesDir, repo, repoUrl, sha, depth, githubToken, logger } = args;
  mkdirSync(workspacesDir, { recursive: true });
  const dir = join(workspacesDir, `${repo.replace("/", "__")}-${sha.slice(0, 12)}-${Date.now()}`);

  const authedUrl = githubToken
    ? repoUrl.replace("https://", `https://x-access-token:${githubToken}@`)
    : repoUrl;

  const cloneArgs = ["clone", "--quiet", "--filter=blob:none"];
  if (depth > 0) cloneArgs.push(`--depth=${depth}`);
  cloneArgs.push(authedUrl, dir);

  logger.debug({ dir, depth }, "git clone");
  await execa("git", cloneArgs, { stdio: "pipe" });

  try {
    await execa("git", ["fetch", "--quiet", "--depth=200", "origin", sha], { cwd: dir });
  } catch (err) {
    logger.debug(
      { err: (err as Error).message },
      "fetch sha failed, continuing with default branch",
    );
  }
  try {
    await execa("git", ["checkout", "--quiet", sha], { cwd: dir });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, sha },
      "checkout sha failed, staying on default HEAD",
    );
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
): Promise<string> {
  if (baseSha) {
    try {
      await execa("git", ["fetch", "--quiet", "--depth=200", "origin", baseSha], { cwd: workdir });
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
