import { describe, expect, it, vi } from "vite-plus/test";
import pino from "pino";
import {
  createFixPullRequest,
  createPushIssue,
  hasSevereFindings,
  postCommitComment,
  postFixCommentOnIssue,
  postFixNoChangeComment,
  postIssueComment,
  postPrReview,
} from "./feedback.ts";
import type { ReviewJob } from "../types.ts";

const logger = pino({ level: "silent" });

describe("hasSevereFindings", () => {
  it("detects Critical severity", () => {
    const md = `## 主要な指摘\n### src/index.ts:10 重大度: Critical\nSQLインジェクション`;
    expect(hasSevereFindings(md)).toBe(true);
  });

  it("detects High severity", () => {
    const md = `## 主要な指摘\n### src/auth.ts:5 重大度: High\nトークン漏えい`;
    expect(hasSevereFindings(md)).toBe(true);
  });

  it("returns false for Medium severity only", () => {
    const md = `## 主要な指摘\n### src/util.ts:3 重大度: Medium\nエラーハンドリング不足`;
    expect(hasSevereFindings(md)).toBe(false);
  });

  it("returns false for Low/Nit severity only", () => {
    const md = `## 主要な指摘\n### src/util.ts:3 重大度: Low\n命名の改善提案\n### src/index.ts:1 重大度: Nit\nインポート順`;
    expect(hasSevereFindings(md)).toBe(false);
  });

  it("returns false when findings section says 特になし", () => {
    const md = `## 主要な指摘\n特になし\n\n## 良かった点\n- 読みやすい`;
    expect(hasSevereFindings(md)).toBe(false);
  });

  it("returns false when 特になし even with severity keywords elsewhere", () => {
    const md = `## 概要\nCritical path のリファクタリング\n## 主要な指摘\n特になし`;
    expect(hasSevereFindings(md)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasSevereFindings("")).toBe(false);
  });

  it("ignores 特になし in non-findings sections", () => {
    const md = [
      "## 概要",
      "リファクタ",
      "## 主要な指摘",
      "### src/a.ts:1 重大度: Critical",
      "危険",
      "## 良かった点",
      "特になし",
    ].join("\n");
    expect(hasSevereFindings(md)).toBe(true);
  });

  it("ignores severity keywords in non-findings sections", () => {
    const md = [
      "## 概要",
      "Critical path のリファクタ",
      "## 主要な指摘",
      "### src/a.ts:1 重大度: Medium",
      "普通",
      "## リスク評価",
      "- 重大度: High のリグレッションに注意",
    ].join("\n");
    expect(hasSevereFindings(md)).toBe(false);
  });

  it("returns false when 主要な指摘 heading is absent", () => {
    const md = "### src/a.ts:1 重大度: Critical\n危険";
    expect(hasSevereFindings(md)).toBe(false);
  });
});

const makePrJob = (): ReviewJob => ({
  kind: "pull_request",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  sha: "abc1234",
  title: "PR #1 test",
  htmlUrl: "https://github.com/acme/app/pull/1",
  sender: "alice",
  number: 1,
});

const makePushJob = (): ReviewJob => ({
  kind: "push",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  sha: "abc1234567890",
  ref: "refs/heads/main",
  title: "push to main",
  htmlUrl: "https://github.com/acme/app/compare/aaa...bbb",
  sender: "alice",
});

describe("postPrReview", () => {
  it("skips when job kind is not pull_request", async () => {
    const octokit = { rest: { pulls: { createReview: vi.fn() } } } as any;
    await postPrReview(octokit, makePushJob(), "review", logger);
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it("skips when number is missing", async () => {
    const octokit = { rest: { pulls: { createReview: vi.fn() } } } as any;
    const job = { ...makePrJob(), number: undefined };
    await postPrReview(octokit, job, "review", logger);
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it("calls createReview for valid PR job", async () => {
    const createReview = vi.fn().mockResolvedValue({});
    const octokit = { rest: { pulls: { createReview } } } as any;
    await postPrReview(octokit, makePrJob(), "## review\nLGTM", logger);
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        pull_number: 1,
        event: "COMMENT",
      }),
    );
  });

  it("does not throw on API error", async () => {
    const createReview = vi.fn().mockRejectedValue(new Error("API error"));
    const octokit = { rest: { pulls: { createReview } } } as any;
    await expect(postPrReview(octokit, makePrJob(), "review", logger)).resolves.toBeUndefined();
  });

  it("truncates body exceeding 60k bytes (ASCII)", async () => {
    const createReview = vi.fn().mockResolvedValue({});
    const octokit = { rest: { pulls: { createReview } } } as any;
    const longBody = "x".repeat(65_000);
    await postPrReview(octokit, makePrJob(), longBody, logger);
    const call = createReview.mock.calls[0]![0];
    expect(Buffer.byteLength(call.body, "utf8")).toBeLessThanOrEqual(60_000);
    expect(call.body).toContain("truncated");
  });

  it("truncates multibyte body by byte length (Japanese)", async () => {
    const createReview = vi.fn().mockResolvedValue({});
    const octokit = { rest: { pulls: { createReview } } } as any;
    // 日本語 1 文字 = UTF-8 で 3 バイト。30000 文字 ≒ 90000 バイトで上限超え
    const longBody = "あ".repeat(30_000);
    await postPrReview(octokit, makePrJob(), longBody, logger);
    const call = createReview.mock.calls[0]![0];
    expect(Buffer.byteLength(call.body, "utf8")).toBeLessThanOrEqual(60_000);
    expect(call.body).toContain("truncated");
  });
});

describe("postCommitComment", () => {
  it("skips when job kind is not push", async () => {
    const createCommitComment = vi.fn();
    const octokit = { rest: { repos: { createCommitComment } } } as any;
    await postCommitComment(octokit, makePrJob(), "review", logger);
    expect(createCommitComment).not.toHaveBeenCalled();
  });

  it("skips when sha is missing", async () => {
    const createCommitComment = vi.fn();
    const octokit = { rest: { repos: { createCommitComment } } } as any;
    const job = { ...makePushJob(), sha: undefined };
    await postCommitComment(octokit, job, "review", logger);
    expect(createCommitComment).not.toHaveBeenCalled();
  });

  it("calls createCommitComment for valid push job", async () => {
    const createCommitComment = vi.fn().mockResolvedValue({});
    const octokit = { rest: { repos: { createCommitComment } } } as any;
    await postCommitComment(octokit, makePushJob(), "## review\nLGTM", logger);
    expect(createCommitComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        commit_sha: "abc1234567890",
      }),
    );
    const call = createCommitComment.mock.calls[0]![0];
    expect(call.body).toContain("LGTM");
    expect(call.body).toContain("自動レビュー結果");
  });

  it("does not throw on API error", async () => {
    const createCommitComment = vi.fn().mockRejectedValue(new Error("API error"));
    const octokit = { rest: { repos: { createCommitComment } } } as any;
    await expect(
      postCommitComment(octokit, makePushJob(), "review", logger),
    ).resolves.toBeUndefined();
  });

  it("truncates very long body", async () => {
    const createCommitComment = vi.fn().mockResolvedValue({});
    const octokit = { rest: { repos: { createCommitComment } } } as any;
    const longBody = "x".repeat(65_000);
    await postCommitComment(octokit, makePushJob(), longBody, logger);
    const call = createCommitComment.mock.calls[0]![0];
    expect(Buffer.byteLength(call.body, "utf8")).toBeLessThanOrEqual(60_000);
    expect(call.body).toContain("truncated");
  });
});

const makeIssueJob = (): ReviewJob => ({
  kind: "issues",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  title: "Issue #10 test",
  htmlUrl: "https://github.com/acme/app/issues/10",
  sender: "bob",
  number: 10,
});

describe("postIssueComment", () => {
  it("skips when job kind is not issues", async () => {
    const createComment = vi.fn();
    const octokit = { rest: { issues: { createComment } } } as any;
    await postIssueComment(octokit, makePrJob(), "review", logger);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("skips when number is missing", async () => {
    const createComment = vi.fn();
    const octokit = { rest: { issues: { createComment } } } as any;
    const job = { ...makeIssueJob(), number: undefined };
    await postIssueComment(octokit, job, "review", logger);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("calls createComment for valid issue job", async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const octokit = { rest: { issues: { createComment } } } as any;
    await postIssueComment(octokit, makeIssueJob(), "## review\nLGTM", logger);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        issue_number: 10,
      }),
    );
    const call = createComment.mock.calls[0]![0];
    expect(call.body).toContain("LGTM");
  });

  it("does not throw on API error", async () => {
    const createComment = vi.fn().mockRejectedValue(new Error("API error"));
    const octokit = { rest: { issues: { createComment } } } as any;
    await expect(
      postIssueComment(octokit, makeIssueJob(), "review", logger),
    ).resolves.toBeUndefined();
  });

  it("truncates body exceeding 60k bytes", async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const octokit = { rest: { issues: { createComment } } } as any;
    const longBody = "x".repeat(65_000);
    await postIssueComment(octokit, makeIssueJob(), longBody, logger);
    const call = createComment.mock.calls[0]![0];
    expect(Buffer.byteLength(call.body, "utf8")).toBeLessThanOrEqual(60_000);
    expect(call.body).toContain("truncated");
  });
});

describe("createPushIssue", () => {
  it("skips when job kind is not push", async () => {
    const octokit = { rest: { issues: { create: vi.fn() } } } as any;
    await createPushIssue(octokit, makePrJob(), "重大度: Critical", logger);
    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
  });

  it("skips when no severe findings", async () => {
    const octokit = { rest: { issues: { create: vi.fn() } } } as any;
    await createPushIssue(octokit, makePushJob(), "## 主要な指摘\n特になし", logger);
    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
  });

  it("creates issue for Critical finding", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 99 } });
    const octokit = { rest: { issues: { create } } } as any;
    const md = "## 主要な指摘\n### file:1 重大度: Critical\nバグ";
    await createPushIssue(octokit, makePushJob(), md, logger);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        labels: ["codex-review"],
      }),
    );
    // 概要が無い → 最初の指摘 (file:line) を使う
    expect(create.mock.calls[0]![0].title).toMatch(/^\[codex-review\]/);
    expect(create.mock.calls[0]![0].title).toContain("file:1");
  });

  it("derives title from ## 概要 section content", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 99 } });
    const octokit = { rest: { issues: { create } } } as any;
    const md = [
      "## 概要",
      "認証ミドルウェアでセッション ID をログに出力しており、漏えいリスクがある。",
      "",
      "## 主要な指摘",
      "### src/auth.ts:42 重大度: Critical",
      "詳細",
    ].join("\n");
    await createPushIssue(octokit, makePushJob(), md, logger);
    const title = create.mock.calls[0]![0].title as string;
    expect(title.startsWith("[codex-review]")).toBe(true);
    expect(title).toContain("認証ミドルウェア");
  });

  it("compresses multi-line 概要 to a single line", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 1 } });
    const octokit = { rest: { issues: { create } } } as any;
    const md = [
      "## 概要",
      "1 行目の要約。",
      "2 行目の補足。",
      "",
      "## 主要な指摘",
      "### a:1 重大度: High",
      "x",
    ].join("\n");
    await createPushIssue(octokit, makePushJob(), md, logger);
    const title = create.mock.calls[0]![0].title as string;
    expect(title).not.toContain("\n");
    // 1 行目を採用
    expect(title).toContain("1 行目の要約");
  });

  it("truncates very long 概要 with ellipsis (UTF-8 byte safe)", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 1 } });
    const octokit = { rest: { issues: { create } } } as any;
    const longSummary = "あ".repeat(200);
    const md = `## 概要\n${longSummary}\n\n## 主要な指摘\n### a:1 重大度: High\nx`;
    await createPushIssue(octokit, makePushJob(), md, logger);
    const title = create.mock.calls[0]![0].title as string;
    // GitHub Issue タイトルの実用上限 (~80 字) を超えない
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to old branch@sha title when both 概要 and findings are unparseable", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 1 } });
    const octokit = { rest: { issues: { create } } } as any;
    // 主要な指摘セクションはあるが本文に重大度しか書かれておらず、### file:line 見出しも 概要セクションも無い。
    // hasSevereFindings は通り、かつ buildPushIssueTitle は両経路で fallback する。
    const md = "## 主要な指摘\n重大度: Critical でログ出力\n";
    await createPushIssue(octokit, makePushJob(), md, logger);
    const title = create.mock.calls[0]![0].title as string;
    expect(title).toMatch(/^\[codex-review\]/);
    expect(title).toContain("main");
    expect(title).toContain("abc1234"); // sha7
  });

  it("ignores 「特になし」 in 概要 and uses finding heading instead", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 1 } });
    const octokit = { rest: { issues: { create } } } as any;
    const md = [
      "## 概要",
      "特になし",
      "",
      "## 主要な指摘",
      "### src/foo.ts:10 重大度: Critical",
      "詳細",
    ].join("\n");
    await createPushIssue(octokit, makePushJob(), md, logger);
    const title = create.mock.calls[0]![0].title as string;
    expect(title).not.toContain("特になし");
    expect(title).toContain("src/foo.ts:10");
  });

  it("does not throw on API error", async () => {
    const create = vi.fn().mockRejectedValue(new Error("API error"));
    const octokit = { rest: { issues: { create } } } as any;
    const md = "## 主要な指摘\n### file:1 重大度: High\n問題";
    await expect(createPushIssue(octokit, makePushJob(), md, logger)).resolves.toBeUndefined();
  });
});

const makeFixJob = (): ReviewJob => ({
  kind: "fix",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  title: "Issue #7 NPE [auto-fix]",
  htmlUrl: "https://github.com/acme/app/issues/7",
  sender: "ai-bot[bot]",
  number: 7,
  body: "クラッシュする",
  action: "opened",
  triggeredBy: "auto",
});

describe("createFixPullRequest", () => {
  it("skips when job kind is not fix", async () => {
    const create = vi.fn();
    const addLabels = vi.fn();
    const octokit = {
      rest: { pulls: { create }, issues: { addLabels } },
    } as any;
    const result = await createFixPullRequest(octokit, makePrJob(), {
      branch: "x/y",
      baseBranch: "main",
      body: "body",
      label: "codex-fix",
      logger,
    });
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a PR with Closes #N footer and applies label", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 123, html_url: "https://x/123" } });
    const addLabels = vi.fn().mockResolvedValue({});
    const octokit = {
      rest: { pulls: { create }, issues: { addLabels } },
    } as any;
    const result = await createFixPullRequest(octokit, makeFixJob(), {
      branch: "codex-fix/issue-7-1234567",
      baseBranch: "main",
      body: "## 概要\nNPE 修正",
      label: "codex-fix",
      logger,
    });
    expect(result).toEqual({ number: 123, htmlUrl: "https://x/123" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        head: "codex-fix/issue-7-1234567",
        base: "main",
        draft: false,
      }),
    );
    const body = create.mock.calls[0]![0].body as string;
    // Closes #N が末尾に付与され、Issue 番号 7 を解決する
    expect(body).toContain("Closes #7");
    expect(body).toContain("NPE 修正");
    expect(addLabels).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      issue_number: 123,
      labels: ["codex-fix"],
    });
  });

  it("returns null and does not throw on PR API error", async () => {
    const create = vi.fn().mockRejectedValue(new Error("422"));
    const octokit = { rest: { pulls: { create }, issues: { addLabels: vi.fn() } } } as any;
    const result = await createFixPullRequest(octokit, makeFixJob(), {
      branch: "codex-fix/issue-7-x",
      baseBranch: "main",
      body: "x",
      label: "codex-fix",
      logger,
    });
    expect(result).toBeNull();
  });

  it("still returns success when label API fails (best-effort label)", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 5, html_url: "https://x/5" } });
    const addLabels = vi.fn().mockRejectedValue(new Error("forbidden"));
    const octokit = { rest: { pulls: { create }, issues: { addLabels } } } as any;
    const result = await createFixPullRequest(octokit, makeFixJob(), {
      branch: "codex-fix/issue-7-x",
      baseBranch: "main",
      body: "x",
      label: "codex-fix",
      logger,
    });
    expect(result).toEqual({ number: 5, htmlUrl: "https://x/5" });
  });

  it("derives Closes footer from job.number even if body lacks it", async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 42, html_url: "https://x/42" } });
    const octokit = { rest: { pulls: { create }, issues: { addLabels: vi.fn() } } } as any;
    await createFixPullRequest(octokit, makeFixJob(), {
      branch: "b",
      baseBranch: "main",
      body: "## 概要\nなし",
      label: "codex-fix",
      logger,
    });
    expect(create.mock.calls[0]![0].body).toMatch(/Closes #7/);
  });
});

describe("postFixCommentOnIssue", () => {
  it("skips when kind is not fix", async () => {
    const createComment = vi.fn();
    const octokit = { rest: { issues: { createComment } } } as any;
    await postFixCommentOnIssue(octokit, makeIssueJob(), 99, "https://x/99", logger);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("posts a comment linking to the new PR", async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const octokit = { rest: { issues: { createComment } } } as any;
    await postFixCommentOnIssue(octokit, makeFixJob(), 99, "https://x/99", logger);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        issue_number: 7,
      }),
    );
    const body = createComment.mock.calls[0]![0].body as string;
    expect(body).toContain("https://x/99");
    expect(body).toContain("#99");
  });

  it("does not throw on API error", async () => {
    const createComment = vi.fn().mockRejectedValue(new Error("boom"));
    const octokit = { rest: { issues: { createComment } } } as any;
    await expect(
      postFixCommentOnIssue(octokit, makeFixJob(), 99, "https://x/99", logger),
    ).resolves.toBeUndefined();
  });
});

describe("postFixNoChangeComment", () => {
  it("posts a 'no changes' comment to the source Issue", async () => {
    const createComment = vi.fn().mockResolvedValue({});
    const octokit = { rest: { issues: { createComment } } } as any;
    await postFixNoChangeComment(octokit, makeFixJob(), logger);
    expect(createComment).toHaveBeenCalled();
    const body = createComment.mock.calls[0]![0].body as string;
    // 修正不能 / 変更なし 旨が含まれる
    expect(body).toMatch(/変更|修正|生成/);
  });

  it("skips when kind is not fix", async () => {
    const createComment = vi.fn();
    const octokit = { rest: { issues: { createComment } } } as any;
    await postFixNoChangeComment(octokit, makeIssueJob(), logger);
    expect(createComment).not.toHaveBeenCalled();
  });
});
