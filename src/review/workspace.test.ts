import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vite-plus/test";
import { createIsolatedWorkspace, filterDiff, getFollowUpWorkspace } from "./workspace.ts";

const SAMPLE_DIFF = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,3 +1,4 @@",
  " import foo;",
  "+import bar;",
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
  "--- a/pnpm-lock.yaml",
  "+++ b/pnpm-lock.yaml",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/dist/bundle.js b/dist/bundle.js",
  "--- a/dist/bundle.js",
  "+++ b/dist/bundle.js",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

const logger = pino({ level: "silent" });

describe("workspace helpers", () => {
  it("creates an isolated workspace under WORKSPACES_DIR", () => {
    const workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-ws-"));
    try {
      const workspace = createIsolatedWorkspace(workspacesDir, logger);
      expect(workspace.path).not.toBe(workspacesDir);
      expect(workspace.path.startsWith(workspacesDir)).toBe(true);
      expect(existsSync(workspace.path)).toBe(true);
      workspace.cleanup();
      expect(existsSync(workspace.path)).toBe(false);
    } finally {
      rmSync(workspacesDir, { recursive: true, force: true });
    }
  });

  it("reuses an existing follow-up workspace when it still exists", () => {
    const workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-ws-"));
    try {
      const original = createIsolatedWorkspace(workspacesDir, logger);
      const workspace = getFollowUpWorkspace(workspacesDir, original.path, logger);
      expect(workspace.path).toBe(original.path);
      workspace.cleanup();
      expect(existsSync(original.path)).toBe(true);
      original.cleanup();
    } finally {
      rmSync(workspacesDir, { recursive: true, force: true });
    }
  });

  it("falls back to a new isolated workspace when follow-up context is missing", () => {
    const workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-ws-"));
    try {
      const workspace = getFollowUpWorkspace(workspacesDir, undefined, logger);
      expect(workspace.path).not.toBe(workspacesDir);
      expect(workspace.path.startsWith(workspacesDir)).toBe(true);
      workspace.cleanup();
      expect(existsSync(workspace.path)).toBe(false);
    } finally {
      rmSync(workspacesDir, { recursive: true, force: true });
    }
  });
});

describe("filterDiff", () => {
  it("returns raw diff when no filters are set", () => {
    const result = filterDiff(SAMPLE_DIFF, { includeExtensions: [], excludePaths: [] });
    expect(result).toBe(SAMPLE_DIFF);
  });

  it("excludes paths matching glob patterns", () => {
    const result = filterDiff(SAMPLE_DIFF, {
      includeExtensions: [],
      excludePaths: ["dist/**", "pnpm-lock.yaml"],
    });
    expect(result).toContain("src/index.ts");
    expect(result).toContain("README.md");
    expect(result).not.toContain("pnpm-lock.yaml");
    expect(result).not.toContain("dist/bundle.js");
  });

  it("includes only matching extensions", () => {
    const result = filterDiff(SAMPLE_DIFF, {
      includeExtensions: ["ts"],
      excludePaths: [],
    });
    expect(result).toContain("src/index.ts");
    expect(result).not.toContain("pnpm-lock.yaml");
    expect(result).not.toContain("README.md");
    expect(result).not.toContain("dist/bundle.js");
  });

  it("applies excludePaths before includeExtensions", () => {
    const result = filterDiff(SAMPLE_DIFF, {
      includeExtensions: ["ts", "js"],
      excludePaths: ["dist/**"],
    });
    expect(result).toContain("src/index.ts");
    expect(result).not.toContain("dist/bundle.js");
  });

  it("handles *.ext glob patterns", () => {
    const result = filterDiff(SAMPLE_DIFF, {
      includeExtensions: [],
      excludePaths: ["*.yaml"],
    });
    expect(result).not.toContain("pnpm-lock.yaml");
    expect(result).toContain("src/index.ts");
  });

  it("returns empty when all files are excluded", () => {
    const result = filterDiff(SAMPLE_DIFF, {
      includeExtensions: ["py"],
      excludePaths: [],
    });
    expect(result).toBe("");
  });
});
