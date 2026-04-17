import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../logger.ts";
import type { ReviewJob } from "../types.ts";
import { splitArgs } from "../env.ts";
import { runCodex } from "./codex.ts";
import { buildReviewPrompt } from "./prompt.ts";
import { createIsolatedWorkspace, filterDiff, getDiff, prepareWorkspace } from "./workspace.ts";

export interface ReviewResult {
  markdown: string;
  workspacePath?: string;
  diff?: string;
  cleanup?: () => void;
}

export interface RunReviewDeps {
  env: Env;
  config: AppConfig;
  logger: Logger;
  /** clone/fetch 用 GitHub App Installation Token */
  githubToken?: string;
}

/**
 * ジョブに対してレビューを実行し、Markdown とワークスペース情報を返す。
 * 呼び出し側は cleanup() を必要に応じて呼ぶ (スレッド対話で使い続けるなら保持)。
 */
export async function runReview(job: ReviewJob, deps: RunReviewDeps): Promise<ReviewResult> {
  const { env, config, logger, githubToken } = deps;
  const extraArgs = splitArgs(env.CODEX_EXTRA_ARGS);

  // issue は clone 不要
  if (job.kind === "issues") {
    const ws = createIsolatedWorkspace(env.WORKSPACES_DIR, logger);
    try {
      const prompt = buildReviewPrompt(job, "");
      const markdown = await runCodex({
        bin: env.CODEX_BIN,
        extraArgs,
        cwd: ws.path,
        prompt,
        timeoutMs: env.CODEX_TIMEOUT_MS,
        logger,
      });
      return { markdown, workspacePath: ws.path, cleanup: ws.cleanup };
    } catch (err) {
      ws.cleanup();
      throw err;
    }
  }

  if (!job.sha) throw new Error("sha is required for push/pull_request review");

  const ws = await prepareWorkspace({
    workspacesDir: env.WORKSPACES_DIR,
    repo: job.repo,
    repoUrl: job.repoUrl,
    sha: job.sha,
    depth: config.review.cloneDepth,
    githubToken,
    headRepoUrl: job.headRepoUrl,
    logger,
  });

  const rawDiff = await getDiff(ws.path, job.baseSha, job.sha, logger, githubToken);
  const filteredDiff = filterDiff(rawDiff, {
    includeExtensions: config.review.includeExtensions,
    excludePaths: config.review.excludePaths,
  });
  const diff = truncate(filteredDiff, config.review.maxDiffChars);

  try {
    const prompt = buildReviewPrompt(job, diff);
    const markdown = await runCodex({
      bin: env.CODEX_BIN,
      extraArgs,
      cwd: ws.path,
      prompt,
      timeoutMs: env.CODEX_TIMEOUT_MS,
      logger,
    });

    return {
      markdown,
      workspacePath: ws.path,
      diff,
      cleanup: ws.cleanup,
    };
  } catch (err) {
    ws.cleanup();
    throw err;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n... (truncated ${s.length - max} chars)`;
}
