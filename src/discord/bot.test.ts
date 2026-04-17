import { readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { ReviewJob, ThreadRecord } from "../types.ts";
import { DiscordBot } from "./bot.ts";
import { runCodex } from "../review/codex.ts";

vi.mock("../review/codex.ts", () => ({
  runCodex: vi.fn(),
}));

vi.mock("./publish.ts", () => ({
  assertTextChannel: vi.fn(),
  publishReview: vi.fn(async () => ({ id: "thread-1" })),
  sendChunks: vi.fn(async () => {}),
}));

const logger = pino({ level: "silent" });

const envBase: Env = {
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
  WORKSPACES_DIR: "",
  DATA_DIR: "/tmp/data",
  LOG_LEVEL: "info",
  CONFIG_FILE: "/tmp/config.yml",
};

const config: AppConfig = {
  events: { push: true, pull_request: true, issues: true },
  filters: { repositories: [], branches: [], skipDraftPullRequests: true, skipBotSenders: true },
  review: { maxDiffChars: 200_000, cloneDepth: 50, includeExtensions: [], excludePaths: [] },
  github: { prReviewComment: true, pushIssueOnSevere: true },
  discord: { chunkSize: 1900, threadAutoArchiveMinutes: 1440, enableThreadChat: true },
};

const job: ReviewJob = {
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

beforeEach(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), "codex-review-bot-"));
  vi.mocked(runCodex).mockReset();
  vi.mocked(runCodex).mockImplementation(async ({ cwd }) => `cwd=${cwd}`);
});

afterEach(() => {
  rmSync(workspacesDir, { recursive: true, force: true });
});

describe("DiscordBot", () => {
  it("stores thread context only when a workspace exists", async () => {
    const threadContext = new Map();
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(),
      listMessages: vi.fn(() => []),
      listRecentMessages: vi.fn(() => []),
    };

    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: store as any,
      threadContext,
    });
    (bot as any).channel = {} as any;

    await bot.publish(job, "review markdown");
    expect(threadContext.size).toBe(0);

    await bot.publish(job, "review markdown", join(workspacesDir, "issue-ctx"));
    expect(threadContext.size).toBe(1);
  });

  it("uses a temporary isolated workspace for follow-up when context was lost", async () => {
    const threadContext = new Map();
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(
        (): ThreadRecord => ({
          threadId: "thread-1",
          repo: "acme/app",
          sha: "abc1234",
          kind: "push",
          number: undefined,
          createdAt: Date.now(),
        }),
      ),
      listMessages: vi.fn(() => []),
      listRecentMessages: vi.fn(() => []),
    };

    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: store as any,
      threadContext,
    });

    const thread = {
      id: "thread-1",
      isThread: () => true,
      sendTyping: vi.fn(async () => {}),
    };

    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice#0001" },
      channel: thread,
      content: "もう少し詳しく",
    });

    const cwd = vi.mocked(runCodex).mock.calls[0]?.[0]?.cwd;
    expect(cwd).toBeDefined();
    const resolvedCwd = cwd!;
    expect(resolvedCwd).not.toBe(workspacesDir);
    expect(resolvedCwd.startsWith(workspacesDir)).toBe(true);
    expect(readdirSync(workspacesDir)).toEqual([]);
  });
});
