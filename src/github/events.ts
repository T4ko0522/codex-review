import type { IncomingWebhook, ReviewJob } from "../types.ts";

export interface BuildJobOptions {
  /** PR/Issue コメントでの mention 検知に使うトリガ文字列 */
  mentionTriggers?: readonly string[];
  /**
   * Issue コメントで fix を発火するトリガ文字列。
   * fix トリガはレビュー mention より優先される (例: "@bot fix" は "@bot" を内包する)。
   * PR コメントでの fix トリガはレビュー扱いに降格する (PR は fix の対象外)。
   */
  fixMentionTriggers?: readonly string[];
  /**
   * `issues.opened` の payload にこのラベルが付いていれば自動 fix にルートする。
   * 未指定または空文字なら自動 fix 判定をスキップ。
   */
  autoFixIssueLabel?: string;
}

/** GitHub の labels payload は { name } の配列か単純な文字列配列のいずれか */
function hasIssueLabel(payload: any, target: string): boolean {
  const labels = payload?.issue?.labels;
  if (!Array.isArray(labels)) return false;
  return labels.some((l: unknown) => {
    if (typeof l === "string") return l === target;
    if (l && typeof l === "object" && "name" in l) {
      return (l as { name?: unknown }).name === target;
    }
    return false;
  });
}

/**
 * コメント本文からコードブロック・インラインコード・引用行を除去し、
 * 実際のコメント部分のみを返す。メンション誤検知を防ぐため。
 */
export function stripNonMentionContent(body: string): string {
  return (
    body
      // fenced code blocks (```...```)
      .replace(/```[\s\S]*?```/g, "")
      // inline code (`...`)
      .replace(/`[^`]+`/g, "")
      // blockquote lines (> ...)
      .replace(/^>.*$/gm, "")
  );
}

/**
 * GitHub raw payload から ReviewJob を組み立てる。
 * 対象外アクション (closed PR など) や mention 未一致の issue_comment は null を返す。
 */
export function buildJobFromPayload(
  input: IncomingWebhook,
  opts: BuildJobOptions = {},
): ReviewJob | null {
  const { event, repository, sender, payload } = input;
  const repoUrl = `https://github.com/${repository}`;

  if (event === "push") {
    const head = payload.head_commit ?? payload.commits?.at(-1);
    if (!head) return null;
    const commits: Array<{ id: string; message: string; author?: { name?: string } }> =
      payload.commits ?? [];
    const summary = commits
      .map((c) => `- \`${c.id.slice(0, 7)}\` ${c.message.split("\n")[0]}`)
      .join("\n");
    return {
      kind: "push",
      repo: repository,
      repoUrl,
      sha: head.id ?? payload.after,
      baseSha: payload.before,
      ref: payload.ref,
      title: `push to ${String(payload.ref ?? "").replace(/^refs\/heads\//, "") || "?"} (${commits.length} commit${commits.length === 1 ? "" : "s"})`,
      htmlUrl: payload.compare ?? repoUrl,
      sender: sender || payload.pusher?.name || payload.sender?.login || "unknown",
      summary,
      triggeredBy: "auto",
    };
  }

  if (event === "pull_request") {
    const action = payload.action as string | undefined;
    const allowed = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);
    if (!action || !allowed.has(action)) return null;
    const pr = payload.pull_request;
    if (!pr) return null;
    // fork PR: head リポジトリが base と異なる場合、head 側の URL を保持
    const headRepoFullName = pr.head?.repo?.full_name;
    const isFork = headRepoFullName && headRepoFullName !== repository;
    const headRepoUrl = isFork ? `https://github.com/${headRepoFullName}` : undefined;

    return {
      kind: "pull_request",
      repo: repository,
      repoUrl,
      sha: pr.head?.sha,
      baseSha: pr.base?.sha,
      ref: pr.head?.ref,
      baseRef: pr.base?.ref,
      headRepoUrl,
      title: `PR #${pr.number} ${pr.title} [${action}]`,
      htmlUrl: pr.html_url ?? `${repoUrl}/pull/${pr.number}`,
      sender: sender || pr.user?.login || "unknown",
      number: pr.number,
      body: pr.body ?? "",
      action,
      isDraft: Boolean(pr.draft),
      triggeredBy: "auto",
    };
  }

  if (event === "issues") {
    const action = payload.action as string | undefined;
    const allowed = new Set(["opened", "edited", "reopened"]);
    if (!action || !allowed.has(action)) return null;
    const issue = payload.issue;
    if (!issue || issue.pull_request) return null; // PR 経由の issue イベントは無視

    // 自動 fix: opened かつ指定ラベルが付与されている Issue。
    // edited/reopened を含めると無限再 fix の温床になるため opened のみに限定する。
    const fixLabel = opts.autoFixIssueLabel;
    if (action === "opened" && fixLabel && hasIssueLabel(payload, fixLabel)) {
      return {
        kind: "fix",
        repo: repository,
        repoUrl,
        title: `Issue #${issue.number} ${issue.title} [auto-fix]`,
        htmlUrl: issue.html_url ?? `${repoUrl}/issues/${issue.number}`,
        sender: sender || issue.user?.login || "unknown",
        number: issue.number,
        body: issue.body ?? "",
        action,
        triggeredBy: "auto",
      };
    }

    return {
      kind: "issues",
      repo: repository,
      repoUrl,
      title: `Issue #${issue.number} ${issue.title} [${action}]`,
      htmlUrl: issue.html_url ?? `${repoUrl}/issues/${issue.number}`,
      sender: sender || issue.user?.login || "unknown",
      number: issue.number,
      body: issue.body ?? "",
      action,
      triggeredBy: "auto",
    };
  }

  if (event === "issue_comment") {
    const triggers = opts.mentionTriggers ?? [];
    const fixTriggers = opts.fixMentionTriggers ?? [];
    if (triggers.length === 0 && fixTriggers.length === 0) return null;
    const action = payload.action as string | undefined;
    if (action !== "created" && action !== "edited") return null;
    const comment = payload.comment;
    const issue = payload.issue;
    if (!comment || !issue) return null;
    const body = String(comment.body ?? "");
    const effective = stripNonMentionContent(body);
    const isPr = Boolean(issue.pull_request);
    const matchedFix = fixTriggers.some((t) => effective.includes(t));
    const matchedReview = triggers.some((t) => effective.includes(t));
    // fix は Issue でのみ有効。PR では review に降格させる。
    if (!matchedFix && !matchedReview) return null;
    if (matchedFix && !matchedReview && isPr) return null; // fix だけマッチ かつ PR → 何もしない
    const useFix = matchedFix && !isPr;
    const commentId = typeof comment.id === "number" ? comment.id : undefined;
    const commentUrl = typeof comment.html_url === "string" ? comment.html_url : undefined;
    const commenter = sender || comment.user?.login || "unknown";

    if (useFix) {
      return {
        kind: "fix",
        repo: repository,
        repoUrl,
        title: `Issue #${issue.number} ${issue.title} [fix-mention]`,
        htmlUrl: issue.html_url ?? `${repoUrl}/issues/${issue.number}`,
        sender: commenter,
        number: issue.number,
        body: issue.body ?? "",
        action: "mention",
        triggeredBy: "mention",
        commentId,
        commentUrl,
        commentBody: body,
      };
    }

    if (isPr) {
      // PR の sha/baseSha は issue_comment payload に含まれない。
      // server 側で octokit.pulls.get を呼んで補完する。
      return {
        kind: "pull_request",
        repo: repository,
        repoUrl,
        title: `PR #${issue.number} ${issue.title} [mention]`,
        htmlUrl: issue.html_url ?? `${repoUrl}/pull/${issue.number}`,
        sender: commenter,
        number: issue.number,
        body: issue.body ?? "",
        action: "mention",
        triggeredBy: "mention",
        commentId,
        commentUrl,
        commentBody: body,
      };
    }

    return {
      kind: "issues",
      repo: repository,
      repoUrl,
      title: `Issue #${issue.number} ${issue.title} [mention]`,
      htmlUrl: issue.html_url ?? `${repoUrl}/issues/${issue.number}`,
      sender: commenter,
      number: issue.number,
      body: issue.body ?? "",
      action: "mention",
      triggeredBy: "mention",
      commentId,
      commentUrl,
      commentBody: body,
    };
  }

  return null;
}
