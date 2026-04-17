import type { Octokit } from "@octokit/rest";
import type { Logger } from "../logger.ts";
import type { ReviewJob } from "../types.ts";

// GitHub API body 上限 65536 バイトに余裕を持たせた閾値 (バイト単位)
const MAX_BODY_BYTES = 60_000;
const TRUNCATED_SUFFIX = "\n\n... (truncated)";

function splitRepo(repo: string) {
  const [owner, name] = repo.split("/");
  return { owner: owner!, repo: name! };
}

/**
 * 本文が GitHub の API body 上限に収まるよう UTF-8 バイト長で切り詰める。
 * マルチバイト文字 (日本語など) を考慮し、コードポイント境界で安全に切る。
 */
function safeBody(markdown: string): string {
  if (Buffer.byteLength(markdown, "utf8") <= MAX_BODY_BYTES) return markdown;
  const suffixBytes = Buffer.byteLength(TRUNCATED_SUFFIX, "utf8");
  const budget = MAX_BODY_BYTES - suffixBytes;
  // 文字単位に走査して budget を超える直前で止める
  let bytes = 0;
  let end = 0;
  for (let i = 0; i < markdown.length; ) {
    const cp = markdown.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const charBytes = Buffer.byteLength(String.fromCodePoint(cp), "utf8");
    if (bytes + charBytes > budget) break;
    bytes += charBytes;
    i += step;
    end = i;
  }
  return `${markdown.slice(0, end)}${TRUNCATED_SUFFIX}`;
}

/**
 * レビュー Markdown から最大重大度を判定する。
 * プロンプトが指示する `重大度: Critical|High|Medium|Low|Nit` 表記に依存。
 *
 * 判定は `## 主要な指摘` セクションの内部に限定する。
 * - 他セクション (良かった点など) の「特になし」で誤って無効化されない
 * - 他セクション内で引用された「重大度: High」等で誤検出しない
 */
export function hasSevereFindings(markdown: string): boolean {
  const section = extractFindingsSection(markdown);
  if (section === null) return false;
  // 指摘セクション自体が「特になし」表明のみの場合は無視
  if (/^\s*特になし\s*$/m.test(section)) return false;
  return /重大度:\s*(Critical|High)/i.test(section);
}

/**
 * `## 主要な指摘` 見出し直下から、次の `## ` 見出し直前までを抽出。
 * 見出しが存在しない場合は null。
 */
function extractFindingsSection(markdown: string): string | null {
  const start = markdown.search(/^##\s*主要な指摘\s*$/m);
  if (start < 0) return null;
  const rest = markdown.slice(start);
  const afterHeading = rest.indexOf("\n");
  const body = afterHeading >= 0 ? rest.slice(afterHeading + 1) : "";
  const nextHeading = body.search(/^##\s+/m);
  return nextHeading >= 0 ? body.slice(0, nextHeading) : body;
}

/**
 * PR にレビューコメントを投稿する (best-effort)。
 */
export async function postPrReview(
  octokit: Octokit,
  job: ReviewJob,
  markdown: string,
  logger: Logger,
): Promise<void> {
  if (job.kind !== "pull_request" || !job.number) return;
  const { owner, repo } = splitRepo(job.repo);
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: job.number,
      body: safeBody(markdown),
      event: "COMMENT",
      ...(job.sha ? { commit_id: job.sha } : {}),
    });
    logger.info({ repo: job.repo, pr: job.number }, "PR review comment posted");
  } catch (err) {
    logger.error({ err: (err as Error).message, pr: job.number }, "failed to post PR review");
  }
}

/**
 * push レビューで head コミットにコメントを投稿する (best-effort)。
 * Protected Branch への push が主な対象だが、呼び出し側で kind/条件を制御する前提。
 */
export async function postCommitComment(
  octokit: Octokit,
  job: ReviewJob,
  markdown: string,
  logger: Logger,
): Promise<void> {
  if (job.kind !== "push" || !job.sha) return;
  const { owner, repo } = splitRepo(job.repo);
  const branch = job.ref?.replace(/^refs\/heads\//, "") ?? "unknown";
  const header = [
    `## 自動レビュー結果`,
    ``,
    `| 項目 | 値 |`,
    `|------|-----|`,
    `| ブランチ | \`${branch}\` |`,
    `| コミット | \`${job.sha}\` |`,
    `| 送信者 | \`${job.sender}\` |`,
    ``,
  ].join("\n");
  const body = safeBody(`${header}${markdown}`);
  try {
    await octokit.rest.repos.createCommitComment({
      owner,
      repo,
      commit_sha: job.sha,
      body,
    });
    logger.info({ repo: job.repo, sha: job.sha }, "commit comment posted");
  } catch (err) {
    logger.error(
      { err: (err as Error).message, sha: job.sha },
      "failed to post commit comment",
    );
  }
}

/**
 * push レビューで Critical/High が検出された場合に Issue を作成する (best-effort)。
 */
export async function createPushIssue(
  octokit: Octokit,
  job: ReviewJob,
  markdown: string,
  logger: Logger,
): Promise<void> {
  if (job.kind !== "push") return;
  if (!hasSevereFindings(markdown)) {
    logger.debug({ repo: job.repo }, "no severe findings, skipping issue creation");
    return;
  }
  const { owner, repo } = splitRepo(job.repo);
  const branch = job.ref?.replace(/^refs\/heads\//, "") ?? "unknown";
  const sha = job.sha?.slice(0, 7) ?? "unknown";
  const title = `[codex-review] ${branch} @ ${sha} に重大な指摘あり`;
  const body = [
    `## 自動レビュー結果`,
    ``,
    `| 項目 | 値 |`,
    `|------|-----|`,
    `| ブランチ | \`${branch}\` |`,
    `| コミット | \`${job.sha ?? ""}\` |`,
    `| 送信者 | \`${job.sender}\` |`,
    `| 比較 | ${job.htmlUrl} |`,
    ``,
    markdown,
  ].join("\n");

  try {
    const res = await octokit.rest.issues.create({
      owner,
      repo,
      title,
      body: safeBody(body),
      labels: ["codex-review"],
    });
    logger.info({ repo: job.repo, issue: res.data.number }, "issue created for severe findings");
  } catch (err) {
    logger.error({ err: (err as Error).message, repo: job.repo }, "failed to create issue");
  }
}
