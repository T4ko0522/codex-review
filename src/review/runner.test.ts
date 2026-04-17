import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { ReviewJob } from "../types.ts";
import { runReview } from "./runner.ts";
import { runCodex } from "./codex.ts";
import { execa } from "execa";

vi.mock("./codex.ts", () => ({
  runCodex: vi.fn(),
}));

// デフォルトでは execa は失敗する (issue fallback 経路をテストするため)。
// 個別テストで mockImplementation を上書きして成功経路をテストする。
vi.mock("execa", () => ({
  execa: vi.fn(async () => {
    throw new Error("execa disabled in tests");
  }),
}));

const logger = pino({ level: "silent" });

const config: AppConfig = {
  events: {
    push: { enabled: true, mode: "all" },
    pull_request: { enabled: true, autoReviewOn: ["opened"] },
    issues: { enabled: true, autoReviewOn: [] },
  },
  filters: { repositories: [], branches: [], skipDraftPullRequests: true, skipBotSenders: true },
  review: { maxDiffChars: 200_000, cloneDepth: 50, includeExtensions: [], excludePaths: [] },
  github: { prReviewComment: true, pushCommitComment: true, pushIssueOnSevere: true },
  mention: { triggers: ["@CodexRabbit[bot]"] },
  discord: { chunkSize: 1900, threadAutoArchiveMinutes: 1440, enableThreadChat: true },
  workspace: { ttlMinutes: 1440 },
};

const issueJob: ReviewJob = {
  kind: "issues",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  title: "Issue #7 Bug report [opened]",
  htmlUrl: "https://github.com/acme/app/issues/7",
  sender: "alice",
  number: 7,
  body: "App crashes on startup",
  action: "opened",
};

let workspacesDir: string;
let env: Env;

beforeEach(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-runner-"));
  env = {
    HTTP_HOST: "127.0.0.1",
    HTTP_PORT: 3000,
    WEBHOOK_SECRET: "test-secret-12345678",
    GITHUB_APP_ID: 123456,
    GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/github-app-key.pem",
    GITHUB_APP_INSTALLATION_ID: 789,
    DISCORD_BOT_TOKEN: "discord-token",
    DISCORD_CHANNEL_ID: "123456789",
    CODEX_BIN: "codex",
    CODEX_EXTRA_ARGS: "",
    CODEX_TIMEOUT_MS: 900_000,
    SHUTDOWN_TIMEOUT_MS: 30_000,
    WORKSPACES_DIR: workspacesDir,
    DATA_DIR: workspacesDir,
    LOG_LEVEL: "info",
    CONFIG_FILE: "/tmp/config.yml",
  };
  vi.mocked(runCodex).mockReset();
  vi.mocked(runCodex).mockImplementation(async ({ cwd }) => `cwd=${cwd}`);
  // execa はデフォルトの失敗実装に戻す
  vi.mocked(execa).mockReset();
  vi.mocked(execa as any).mockImplementation(async () => {
    throw new Error("execa disabled in tests");
  });
});

afterEach(() => {
  rmSync(workspacesDir, { recursive: true, force: true });
});

describe("runReview", () => {
  it("uses an isolated workspace for issue reviews", async () => {
    const result = await runReview(issueJob, { env, config, logger });

    expect(result.workspacePath).toBeDefined();
    expect(result.workspacePath).not.toBe(workspacesDir);
    expect(result.workspacePath!.startsWith(workspacesDir)).toBe(true);
    expect(existsSync(result.workspacePath!)).toBe(true);
    expect(vi.mocked(runCodex)).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: result.workspacePath }),
    );

    result.cleanup?.();
    expect(existsSync(result.workspacePath!)).toBe(false);
  });

  it("cleans up the isolated workspace when runCodex fails during issue review", async () => {
    vi.mocked(runCodex).mockRejectedValue(new Error("issue codex failed"));

    await expect(runReview(issueJob, { env, config, logger })).rejects.toThrow(
      "issue codex failed",
    );
    // fallback の isolated workspace が cleanup されて残らないこと
    expect(readdirSync(workspacesDir)).toEqual([]);
  });

  it("uses the cloned workspace for issue when clone succeeds", async () => {
    // git clone を成功させ (空のディレクトリとして残す)、runCodex まで成功させる
    vi.mocked(execa as any).mockImplementation(async () => ({ stdout: "" }) as any);

    const result = await runReview(issueJob, { env, config, logger });

    expect(result.workspacePath!.startsWith(workspacesDir)).toBe(true);
    // clone 先フォルダは holder 名 (<repo>__<name>-default-) で始まる
    const dirname = result.workspacePath!.slice(workspacesDir.length + 1);
    expect(dirname.startsWith("acme__app-default-")).toBe(true);

    result.cleanup?.();
  });
});

describe("runReview (push/pull_request)", () => {
  const sha = "a".repeat(40);
  const pushJob: ReviewJob = {
    kind: "push",
    repo: "acme/app",
    repoUrl: "https://github.com/acme/app",
    sha,
    baseSha: "b".repeat(40),
    ref: "refs/heads/main",
    title: "push to main",
    htmlUrl: "https://github.com/acme/app/commit/a",
    sender: "alice",
    summary: "- `aaaa` feat",
  };

  it("throws when sha is missing on push", async () => {
    const bad: ReviewJob = { ...pushJob, sha: undefined };
    await expect(runReview(bad, { env, config, logger })).rejects.toThrow(/sha is required/);
  });

  it("runs full flow (clone + fetch + checkout + rev-parse + diff + codex) for push", async () => {
    // execa: rev-parse は sha、diff は適当、その他は空
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      if (args?.[0] === "diff") return { stdout: "diff --git a/x b/x\n+foo" } as any;
      return { stdout: "" } as any;
    });

    const result = await runReview(pushJob, { env, config, logger });

    expect(result.markdown).toMatch(/^cwd=/);
    expect(result.diff).toContain("diff --git a/x b/x");
    expect(result.workspacePath!.startsWith(workspacesDir)).toBe(true);
    // runCodex に渡された cwd は workspace 内
    expect(vi.mocked(runCodex)).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: result.workspacePath }),
    );

    result.cleanup?.();
    expect(existsSync(result.workspacePath!)).toBe(false);
  });

  it("cleans up workspace when codex fails during push review", async () => {
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      return { stdout: "" } as any;
    });
    vi.mocked(runCodex).mockRejectedValue(new Error("codex crashed"));

    await expect(runReview(pushJob, { env, config, logger })).rejects.toThrow("codex crashed");
    // cleanup が呼ばれて workspacesDir 内には何も残っていない
    expect(readdirSync(workspacesDir)).toEqual([]);
  });

  it("truncates overly long diff output with a marker", async () => {
    // maxDiffChars を十分小さくする
    const tinyConfig: AppConfig = {
      ...config,
      review: { ...config.review, maxDiffChars: 50 },
    };
    const bigDiff = `diff --git a/f b/f\n${"X".repeat(500)}`;
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      if (args?.[0] === "diff") return { stdout: bigDiff } as any;
      return { stdout: "" } as any;
    });

    const result = await runReview(pushJob, { env, config: tinyConfig, logger });
    expect(result.diff).toMatch(/\.\.\. \(truncated \d+ chars\)$/);
    expect(result.diff!.length).toBeLessThan(bigDiff.length);
    result.cleanup?.();
  });

  it("does not truncate when diff is within maxDiffChars", async () => {
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      if (args?.[0] === "diff") return { stdout: "short diff" } as any;
      return { stdout: "" } as any;
    });
    const result = await runReview(pushJob, { env, config, logger });
    expect(result.diff).toBe("short diff");
    result.cleanup?.();
  });

  it("handles truncation that would split a UTF-16 surrogate pair", async () => {
    // 絵文字 (surrogate pair) を境界ギリギリに置いて、高サロゲート末尾の case を踏む
    // maxDiffChars=3 で "ab🎉" (length 5) を切ると、end=3 → charCodeAt(2) が high surrogate
    // → end -= 1 して slice(0, 2) = "ab" となる
    const diffStr = "ab🎉cd";
    const tinyConfig: AppConfig = {
      ...config,
      review: { ...config.review, maxDiffChars: 3 },
    };
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      if (args?.[0] === "diff") return { stdout: diffStr } as any;
      return { stdout: "" } as any;
    });
    const result = await runReview(pushJob, { env, config: tinyConfig, logger });
    // truncated 部分に half surrogate が残っていないこと
    const headSlice = result.diff!.split("\n\n... (truncated")[0]!;
    expect(headSlice).toBe("ab");
    result.cleanup?.();
  });

  it("passes CODEX_EXTRA_ARGS through to runCodex", async () => {
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      return { stdout: "" } as any;
    });
    const customEnv: Env = { ...env, CODEX_EXTRA_ARGS: "--model gpt-4o --reasoning high" };
    const result = await runReview(pushJob, { env: customEnv, config, logger });
    expect(vi.mocked(runCodex)).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: ["--model", "gpt-4o", "--reasoning", "high"],
      }),
    );
    result.cleanup?.();
  });

  it("applies PR review flow with PR-specific fields (includes number/body)", async () => {
    const prJob: ReviewJob = {
      ...pushJob,
      kind: "pull_request",
      number: 42,
      body: "Fix the thing",
      action: "opened",
    };
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      if (args?.[0] === "diff") return { stdout: "" } as any;
      return { stdout: "" } as any;
    });
    const result = await runReview(prJob, { env, config, logger });
    // runCodex 呼び出し時の prompt に PR 本文が含まれる
    const call = vi.mocked(runCodex).mock.calls[0]![0];
    expect(call.prompt).toContain("Fix the thing");
    expect(call.prompt).toContain("`pull_request/opened`");
    result.cleanup?.();
  });

  it("filters the raw diff according to config before passing to codex", async () => {
    const rawDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@",
      "+x",
      "diff --git a/dist/bundle.js b/dist/bundle.js",
      "@@",
      "+y",
    ].join("\n");
    const filteredConfig: AppConfig = {
      ...config,
      review: { ...config.review, excludePaths: ["dist/**"] },
    };
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "rev-parse") return { stdout: sha } as any;
      if (args?.[0] === "diff") return { stdout: rawDiff } as any;
      return { stdout: "" } as any;
    });
    const result = await runReview(pushJob, { env, config: filteredConfig, logger });
    expect(result.diff).toContain("src/a.ts");
    expect(result.diff).not.toContain("dist/bundle.js");
    result.cleanup?.();
  });
});
