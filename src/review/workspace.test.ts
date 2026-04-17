import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  cloneRepoAtDefaultBranch,
  createIsolatedWorkspace,
  filterDiff,
  getDiff,
  getFollowUpWorkspace,
  prepareWorkspace,
} from "./workspace.ts";
import { execa } from "execa";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

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

  it("handles quoted filenames (with spaces) for exclusion", () => {
    const diff = [
      'diff --git "a/docs/my file.md" "b/docs/my file.md"',
      '--- "a/docs/my file.md"',
      '+++ "b/docs/my file.md"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const result = filterDiff(diff, {
      includeExtensions: [],
      excludePaths: ["docs/**"],
    });
    expect(result).toContain("src/index.ts");
    expect(result).not.toContain("my file.md");
  });

  it("filters quoted filenames by includeExtensions", () => {
    const diff = [
      'diff --git "a/notes 1.md" "b/notes 1.md"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/index.ts b/src/index.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    const result = filterDiff(diff, { includeExtensions: ["ts"], excludePaths: [] });
    expect(result).toContain("src/index.ts");
    expect(result).not.toContain("notes 1.md");
  });

  it("handles b-side-only quoted diff headers", () => {
    const diff = [
      'diff --git a/normal b/"with space"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/index.ts b/src/index.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const result = filterDiff(diff, { includeExtensions: ["ts"], excludePaths: [] });
    expect(result).toContain("src/index.ts");
    // `with space` は .ts 以外なので除外される
    expect(result).not.toContain("with space");
  });

  it("decodes tab escapes in quoted filenames so includeExtensions work", () => {
    // git は タブ付きファイル名を "a\tb.ts" のように \t でエスケープする。
    // unescape 後は実体タブ文字が入るため、拡張子抽出 (extname) は ".ts" と判定できる。
    const diff = [
      'diff --git "a/a\\tb.ts" "b/a\\tb.ts"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/other.md b/other.md",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const result = filterDiff(diff, {
      includeExtensions: ["ts"],
      excludePaths: [],
    });
    // .ts のみ残る → tab 付き名前が残り、md は除外
    expect(result).toContain("a\\tb.ts");
    expect(result).not.toContain("other.md");
  });

  it("keeps unparseable diff chunks (no diff --git header) untouched", () => {
    const raw = "arbitrary leading noise\n" + SAMPLE_DIFF;
    const result = filterDiff(raw, {
      includeExtensions: [],
      excludePaths: ["pnpm-lock.yaml"],
    });
    // 先頭の noise 部分は diff --git ヘッダを持たないので `filePath` が null → 残存
    expect(result).toContain("arbitrary leading noise");
  });
});

describe("prepareWorkspace", () => {
  let workspacesDir: string;

  beforeEach(() => {
    workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-prep-"));
    vi.mocked(execa).mockReset();
  });

  afterEach(() => {
    rmSync(workspacesDir, { recursive: true, force: true });
    vi.mocked(execa).mockReset();
  });

  it("rejects invalid repo format", async () => {
    await expect(
      prepareWorkspace({
        workspacesDir,
        repo: "invalid repo",
        repoUrl: "https://github.com/invalid/repo",
        sha: "a".repeat(40),
        depth: 1,
        logger,
      }),
    ).rejects.toThrow(/invalid repo format/);
  });

  it("rejects invalid SHA format", async () => {
    await expect(
      prepareWorkspace({
        workspacesDir,
        repo: "acme/app",
        repoUrl: "https://github.com/acme/app",
        sha: "deadbeef", // too short
        depth: 1,
        logger,
      }),
    ).rejects.toThrow(/invalid SHA format/);
  });

  it("runs clone + fetch origin + checkout + rev-parse in order for non-fork PR", async () => {
    const sha = "a".repeat(40);
    const calls: Array<[string, string[]]> = [];
    vi.mocked(execa as any).mockImplementation(async (bin: any, args: any) => {
      calls.push([bin, args]);
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      return { stdout: "" } as any;
    });

    const ws = await prepareWorkspace({
      workspacesDir,
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      sha,
      depth: 50,
      logger,
    });

    // git clone / fetch origin / checkout / rev-parse の順
    expect(calls[0]![1][0]).toBe("clone");
    expect(calls[0]![1]).toContain("--depth=50");
    expect(calls[1]![1][0]).toBe("fetch");
    expect(calls[1]![1]).toContain("origin");
    expect(calls[2]![1][0]).toBe("checkout");
    expect(calls[3]![1][0]).toBe("rev-parse");

    ws.cleanup();
  });

  it("does not add --depth flag when depth <= 0 (full clone)", async () => {
    const sha = "b".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      return { stdout: "" } as any;
    });
    await prepareWorkspace({
      workspacesDir,
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      sha,
      depth: 0,
      logger,
    });
    const cloneCall = vi.mocked(execa).mock.calls.find((c: any) => c[1]?.[0] === "clone");
    expect(cloneCall).toBeDefined();
    expect(cloneCall![1] as string[]).not.toContain("--depth=0");
    expect((cloneCall![1] as string[]).find((a: string) => a.startsWith("--depth"))).toBeUndefined();
  });

  it("adds fork remote and fetches from it when headRepoUrl is given", async () => {
    const sha = "c".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      return { stdout: "" } as any;
    });
    await prepareWorkspace({
      workspacesDir,
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      headRepoUrl: "https://github.com/fork/app",
      sha,
      depth: 10,
      logger,
    });
    const calls = vi.mocked(execa).mock.calls;
    expect(calls.find((c: any) => c[1]?.[0] === "remote" && c[1]?.[2] === "fork")).toBeDefined();
    const fetchFork = calls.find((c: any) => c[1]?.[0] === "fetch" && c[1]?.includes("fork"));
    expect(fetchFork).toBeDefined();
  });

  it("injects auth headers via GIT_CONFIG_* env when token is provided", async () => {
    const sha = "d".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      return { stdout: "" } as any;
    });
    await prepareWorkspace({
      workspacesDir,
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      sha,
      depth: 1,
      githubToken: "ghs_mytoken",
      logger,
    });
    const cloneCall = (vi.mocked(execa).mock.calls as any[]).find(
      (c: any) => c[1]?.[0] === "clone",
    )!;
    const opts = cloneCall[2] as any;
    expect(opts.env.GIT_CONFIG_COUNT).toBe("1");
    expect(opts.env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(opts.env.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /);
    // token は base64 で隠蔽されている
    expect(opts.env.GIT_CONFIG_VALUE_0).not.toContain("ghs_mytoken");
  });

  it("throws and cleans up the directory when rev-parse returns mismatched SHA", async () => {
    const sha = "e".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: "ffffffffffffff" } as any;
      return { stdout: "" } as any;
    });
    await expect(
      prepareWorkspace({
        workspacesDir,
        repo: "acme/app",
        repoUrl: "https://github.com/acme/app",
        sha,
        depth: 1,
        logger,
      }),
    ).rejects.toThrow(/SHA mismatch/);
    // 失敗後はディレクトリが残らない (mkdtempSync で作った holder は rmSync 済み)
    const remaining = require("node:fs").readdirSync(workspacesDir) as string[];
    expect(remaining).toEqual([]);
  });

  it("cleans up when git clone itself fails", async () => {
    const sha = "f".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "clone") throw new Error("network down");
      return { stdout: "" } as any;
    });
    await expect(
      prepareWorkspace({
        workspacesDir,
        repo: "acme/app",
        repoUrl: "https://github.com/acme/app",
        sha,
        depth: 1,
        logger,
      }),
    ).rejects.toThrow(/network down/);
    const remaining = require("node:fs").readdirSync(workspacesDir) as string[];
    expect(remaining).toEqual([]);
  });
});

describe("cloneRepoAtDefaultBranch", () => {
  let workspacesDir: string;

  beforeEach(() => {
    workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-clone-"));
    vi.mocked(execa).mockReset();
  });

  afterEach(() => {
    rmSync(workspacesDir, { recursive: true, force: true });
    vi.mocked(execa).mockReset();
  });

  it("clones the default branch with --filter=blob:none", async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: "" } as any);
    const ws = await cloneRepoAtDefaultBranch({
      workspacesDir,
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      depth: 20,
      logger,
    });
    const call = vi.mocked(execa).mock.calls[0]!;
    expect(call[0]).toBe("git");
    expect(call[1]).toContain("clone");
    expect(call[1]).toContain("--filter=blob:none");
    expect(call[1]).toContain("--depth=20");
    expect(ws.path.startsWith(workspacesDir)).toBe(true);
    ws.cleanup();
  });

  it("rejects invalid repo", async () => {
    await expect(
      cloneRepoAtDefaultBranch({
        workspacesDir,
        repo: "not a repo",
        repoUrl: "https://github.com/bad",
        depth: 1,
        logger,
      }),
    ).rejects.toThrow(/invalid repo format/);
  });

  it("throws and cleans up on clone failure", async () => {
    vi.mocked(execa).mockRejectedValue(new Error("boom"));
    await expect(
      cloneRepoAtDefaultBranch({
        workspacesDir,
        repo: "acme/app",
        repoUrl: "https://github.com/acme/app",
        depth: 1,
        logger,
      }),
    ).rejects.toThrow(/boom/);
    const remaining = require("node:fs").readdirSync(workspacesDir) as string[];
    expect(remaining).toEqual([]);
  });
});

describe("getDiff", () => {
  beforeEach(() => {
    vi.mocked(execa).mockReset();
  });

  afterEach(() => {
    vi.mocked(execa).mockReset();
  });

  it("rejects invalid head SHA format", async () => {
    await expect(getDiff("/tmp/x", undefined, "short", logger)).rejects.toThrow(
      /invalid SHA format/,
    );
  });

  it("rejects invalid base SHA format when provided", async () => {
    await expect(getDiff("/tmp/x", "short", "a".repeat(40), logger)).rejects.toThrow(
      /invalid SHA format/,
    );
  });

  it("uses git diff between base and head when base fetch succeeds", async () => {
    const base = "b".repeat(40);
    const head = "a".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "diff") return { stdout: "DIFF_OUTPUT" } as any;
      return { stdout: "" } as any;
    });
    const out = await getDiff("/work", base, head, logger);
    expect(out).toBe("DIFF_OUTPUT");
    // diff コマンドの引数確認
    const diffCall = vi.mocked(execa).mock.calls.find((c: any) => c[1]?.[0] === "diff")!;
    expect(diffCall[1]).toEqual(["diff", "--no-color", base, head]);
  });

  it("falls back to git show when base diff fails", async () => {
    const base = "b".repeat(40);
    const head = "a".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "fetch") return { stdout: "" } as any;
      if (args?.[0] === "diff") throw new Error("cannot diff");
      if (args?.[0] === "show") return { stdout: "SHOW_OUTPUT" } as any;
      return { stdout: "" } as any;
    });
    const out = await getDiff("/work", base, head, logger);
    expect(out).toBe("SHOW_OUTPUT");
  });

  it("tolerates fetch errors for base (continues to diff)", async () => {
    const base = "b".repeat(40);
    const head = "a".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "fetch") throw new Error("fetch failed");
      if (args?.[0] === "diff") return { stdout: "DIFF_OK" } as any;
      return { stdout: "" } as any;
    });
    const out = await getDiff("/work", base, head, logger);
    expect(out).toBe("DIFF_OK");
  });

  it("uses git show directly when base is omitted", async () => {
    const head = "a".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "show") return { stdout: "SHOW_ONLY" } as any;
      return { stdout: "" } as any;
    });
    const out = await getDiff("/work", undefined, head, logger);
    expect(out).toBe("SHOW_ONLY");
  });

  it("returns empty string when even git show fails", async () => {
    const head = "a".repeat(40);
    vi.mocked(execa).mockRejectedValue(new Error("no such object"));
    const out = await getDiff("/work", undefined, head, logger);
    expect(out).toBe("");
  });

  it("does not pass auth env to git show fallback", async () => {
    const head = "a".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "show") return { stdout: "x" } as any;
      return { stdout: "" } as any;
    });
    await getDiff("/work", undefined, head, logger, "ghs_tok");
    const showCall = (vi.mocked(execa).mock.calls as any[]).find(
      (c: any) => c[1]?.[0] === "show",
    )!;
    const opts = showCall[2] as any;
    expect(opts.cwd).toBe("/work");
    // git show fallback は auth env を渡さない
    expect(opts.env).toBeUndefined();
  });

  it("injects auth env into fetch and diff when baseSha and token are given", async () => {
    const base = "b".repeat(40);
    const head = "a".repeat(40);
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "diff") return { stdout: "DIFF" } as any;
      return { stdout: "" } as any;
    });
    await getDiff("/work", base, head, logger, "ghs_tok");
    const fetchCall = (vi.mocked(execa).mock.calls as any[]).find(
      (c: any) => c[1]?.[0] === "fetch",
    )!;
    const diffCall = (vi.mocked(execa).mock.calls as any[]).find(
      (c: any) => c[1]?.[0] === "diff",
    )!;
    expect(fetchCall[2].env.GIT_CONFIG_COUNT).toBe("1");
    expect(fetchCall[2].env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(diffCall[2].env.GIT_CONFIG_COUNT).toBe("1");
  });
});

describe("cleanupWorkspace (via createIsolatedWorkspace)", () => {
  it("swallows rmSync errors and logs warn", () => {
    const warnFn = vi.fn();
    const spyLogger = { ...logger, warn: warnFn } as any;
    const workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-cleanup-"));
    try {
      const ws = createIsolatedWorkspace(workspacesDir, spyLogger);
      writeFileSync(join(ws.path, "file.txt"), "hi");
      // rmSync が例外を投げるようにモックし、catch → logger.warn のパスを検証
      vi.mocked(rmSync).mockImplementationOnce(() => {
        throw new Error("EPERM: operation not permitted");
      });
      ws.cleanup(); // 例外を投げずに完走する
      expect(warnFn).toHaveBeenCalledOnce();
      expect(warnFn.mock.calls[0][1]).toBe("workspace cleanup failed");
    } finally {
      rmSync(workspacesDir, { recursive: true, force: true });
    }
  });
});
