import { describe, expect, it, vi } from "vite-plus/test";
import pino from "pino";
import {
  createPushIssue,
  hasSevereFindings,
  postCommitComment,
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
    expect(create.mock.calls[0]![0].title).toContain("main");
  });

  it("does not throw on API error", async () => {
    const create = vi.fn().mockRejectedValue(new Error("API error"));
    const octokit = { rest: { issues: { create } } } as any;
    const md = "## 主要な指摘\n### file:1 重大度: High\n問題";
    await expect(createPushIssue(octokit, makePushJob(), md, logger)).resolves.toBeUndefined();
  });
});
