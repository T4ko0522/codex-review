import type { Octokit } from "@octokit/rest";
import type { Logger } from "../logger.ts";
import type { ReviewJob } from "../types.ts";

const MAX_BODY = 60_000; // GitHub API body 上限 65536 に余裕を持たせる

function splitRepo(repo: string) {
	const [owner, name] = repo.split("/");
	return { owner: owner!, repo: name! };
}

function safeBody(markdown: string): string {
	if (markdown.length <= MAX_BODY) return markdown;
	return `${markdown.slice(0, MAX_BODY)}\n\n... (truncated)`;
}

/**
 * レビュー Markdown から最大重大度を判定する。
 * プロンプトが指示する `重大度: Critical|High|Medium|Low|Nit` 表記に依存。
 */
export function hasSevereFindings(markdown: string): boolean {
	if (/特にな��/.test(markdown)) return false;
	return /重大度:\s*(Critical|High)/i.test(markdown);
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
		`| 送���者 | \`${job.sender}\` |`,
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
