import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { branchAllowed, loadConfig, repoAllowed } from "./config.ts";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cfg-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("repoAllowed", () => {
  it("allows all when list is empty", () => {
    expect(repoAllowed([], "any/thing")).toBe(true);
  });

  it("matches exact name", () => {
    expect(repoAllowed(["acme/widget"], "acme/widget")).toBe(true);
    expect(repoAllowed(["acme/widget"], "acme/other")).toBe(false);
  });

  it("matches owner wildcard", () => {
    expect(repoAllowed(["acme/*"], "acme/widget")).toBe(true);
    expect(repoAllowed(["acme/*"], "acme/other")).toBe(true);
    expect(repoAllowed(["acme/*"], "notacme/widget")).toBe(false);
  });

  it("accepts mixed list", () => {
    expect(repoAllowed(["acme/*", "foo/bar"], "foo/bar")).toBe(true);
    expect(repoAllowed(["acme/*", "foo/bar"], "foo/baz")).toBe(false);
  });
});

describe("branchAllowed", () => {
  it("allows all when list is empty", () => {
    expect(branchAllowed([], "refs/heads/feature")).toBe(true);
  });

  it("matches simple branch name", () => {
    expect(branchAllowed(["main"], "refs/heads/main")).toBe(true);
    expect(branchAllowed(["main"], "refs/heads/develop")).toBe(false);
  });

  it("accepts name without refs/heads prefix", () => {
    expect(branchAllowed(["main"], "main")).toBe(true);
  });

  it("rejects when ref is missing", () => {
    expect(branchAllowed(["main"], undefined)).toBe(false);
  });
});

describe("loadConfig", () => {
  it("returns defaults when file does not exist", () => {
    const cfg = loadConfig(join(tmpDir, "nonexistent.yml"));
    expect(cfg.events.push).toBe(true);
    expect(cfg.review.maxDiffChars).toBe(200_000);
    expect(cfg.discord.chunkSize).toBe(1900);
    expect(cfg.github.prReviewComment).toBe(true);
  });

  it("parses a valid config file", () => {
    const file = join(tmpDir, "config.yml");
    writeFileSync(file, "events:\n  push: false\nreview:\n  cloneDepth: 10\n");
    const cfg = loadConfig(file);
    expect(cfg.events.push).toBe(false);
    expect(cfg.events.pull_request).toBe(true);
    expect(cfg.review.cloneDepth).toBe(10);
  });

  it("applies default values for missing sections", () => {
    const file = join(tmpDir, "partial.yml");
    writeFileSync(file, "discord:\n  chunkSize: 1500\n");
    const cfg = loadConfig(file);
    expect(cfg.discord.chunkSize).toBe(1500);
    expect(cfg.events.push).toBe(true);
    expect(cfg.filters.repositories).toEqual([]);
  });

  it("rejects invalid chunkSize > 2000", () => {
    const file = join(tmpDir, "bad.yml");
    writeFileSync(file, "discord:\n  chunkSize: 3000\n");
    expect(() => loadConfig(file)).toThrow();
  });
});
