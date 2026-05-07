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
  return extractSection(markdown, "主要な指摘");
}

function extractSection(markdown: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headRe = new RegExp(`^##\\s*${escaped}\\s*$`, "m");
  const m = markdown.match(headRe);
  if (!m || m.index === undefined) return null;
  const rest = markdown.slice(m.index);
  const afterHeading = rest.indexOf("\n");
  const body = afterHeading >= 0 ? rest.slice(afterHeading + 1) : "";
  const nextHeading = body.search(/^##\s+/m);
  return nextHeading >= 0 ? body.slice(0, nextHeading) : body;
}

/**
 * push レビューの Markdown から Issue タイトルを生成する。
 * 優先度: ① `## 概要` の 1 行目 (「特になし」は除外) → ② 最初の `### file:line` 見出し → ③ branch@sha の旧形式
 *
 * GitHub Issue タイトルは長すぎると一覧表示が崩れるため、表示幅 (~80 文字) で末尾を「…」に切り詰める。
 */
export function buildPushIssueTitle(markdown: string, branch: string, sha7: string): string {
  const PREFIX = "[codex-review]";
  const MAX_LEN = 80;
  const summary = firstLineFromSummary(markdown);
  if (summary) return truncateTitle(`${PREFIX} ${summary}`, MAX_LEN);
  const findingHead = firstFindingHeading(markdown);
  if (findingHead) return truncateTitle(`${PREFIX} ${findingHead}`, MAX_LEN);
  return `${PREFIX} ${branch} @ ${sha7} に重大な指摘あり`;
}

function firstLineFromSummary(markdown: string): string | null {
  const section = extractSection(markdown, "概要");
  if (section === null) return null;
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^特になし$/.test(line)) return null; // 概要セクションが空表明なら他の経路にフォールバック
    return line;
  }
  return null;
}

function firstFindingHeading(markdown: string): string | null {
  const section = extractFindingsSection(markdown);
  if (section === null) return null;
  // "### <file>:<line> 重大度: <SEVERITY>" の <file>:<line> 部分を抽出
  const m = section.match(/^###\s+(\S+:\S+)\s+重大度:\s*(\S+)/m);
  if (!m) return null;
  return `${m[1]} (${m[2]})`;
}

function truncateTitle(s: string, max: number): string {
  if (s.length <= max) return s;
  // "…" 1 字分の余白を確保して切り詰める
  return `${s.slice(0, max - 1)}…`;
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
    logger.error({ err: (err as Error).message, sha: job.sha }, "failed to post commit comment");
  }
}

/**
 * Issue にレビュー結果をコメントとして投稿する (best-effort)。
 */
export async function postIssueComment(
  octokit: Octokit,
  job: ReviewJob,
  markdown: string,
  logger: Logger,
): Promise<void> {
  if (job.kind !== "issues" || !job.number) return;
  const { owner, repo } = splitRepo(job.repo);
  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: job.number,
      body: safeBody(markdown),
    });
    logger.info({ repo: job.repo, issue: job.number }, "issue comment posted");
  } catch (err) {
    logger.error(
      { err: (err as Error).message, issue: job.number },
      "failed to post issue comment",
    );
  }
}

export interface CreateFixPullRequestArgs {
  /** push 済みの head ブランチ名 */
  branch: string;
  /** PR のターゲットブランチ (通常はリポジトリのデフォルトブランチ) */
  baseBranch: string;
  /** PR 本文として使う Markdown。末尾に `Closes #N` が無ければ自動で付与される */
  body: string;
  /** 作成 PR に付与するラベル */
  label: string;
  logger: Logger;
}

export interface CreateFixPullRequestResult {
  number: number;
  htmlUrl: string;
}

/**
 * fix ジョブで作成した head ブランチに対して PR を立てる (best-effort)。
 * 成功時は PR 番号と URL を返す。失敗時は null を返してログだけ残す。
 * ラベル付与は別 API のため、PR 自体が作成できれば null は返さず継続する。
 */
export async function createFixPullRequest(
  octokit: Octokit,
  job: ReviewJob,
  args: CreateFixPullRequestArgs,
): Promise<CreateFixPullRequestResult | null> {
  if (job.kind !== "fix" || !job.number) return null;
  const { owner, repo } = splitRepo(job.repo);
  const closesFooter = `\n\nCloses #${job.number}`;
  const bodyWithFooter = new RegExp(`Closes\\s+#${job.number}\\b`).test(args.body)
    ? args.body
    : `${args.body.trimEnd()}${closesFooter}`;
  const title = `[codex-fix] #${job.number} ${truncateForTitle(job.title)}`;
  let pr: { number: number; html_url: string };
  try {
    const res = await octokit.rest.pulls.create({
      owner,
      repo,
      head: args.branch,
      base: args.baseBranch,
      title,
      body: safeBody(bodyWithFooter),
      draft: false,
    });
    pr = { number: res.data.number, html_url: res.data.html_url };
    args.logger.info({ repo: job.repo, pr: pr.number, branch: args.branch }, "fix PR created");
  } catch (err) {
    args.logger.error(
      { err: (err as Error).message, repo: job.repo, branch: args.branch },
      "failed to create fix PR",
    );
    return null;
  }
  // ラベル付与は best-effort
  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: pr.number,
      labels: [args.label],
    });
  } catch (err) {
    args.logger.warn(
      { err: (err as Error).message, repo: job.repo, pr: pr.number },
      "failed to apply fix label",
    );
  }
  return { number: pr.number, htmlUrl: pr.html_url };
}

/**
 * fix が PR を生成したことを起因 Issue にコメントで通知する (best-effort)。
 */
export async function postFixCommentOnIssue(
  octokit: Octokit,
  job: ReviewJob,
  prNumber: number,
  prUrl: string,
  logger: Logger,
): Promise<void> {
  if (job.kind !== "fix" || !job.number) return;
  const { owner, repo } = splitRepo(job.repo);
  const body = `## 自動修正 PR を作成しました\n\n対応 PR: [#${prNumber}](${prUrl})\n\nレビューのうえ、必要であれば追加修正してください。`;
  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: job.number,
      body: safeBody(body),
    });
    logger.info({ repo: job.repo, issue: job.number, pr: prNumber }, "fix PR linked to issue");
  } catch (err) {
    logger.error(
      { err: (err as Error).message, issue: job.number },
      "failed to link fix PR to issue",
    );
  }
}

/**
 * Codex が変更を生成しなかった場合に、起因 Issue へその旨を通知する (best-effort)。
 */
export async function postFixNoChangeComment(
  octokit: Octokit,
  job: ReviewJob,
  logger: Logger,
): Promise<void> {
  if (job.kind !== "fix" || !job.number) return;
  const { owner, repo } = splitRepo(job.repo);
  const body = `## 自動修正の試行結果\n\nCodex による自動修正を試みましたが、有効な変更を生成できませんでした。Issue の内容を確認のうえ、必要であれば手動で対応してください。`;
  try {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: job.number,
      body: safeBody(body),
    });
    logger.info({ repo: job.repo, issue: job.number }, "fix no-change comment posted");
  } catch (err) {
    logger.error(
      { err: (err as Error).message, issue: job.number },
      "failed to post fix no-change comment",
    );
  }
}

function truncateForTitle(s: string, max = 80): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
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
  // 概要セクションがあればそこから、無ければ最初の指摘見出しから生成 (どちらも無ければ branch@sha)。
  // 一覧から内容が把握しやすくなり、自動 fix で立つ PR との突合もしやすい。
  const title = buildPushIssueTitle(markdown, branch, sha);
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
