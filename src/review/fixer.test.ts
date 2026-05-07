import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { execa } from "execa";
import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { ReviewJob } from "../types.ts";
import { runCodex } from "./codex.ts";
import { runFix } from "./fixer.ts";
import * as feedback from "../github/feedback.ts";
import * as ghClient from "../github/client.ts";

vi.mock("./codex.ts", () => ({
  runCodex: vi.fn(),
}));
vi.mock("execa", () => ({
  execa: vi.fn(),
}));
vi.mock("../github/feedback.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/feedback.ts")>();
  return {
    ...actual,
    createFixPullRequest: vi.fn(),
    postFixCommentOnIssue: vi.fn(),
    postFixNoChangeComment: vi.fn(),
  };
});
vi.mock("../github/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/client.ts")>();
  return {
    ...actual,
    getDefaultBranch: vi.fn(),
  };
});

const logger = pino({ level: "silent" });

const baseConfig: AppConfig = {
  events: {
    push: { enabled: true, mode: "all" },
    pull_request: { enabled: true, autoReviewOn: ["opened"] },
    issues: { enabled: true, autoReviewOn: [] },
  },
  filters: { repositories: [], branches: [], skipDraftPullRequests: true, skipBotSenders: true },
  review: { maxDiffChars: 200_000, cloneDepth: 50, includeExtensions: [], excludePaths: [] },
  github: {
    prReviewComment: true,
    pushCommitComment: true,
    pushIssueOnSevere: true,
    autoFixOnSevereIssue: true,
    autoFixIssueLabel: "codex-review",
    fixLabel: "codex-fix",
    fixBranchPrefix: "codex-fix",
  },
  mention: { triggers: ["@CodexRabbit[bot]"], fixTriggers: ["@CodexRabbit[bot] fix"] },
  discord: {
    enabled: true,
    chunkSize: 1900,
    threadAutoArchiveMinutes: 1440,
    enableThreadChat: true,
  },
  workspace: { ttlMinutes: 1440 },
};

const fixJob: ReviewJob = {
  kind: "fix",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  title: "Issue #7 NPE on startup [auto-fix]",
  htmlUrl: "https://github.com/acme/app/issues/7",
  sender: "ai-bot[bot]",
  number: 7,
  body: "クラッシュする",
  action: "opened",
  triggeredBy: "auto",
};

let workspacesDir: string;
let env: Env;
let octokit: any;

beforeEach(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), "codex-fix-test-"));
  env = {
    HTTP_HOST: "127.0.0.1",
    HTTP_PORT: 3000,
    WEBHOOK_SECRET: "test-secret-12345678",
    GITHUB_APP_ID: 123456,
    GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/key.pem",
    GITHUB_APP_INSTALLATION_ID: 789,
    DISCORD_BOT_TOKEN: "tok",
    DISCORD_CHANNEL_ID: "1",
    CODEX_BIN: "codex",
    CODEX_EXTRA_ARGS: "--debug",
    CODEX_FIX_ARGS: "--full-auto",
    CODEX_TIMEOUT_MS: 900_000,
    SHUTDOWN_TIMEOUT_MS: 30_000,
    GIT_AUTHOR_NAME: "ai-bot",
    GIT_AUTHOR_EMAIL: "ai-bot@example.com",
    WORKSPACES_DIR: workspacesDir,
    DATA_DIR: workspacesDir,
    LOG_LEVEL: "info",
    CONFIG_FILE: "/tmp/config.yml",
  };
  octokit = {} as any;
  vi.mocked(runCodex).mockReset();
  vi.mocked(execa).mockReset();
  vi.mocked(feedback.createFixPullRequest).mockReset();
  vi.mocked(feedback.postFixCommentOnIssue).mockReset();
  vi.mocked(feedback.postFixNoChangeComment).mockReset();
  vi.mocked(ghClient.getDefaultBranch).mockReset();

  // 既定: getDefaultBranch は "main" を返す
  vi.mocked(ghClient.getDefaultBranch).mockResolvedValue("main");
  // 既定: execa はすべて成功 (rev-parse 用に sha 風文字列を返す)
  vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
    if (args?.[0] === "status") return { stdout: " M src/foo.ts\n" } as any; // 変更あり
    if (args?.[0] === "rev-parse") return { stdout: "a".repeat(40) } as any;
    return { stdout: "" } as any;
  });
  // 既定: Codex は PR 本文のサマリを返す
  vi.mocked(runCodex).mockResolvedValue("## 概要\nNPE 修正\n\n## 変更点\n- foo");
  // 既定: PR 作成成功
  vi.mocked(feedback.createFixPullRequest).mockResolvedValue({
    number: 99,
    htmlUrl: "https://github.com/acme/app/pull/99",
  });
  vi.mocked(feedback.postFixCommentOnIssue).mockResolvedValue(undefined);
  vi.mocked(feedback.postFixNoChangeComment).mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(workspacesDir, { recursive: true, force: true });
});

describe("runFix - happy path", () => {
  it("clones, branches, runs codex, commits, pushes, creates PR, comments on issue", async () => {
    const result = await runFix(fixJob, {
      env,
      config: baseConfig,
      logger,
      octokit,
      githubToken: "ghs_token",
      now: () => 1700000000000,
    });

    expect(result.changed).toBe(true);
    expect(result.prNumber).toBe(99);
    expect(result.prUrl).toBe("https://github.com/acme/app/pull/99");
    expect(result.markdown).toContain("NPE 修正");

    // git 操作の順序確認
    const calls = vi.mocked(execa).mock.calls.map((c) => (c[1] as string[])?.[0]);
    expect(calls).toContain("clone");
    expect(calls).toContain("checkout"); // checkout -b
    expect(calls).toContain("status");
    expect(calls).toContain("add");
    expect(calls).toContain("commit");
    expect(calls).toContain("push");

    // checkout に正しいブランチが渡る
    const checkoutCall = vi
      .mocked(execa)
      .mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "checkout" && (c[1] as string[])[1] === "-b",
      )!;
    expect((checkoutCall[1] as string[])[2]).toBe("codex-fix/issue-7-1700000000000");

    // commit env に GIT_AUTHOR_*
    const commitCall = (vi.mocked(execa).mock.calls as any[]).find(
      (c: any) => c[1]?.[0] === "commit",
    )!;
    const commitOpts = commitCall[2] as any;
    expect(commitOpts.env.GIT_AUTHOR_NAME).toBe("ai-bot");
    expect(commitOpts.env.GIT_AUTHOR_EMAIL).toBe("ai-bot@example.com");

    // PR 作成のフィードバック関数が呼ばれる
    expect(feedback.createFixPullRequest).toHaveBeenCalledWith(
      octokit,
      fixJob,
      expect.objectContaining({
        branch: "codex-fix/issue-7-1700000000000",
        baseBranch: "main",
        label: "codex-fix",
      }),
    );
    expect(feedback.postFixCommentOnIssue).toHaveBeenCalledWith(
      octokit,
      fixJob,
      99,
      "https://github.com/acme/app/pull/99",
      logger,
    );
    expect(feedback.postFixNoChangeComment).not.toHaveBeenCalled();
  });

  it("uses CODEX_FIX_ARGS over CODEX_EXTRA_ARGS", async () => {
    await runFix(fixJob, {
      env,
      config: baseConfig,
      logger,
      octokit,
      githubToken: "tok",
      now: () => 1,
    });
    expect(vi.mocked(runCodex)).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: ["--full-auto"],
      }),
    );
  });

  it("falls back to CODEX_EXTRA_ARGS when CODEX_FIX_ARGS is empty", async () => {
    const env2: Env = { ...env, CODEX_FIX_ARGS: "" };
    await runFix(fixJob, {
      env: env2,
      config: baseConfig,
      logger,
      octokit,
      githubToken: "tok",
      now: () => 1,
    });
    expect(vi.mocked(runCodex)).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: ["--debug"],
      }),
    );
  });
});

describe("runFix - no changes", () => {
  it("posts a 'no changes' comment and skips push/PR", async () => {
    // status を空にして変更なし扱い
    vi.mocked(execa as any).mockImplementation(async (_bin: any, args: any) => {
      if (args?.[0] === "status") return { stdout: "" } as any;
      return { stdout: "" } as any;
    });

    const result = await runFix(fixJob, {
      env,
      config: baseConfig,
      logger,
      octokit,
      githubToken: "tok",
      now: () => 1,
    });

    expect(result.changed).toBe(false);
    expect(result.prNumber).toBeUndefined();
    expect(feedback.postFixNoChangeComment).toHaveBeenCalledWith(octokit, fixJob, logger);
    expect(feedback.createFixPullRequest).not.toHaveBeenCalled();
    expect(feedback.postFixCommentOnIssue).not.toHaveBeenCalled();

    // push は走らない
    const pushCall = vi.mocked(execa).mock.calls.find((c) => (c[1] as string[])?.[0] === "push");
    expect(pushCall).toBeUndefined();
  });
});

describe("runFix - error handling", () => {
  it("rejects when job.kind is not fix", async () => {
    const wrong: ReviewJob = { ...fixJob, kind: "issues" };
    await expect(
      runFix(wrong, { env, config: baseConfig, logger, octokit, githubToken: "tok" }),
    ).rejects.toThrow(/expects job.kind === 'fix'/);
  });

  it("rejects when job.number is missing", async () => {
    const wrong: ReviewJob = { ...fixJob, number: undefined };
    await expect(
      runFix(wrong, { env, config: baseConfig, logger, octokit, githubToken: "tok" }),
    ).rejects.toThrow(/job.number/);
  });

  it("rejects and cleans workspace when default branch is unknown", async () => {
    vi.mocked(ghClient.getDefaultBranch).mockResolvedValue(undefined);
    await expect(
      runFix(fixJob, {
        env,
        config: baseConfig,
        logger,
        octokit,
        githubToken: "tok",
        now: () => 1,
      }),
    ).rejects.toThrow(/default branch/);
    expect(readdirSync(workspacesDir)).toEqual([]);
  });

  it("cleans workspace when codex fails", async () => {
    vi.mocked(runCodex).mockRejectedValue(new Error("codex blew up"));
    await expect(
      runFix(fixJob, {
        env,
        config: baseConfig,
        logger,
        octokit,
        githubToken: "tok",
        now: () => 1,
      }),
    ).rejects.toThrow(/codex blew up/);
    expect(readdirSync(workspacesDir)).toEqual([]);
  });

  it("returns changed=true with no prNumber when PR creation fails (push already done)", async () => {
    vi.mocked(feedback.createFixPullRequest).mockResolvedValue(null);
    const result = await runFix(fixJob, {
      env,
      config: baseConfig,
      logger,
      octokit,
      githubToken: "tok",
      now: () => 1,
    });
    expect(result.changed).toBe(true);
    expect(result.prNumber).toBeUndefined();
    expect(feedback.postFixCommentOnIssue).not.toHaveBeenCalled();
    // workspace は cleanup されず result.cleanup で呼べる状態
    expect(typeof result.cleanup).toBe("function");
  });
});

describe("runFix - branch naming", () => {
  it("uses fixBranchPrefix from config", async () => {
    const cfg: AppConfig = {
      ...baseConfig,
      github: { ...baseConfig.github, fixBranchPrefix: "ai/fix" },
    };
    await runFix(fixJob, {
      env,
      config: cfg,
      logger,
      octokit,
      githubToken: "tok",
      now: () => 9999,
    });
    const checkoutCall = vi
      .mocked(execa)
      .mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "checkout" && (c[1] as string[])[1] === "-b",
      )!;
    expect((checkoutCall[1] as string[])[2]).toBe("ai/fix/issue-7-9999");
  });
});

describe("runFix - workspace lifecycle", () => {
  it("returns a cleanup() function on success path (idempotent rm)", async () => {
    // execa はすべてモック化されているため git clone が実体ディレクトリを作らない。
    // ここでは cleanup が呼び出し可能で、例外を出さないことだけを検証する。
    const result = await runFix(fixJob, {
      env,
      config: baseConfig,
      logger,
      octokit,
      githubToken: "tok",
      now: () => 1,
    });
    expect(typeof result.cleanup).toBe("function");
    expect(() => result.cleanup?.()).not.toThrow();
  });
});
