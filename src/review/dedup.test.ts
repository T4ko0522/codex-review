import { describe, expect, it } from "vite-plus/test";
import type { ReviewJob } from "../types.ts";
import { buildDedupKey } from "./dedup.ts";

function baseJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    kind: "push",
    repo: "acme/app",
    repoUrl: "https://github.com/acme/app",
    title: "push to main",
    htmlUrl: "https://github.com/acme/app",
    sender: "alice",
    ...overrides,
  };
}

describe("buildDedupKey", () => {
  it("derives a stable key from push sha", () => {
    const job = baseJob({ kind: "push", sha: "abc0123abc0123abc0123abc0123abc0123abcd0" });
    expect(buildDedupKey(job)).toBe(`push:acme/app:${job.sha}`);
  });

  it("returns null for push without sha", () => {
    const job = baseJob({ kind: "push" });
    expect(buildDedupKey(job)).toBeNull();
  });

  it("derives a key from PR number + head sha", () => {
    const job = baseJob({
      kind: "pull_request",
      number: 42,
      sha: "headsha000000000",
      baseSha: "base0000",
    });
    expect(buildDedupKey(job)).toBe("pr:acme/app:42:headsha000000000");
  });

  it("PR key ignores base sha (same head sha is treated as duplicate)", () => {
    const a = baseJob({ kind: "pull_request", number: 42, sha: "head1", baseSha: "base1" });
    const b = baseJob({ kind: "pull_request", number: 42, sha: "head1", baseSha: "base2" });
    expect(buildDedupKey(a)).toBe(buildDedupKey(b));
  });

  it("issue key differs when body changes", () => {
    const a = baseJob({ kind: "issues", number: 7, title: "Bug", body: "A" });
    const b = baseJob({ kind: "issues", number: 7, title: "Bug", body: "B" });
    expect(buildDedupKey(a)).not.toBe(buildDedupKey(b));
  });

  it("issue key is stable when title+body unchanged", () => {
    const a = baseJob({ kind: "issues", number: 7, title: "Bug", body: "X", action: "opened" });
    const b = baseJob({ kind: "issues", number: 7, title: "Bug", body: "X", action: "edited" });
    expect(buildDedupKey(a)).toBe(buildDedupKey(b));
  });

  it("returns null for issue without number", () => {
    const job = baseJob({ kind: "issues", title: "Bug", body: "X" });
    expect(buildDedupKey(job)).toBeNull();
  });

  it("returns null for PR without number (sha alone is insufficient)", () => {
    const job = baseJob({ kind: "pull_request", sha: "headsha00000000000000000000000000000000a" });
    expect(buildDedupKey(job)).toBeNull();
  });

  it("returns null for PR without sha even when number is present", () => {
    const job = baseJob({ kind: "pull_request", number: 5 });
    expect(buildDedupKey(job)).toBeNull();
  });

  it("issue key treats missing body and empty body as equivalent", () => {
    const a = baseJob({ kind: "issues", number: 9, title: "Bug" });
    const b = baseJob({ kind: "issues", number: 9, title: "Bug", body: "" });
    expect(buildDedupKey(a)).toBe(buildDedupKey(b));
  });

  it("issue key differs when title changes (body fixed)", () => {
    const a = baseJob({ kind: "issues", number: 11, title: "A", body: "same" });
    const b = baseJob({ kind: "issues", number: 11, title: "B", body: "same" });
    expect(buildDedupKey(a)).not.toBe(buildDedupKey(b));
  });

  it("issue key uses a 16-char hex suffix", () => {
    const job = baseJob({ kind: "issues", number: 1, title: "T", body: "B" });
    const key = buildDedupKey(job);
    expect(key).toMatch(/^issue:acme\/app:1:[0-9a-f]{16}$/);
  });

  it("push and PR keys differ even when same sha is reused", () => {
    const sha = "abc0123abc0123abc0123abc0123abc0123abcd0";
    const push = baseJob({ kind: "push", sha });
    const pr = baseJob({ kind: "pull_request", sha, number: 1 });
    expect(buildDedupKey(push)).not.toBe(buildDedupKey(pr));
  });

  it("builds a mention key using commentId", () => {
    const job = baseJob({
      kind: "issues",
      number: 7,
      triggeredBy: "mention",
      commentId: 9999,
    });
    expect(buildDedupKey(job)).toBe("mention:acme/app:issues:7:9999");
  });

  it("mention key differs per commentId even with same issue", () => {
    const a = baseJob({ kind: "issues", number: 7, triggeredBy: "mention", commentId: 1 });
    const b = baseJob({ kind: "issues", number: 7, triggeredBy: "mention", commentId: 2 });
    expect(buildDedupKey(a)).not.toBe(buildDedupKey(b));
  });

  it("mention key separates pull_request and issues even with same number/comment", () => {
    const pr = baseJob({
      kind: "pull_request",
      number: 42,
      sha: "head1",
      triggeredBy: "mention",
      commentId: 500,
    });
    const iss = baseJob({
      kind: "issues",
      number: 42,
      triggeredBy: "mention",
      commentId: 500,
    });
    expect(buildDedupKey(pr)).not.toBe(buildDedupKey(iss));
  });

  it("returns null for mention without commentId", () => {
    const job = baseJob({ kind: "issues", number: 7, triggeredBy: "mention" });
    expect(buildDedupKey(job)).toBeNull();
  });
});
