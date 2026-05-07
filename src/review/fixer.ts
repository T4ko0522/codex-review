import type { Octokit } from "@octokit/rest";
import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../logger.ts";
import type { ReviewJob } from "../types.ts";
import { resolveCodexFixArgs, splitArgs } from "../env.ts";
import { getDefaultBranch } from "../github/client.ts";
import {
  createFixPullRequest,
  postFixCommentOnIssue,
  postFixNoChangeComment,
} from "../github/feedback.ts";
import { runCodex } from "./codex.ts";
import { buildFixPrompt } from "./prompt.ts";
import {
  checkoutNewBranch,
  cloneRepoAtDefaultBranch,
  commitAll,
  hasUncommittedChanges,
  pushBranch,
} from "./workspace.ts";

export interface RunFixDeps {
  env: Env;
  config: AppConfig;
  logger: Logger;
  octokit: Octokit;
  /** clone / push 用 GitHub App Installation Token */
  githubToken: string;
  /** ブランチ名のタイムスタンプ生成。テストで固定するため差し替え可能 */
  now?: () => number;
}

export interface RunFixResult {
  /** Codex stdout の Markdown (PR 本文 / Discord 投稿に流用) */
  markdown: string;
  /** Codex がファイルを変更したか。false の場合は no-change コメント済み */
  changed: boolean;
  /** PR 作成成功時のみ */
  prNumber?: number;
  prUrl?: string;
  /** workspace 削除コールバック (Discord で参照する場合は呼ばずに保持) */
  cleanup?: () => void;
  /** 生成した head ブランチ (push 済み) */
  branch?: string;
}

/**
 * 自動 fix ジョブを実行し、変更があれば push + PR まで進める。
 *
 * 進行ステップ:
 *   1. デフォルトブランチを clone
 *   2. fix 用ブランチを切る (`<prefix>/issue-<N>-<ts>`)
 *   3. Codex 実行 (CODEX_FIX_ARGS / CODEX_EXTRA_ARGS の引数で書き込み許可)
 *   4. `git status --porcelain` で変更検出
 *      - なし: Issue に no-change コメント、PR 作成スキップ
 *      - あり: commit (env で author 注入) → push → PR 作成 → Issue にコメント
 *
 * 失敗時は workspace を必ず cleanup する。push 後の PR 作成失敗は呼び出し側で対応できるよう
 * 例外を投げず、changed=true / prNumber=undefined を返す。
 */
export async function runFix(job: ReviewJob, deps: RunFixDeps): Promise<RunFixResult> {
  if (job.kind !== "fix") {
    throw new Error("runFix expects job.kind === 'fix'");
  }
  if (!job.number) {
    throw new Error("runFix requires job.number to be set");
  }

  const { env, config, logger, octokit, githubToken } = deps;
  const now = deps.now ?? Date.now;
  const fixArgsString = resolveCodexFixArgs(env);
  const fixArgs = splitArgs(fixArgsString);

  const ws = await cloneRepoAtDefaultBranch({
    workspacesDir: env.WORKSPACES_DIR,
    repo: job.repo,
    repoUrl: job.repoUrl,
    depth: config.review.cloneDepth,
    githubToken,
    logger,
  });

  try {
    const [owner, repoName] = job.repo.split("/");
    if (!owner || !repoName) throw new Error(`invalid repo: ${job.repo}`);

    const baseBranch = await getDefaultBranch(octokit, owner, repoName, logger);
    if (!baseBranch) {
      throw new Error(`default branch unavailable for ${job.repo}`);
    }

    const branch = formatFixBranch(config.github.fixBranchPrefix, job.number, now());
    await checkoutNewBranch(ws.path, branch);

    const prompt = buildFixPrompt(job);
    const markdown = await runCodex({
      bin: env.CODEX_BIN,
      extraArgs: fixArgs,
      cwd: ws.path,
      prompt,
      timeoutMs: env.CODEX_TIMEOUT_MS,
      logger,
    });

    const changed = await hasUncommittedChanges(ws.path);
    if (!changed) {
      logger.info({ repo: job.repo, issue: job.number }, "fix produced no changes");
      await postFixNoChangeComment(octokit, job, logger);
      return { markdown, changed: false, cleanup: ws.cleanup };
    }

    await commitAll(ws.path, {
      message: formatCommitMessage(job),
      authorName: env.GIT_AUTHOR_NAME,
      authorEmail: env.GIT_AUTHOR_EMAIL,
    });
    await pushBranch(ws.path, branch, githubToken);

    const pr = await createFixPullRequest(octokit, job, {
      branch,
      baseBranch,
      body: markdown,
      label: config.github.fixLabel,
      logger,
    });
    if (!pr) {
      // push までは完了。PR 作成のみ失敗 → 運用者の手動フォローを許す
      logger.warn(
        { repo: job.repo, issue: job.number, branch },
        "fix branch pushed but PR creation failed",
      );
      return { markdown, changed: true, branch, cleanup: ws.cleanup };
    }

    await postFixCommentOnIssue(octokit, job, pr.number, pr.htmlUrl, logger);

    return {
      markdown,
      changed: true,
      branch,
      prNumber: pr.number,
      prUrl: pr.htmlUrl,
      cleanup: ws.cleanup,
    };
  } catch (err) {
    ws.cleanup();
    throw err;
  }
}

function formatFixBranch(prefix: string, issueNumber: number, ts: number): string {
  return `${prefix}/issue-${issueNumber}-${ts}`;
}

function formatCommitMessage(job: ReviewJob): string {
  // タイトル末尾の自動付与メタ ("[auto-fix]" 等) は冗長なので削る。
  const cleanTitle = (job.title ?? "").replace(/\s*\[(?:auto-fix|fix-mention)\]\s*$/i, "").trim();
  const head = cleanTitle.length > 0 ? cleanTitle : `Issue #${job.number}`;
  return `fix: #${job.number} ${truncateForCommit(head, 60)}`;
}

function truncateForCommit(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
