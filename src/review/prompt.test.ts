import { describe, expect, it } from "vite-plus/test";
import { buildReviewPrompt, buildFollowUpPrompt } from "./prompt.ts";
import type { ReviewJob } from "../types.ts";

const baseJob: ReviewJob = {
  kind: "push",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  sha: "abc1234567890",
  baseSha: "def0000000000",
  ref: "refs/heads/main",
  title: "push to main (2 commits)",
  htmlUrl: "https://github.com/acme/app/compare/def...abc",
  sender: "alice",
  summary: "- `abc1234` feat: something\n- `def0000` fix: another",
};

describe("buildReviewPrompt", () => {
  it("includes repo, sender, sha, diff in push prompt", () => {
    const prompt = buildReviewPrompt(baseJob, "diff --git a/foo b/foo\n+bar");
    expect(prompt).toContain("`acme/app`");
    expect(prompt).toContain("`alice`");
    expect(prompt).toContain("`abc1234567890`");
    expect(prompt).toContain("diff --git a/foo b/foo");
    expect(prompt).toContain("重大度");
  });

  it("includes PR-specific fields", () => {
    const prJob: ReviewJob = {
      ...baseJob,
      kind: "pull_request",
      number: 42,
      body: "Fix the thing",
      action: "opened",
    };
    const prompt = buildReviewPrompt(prJob, "some diff");
    expect(prompt).toContain("`pull_request/opened`");
    expect(prompt).toContain("Fix the thing");
  });

  it("builds issue review prompt without diff", () => {
    const issueJob: ReviewJob = {
      kind: "issues",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      title: "Issue #10 Bug report [opened]",
      htmlUrl: "https://github.com/acme/app/issues/10",
      sender: "bob",
      number: 10,
      body: "App crashes on startup",
      action: "opened",
    };
    const prompt = buildReviewPrompt(issueJob, "");
    expect(prompt).toContain("Issue レビュー対象");
    expect(prompt).toContain("App crashes on startup");
    expect(prompt).not.toContain("```diff");
  });

  it("handles empty diff gracefully", () => {
    const prompt = buildReviewPrompt(baseJob, "");
    expect(prompt).toContain("diff 取得失敗");
  });

  it("includes commit summary when present", () => {
    const prompt = buildReviewPrompt(baseJob, "some diff");
    expect(prompt).toContain("コミット一覧");
    expect(prompt).toContain("`abc1234`");
  });
});

describe("buildFollowUpPrompt", () => {
  it("includes history and new question", () => {
    const history = [
      { role: "review", content: "## 概要\nリファクタリング" },
      { role: "user", content: "セキュリティは大丈夫？" },
    ];
    const prompt = buildFollowUpPrompt(baseJob, history, "もう少し詳しく");
    expect(prompt).toContain("レビュー初回");
    expect(prompt).toContain("ユーザー");
    expect(prompt).toContain("もう少し詳しく");
    expect(prompt).toContain("`acme/app`");
  });

  it("includes sha when present", () => {
    const prompt = buildFollowUpPrompt(baseJob, [], "質問");
    expect(prompt).toContain("`abc1234567890`");
  });
});
