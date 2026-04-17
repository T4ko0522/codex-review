import type { IncomingWebhook, ReviewJob } from "../types.ts";

/**
 * GitHub raw payload から ReviewJob を組み立てる。
 * 対象外アクション (closed PR など) は null を返す。
 */
export function buildJobFromPayload(input: IncomingWebhook): ReviewJob | null {
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
    };
  }

  if (event === "pull_request") {
    const action = payload.action as string | undefined;
    const allowed = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);
    if (!action || !allowed.has(action)) return null;
    const pr = payload.pull_request;
    if (!pr) return null;
    return {
      kind: "pull_request",
      repo: repository,
      repoUrl,
      sha: pr.head?.sha,
      baseSha: pr.base?.sha,
      ref: pr.head?.ref,
      baseRef: pr.base?.ref,
      title: `PR #${pr.number} ${pr.title} [${action}]`,
      htmlUrl: pr.html_url ?? `${repoUrl}/pull/${pr.number}`,
      sender: sender || pr.user?.login || "unknown",
      number: pr.number,
      body: pr.body ?? "",
      action,
      isDraft: Boolean(pr.draft),
    };
  }

  if (event === "issues") {
    const action = payload.action as string | undefined;
    const allowed = new Set(["opened", "edited", "reopened"]);
    if (!action || !allowed.has(action)) return null;
    const issue = payload.issue;
    if (!issue || issue.pull_request) return null; // PR 経由の issue イベントは無視
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
    };
  }

  return null;
}
