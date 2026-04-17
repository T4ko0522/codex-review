import { describe, expect, it, vi } from "vite-plus/test";
import pino from "pino";
import { createPushIssue, hasSevereFindings, postPrReview } from "./feedback.ts";
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

  it("truncates body exceeding 60k chars", async () => {
    const createReview = vi.fn().mockResolvedValue({});
    const octokit = { rest: { pulls: { createReview } } } as any;
    const longBody = "x".repeat(65_000);
    await postPrReview(octokit, makePrJob(), longBody, logger);
    const call = createReview.mock.calls[0]![0];
    expect(call.body.length).toBeLessThanOrEqual(60_020);
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
