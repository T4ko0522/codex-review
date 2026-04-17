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
});
