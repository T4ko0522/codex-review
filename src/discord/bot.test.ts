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
import { assertTextChannel, publishReview, sendChunks } from "./publish.ts";

vi.mock("../review/codex.ts", () => ({
  runCodex: vi.fn(),
}));

vi.mock("./publish.ts", () => ({
  assertTextChannel: vi.fn(),
  publishReview: vi.fn(async () => ({ id: "thread-1" })),
  sendChunks: vi.fn(async () => {}),
}));

/**
 * テスト中に bot.client を差し替えるための fake Client ファクトリ。
 * once / on で登録されたリスナーを記録しておき、テストから発火できるようにする。
 */
interface FakeClient {
  onceHandlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  onHandlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  channels: { fetch: ReturnType<typeof vi.fn> };
  emit: (event: string, ...args: unknown[]) => Promise<void>;
}

function makeFakeClient(fetched: unknown = { type: 0 }): FakeClient {
  const onceHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const onHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const once = vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    const list = onceHandlers.get(event) ?? [];
    list.push(handler);
    onceHandlers.set(event, list);
  });
  const on = vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    const list = onHandlers.get(event) ?? [];
    list.push(handler);
    onHandlers.set(event, list);
  });
  const login = vi.fn(async () => "ok");
  const destroy = vi.fn(async () => {});
  const channels = { fetch: vi.fn(async () => fetched) };
  const emit = async (event: string, ...args: unknown[]) => {
    for (const h of onceHandlers.get(event) ?? []) await h(...args);
    onceHandlers.delete(event);
    for (const h of onHandlers.get(event) ?? []) await h(...args);
  };
  return { onceHandlers, onHandlers, once, on, login, destroy, channels, emit };
}

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
  SHUTDOWN_TIMEOUT_MS: 30_000,
  WORKSPACES_DIR: "",
  DATA_DIR: "/tmp/data",
  LOG_LEVEL: "info",
  CONFIG_FILE: "/tmp/config.yml",
};

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
  vi.mocked(assertTextChannel).mockReset();
  vi.mocked(assertTextChannel).mockImplementation(() => {});
  vi.mocked(publishReview).mockReset();
  vi.mocked(publishReview).mockImplementation(async () => ({ id: "thread-1" }) as any);
  vi.mocked(sendChunks).mockReset();
  vi.mocked(sendChunks).mockImplementation(async () => {});
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

  it("throws when publish is called before the channel is set", async () => {
    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: {
        insertThread: vi.fn(),
        addMessage: vi.fn(),
        getThread: vi.fn(),
        listMessages: vi.fn(() => []),
        listRecentMessages: vi.fn(() => []),
      } as any,
      threadContext: new Map(),
    });
    await expect(bot.publish(job, "body")).rejects.toThrow("discord bot not ready");
  });

  it("persists the thread record and first review message on publish", async () => {
    const insertThread = vi.fn();
    const addMessage = vi.fn();
    const threadContext = new Map();
    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: {
        insertThread,
        addMessage,
        getThread: vi.fn(),
        listMessages: vi.fn(() => []),
        listRecentMessages: vi.fn(() => []),
      } as any,
      threadContext,
    });
    (bot as any).channel = {} as any;

    await bot.publish(job, "review body");

    expect(insertThread).toHaveBeenCalledTimes(1);
    const threadArg = insertThread.mock.calls[0]![0];
    expect(threadArg.threadId).toBe("thread-1");
    expect(threadArg.repo).toBe("acme/app");
    expect(threadArg.kind).toBe("issues");
    expect(threadArg.number).toBe(7);
    expect(threadArg.job).toBe(job);

    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage.mock.calls[0]![0]).toMatchObject({
      threadId: "thread-1",
      role: "review",
      content: "review body",
    });
  });

  it("starts: logs in, fetches channel, runs clientReady, and registers messageCreate when enabled", async () => {
    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: {
        insertThread: vi.fn(),
        addMessage: vi.fn(),
        getThread: vi.fn(),
        listMessages: vi.fn(() => []),
        listRecentMessages: vi.fn(() => []),
      } as any,
      threadContext: new Map(),
    });
    const fakeClient = makeFakeClient({ type: 0, id: "ch-1" });
    (bot as any).client = fakeClient;

    await bot.start();

    expect(fakeClient.once).toHaveBeenCalledWith("clientReady", expect.any(Function));
    expect(fakeClient.on).toHaveBeenCalledWith("messageCreate", expect.any(Function));
    expect(fakeClient.login).toHaveBeenCalledWith(envBase.DISCORD_BOT_TOKEN);
    expect(fakeClient.channels.fetch).toHaveBeenCalledWith(envBase.DISCORD_CHANNEL_ID);
    expect(vi.mocked(assertTextChannel)).toHaveBeenCalledTimes(1);
    expect((bot as any).channel).toEqual({ type: 0, id: "ch-1" });

    // clientReady ハンドラを発火 (ロガー呼び出しで落ちないことを確認)
    await fakeClient.emit("clientReady", { user: { tag: "bot#0001" } });
  });

  it("start skips messageCreate registration when enableThreadChat is false", async () => {
    const disabledConfig: AppConfig = {
      ...config,
      discord: { ...config.discord, enableThreadChat: false },
    };
    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config: disabledConfig,
      logger,
      store: {
        insertThread: vi.fn(),
        addMessage: vi.fn(),
        getThread: vi.fn(),
        listMessages: vi.fn(() => []),
        listRecentMessages: vi.fn(() => []),
      } as any,
      threadContext: new Map(),
    });
    const fakeClient = makeFakeClient();
    (bot as any).client = fakeClient;

    await bot.start();
    expect(fakeClient.on).not.toHaveBeenCalled();
  });

  it("messageCreate handler catches handleMessage errors", async () => {
    const errorLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger: errorLogger as any,
      store: {
        insertThread: vi.fn(),
        addMessage: vi.fn(),
        getThread: vi.fn(),
        listMessages: vi.fn(() => []),
        listRecentMessages: vi.fn(() => []),
      } as any,
      threadContext: new Map(),
    });
    const fakeClient = makeFakeClient();
    (bot as any).client = fakeClient;

    // handleMessage 内で throw するように、msg.channel.isThread() が true を返し
    // かつ threadContext / store も無い状態で、msg.author に触れた瞬間 throw させる。
    // ここでは私有メソッドを直接置き換えて失敗させる。
    (bot as any).handleMessage = vi.fn(async () => {
      throw new Error("boom");
    });

    await bot.start();
    // on("messageCreate") に登録されたハンドラを発火
    await fakeClient.emit("messageCreate", { unused: true });
    expect(errorLogger.error).toHaveBeenCalled();
    const call = errorLogger.error.mock.calls[0]![0];
    expect(call.err).toBe("boom");
  });

  it("stop delegates to client.destroy", async () => {
    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: {
        insertThread: vi.fn(),
        addMessage: vi.fn(),
        getThread: vi.fn(),
        listMessages: vi.fn(() => []),
        listRecentMessages: vi.fn(() => []),
      } as any,
      threadContext: new Map(),
    });
    const fakeClient = makeFakeClient();
    (bot as any).client = fakeClient;
    await bot.stop();
    expect(fakeClient.destroy).toHaveBeenCalledTimes(1);
  });

  it("handleMessage ignores bot authors and non-thread channels", async () => {
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
      threadContext: new Map(),
    });
    // Bot 発言
    await (bot as any).handleMessage({
      author: { bot: true, tag: "bot" },
      channel: { isThread: () => true },
      content: "ignored",
    });
    expect(store.addMessage).not.toHaveBeenCalled();

    // スレッド以外
    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: { isThread: () => false },
      content: "ignored",
    });
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it("handleMessage returns when thread is unknown to the store", async () => {
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(() => null),
      listMessages: vi.fn(() => []),
      listRecentMessages: vi.fn(() => []),
    };
    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: store as any,
      threadContext: new Map(),
    });
    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: { id: "unknown", isThread: () => true },
      content: "hello",
    });
    expect(store.addMessage).not.toHaveBeenCalled();
    expect(vi.mocked(runCodex)).not.toHaveBeenCalled();
  });

  it("handleMessage ignores empty content", async () => {
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(
        (): ThreadRecord => ({
          threadId: "t",
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
      threadContext: new Map(),
    });
    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: {
        id: "t",
        isThread: () => true,
        sendTyping: vi.fn(async () => {}),
      },
      content: "   ",
    });
    expect(store.addMessage).not.toHaveBeenCalled();
    expect(vi.mocked(runCodex)).not.toHaveBeenCalled();
  });

  it("handleMessage replies with a warning when codex fails", async () => {
    vi.mocked(runCodex).mockRejectedValueOnce(new Error("codex down"));
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(),
      listMessages: vi.fn(() => []),
      listRecentMessages: vi.fn(() => []),
    };
    const threadContext = new Map();
    const existingWorkspace = mkdtempSync(join(workspacesDir, "ctx-"));
    threadContext.set("thread-err", {
      job,
      workspacePath: existingWorkspace,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: store as any,
      threadContext,
    });

    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: {
        id: "thread-err",
        isThread: () => true,
        sendTyping: vi.fn(async () => {}),
      },
      content: "please help",
    });

    // 失敗時でも会話履歴にユーザー入力とアシスタント応答が保存される
    const roles = store.addMessage.mock.calls.map((c: any) => c[0].role);
    expect(roles).toEqual(["user", "assistant"]);
    const assistantContent = store.addMessage.mock.calls[1]![0].content;
    expect(assistantContent).toContain(":warning:");
    // sendChunks が warning を投稿している
    expect(vi.mocked(sendChunks)).toHaveBeenCalledTimes(1);
    const sendChunksCall = vi.mocked(sendChunks).mock.calls[0]!;
    expect(sendChunksCall[1]).toContain(":warning:");
  });

  it("handleMessage uses PR record when store has a pull_request thread", async () => {
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(
        (): ThreadRecord => ({
          threadId: "pr-1",
          repo: "acme/app",
          sha: "abc1234",
          kind: "pull_request",
          number: 42,
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
      threadContext: new Map(),
    });

    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: {
        id: "pr-1",
        isThread: () => true,
        sendTyping: vi.fn(async () => {}),
      },
      content: "more details please",
    });

    // codex が呼ばれ、sendChunks に成功応答が流れる
    expect(vi.mocked(runCodex)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendChunks)).toHaveBeenCalledTimes(1);
    const roles = store.addMessage.mock.calls.map((c: any) => c[0].role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("handleMessage swallows sendTyping errors", async () => {
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(
        (): ThreadRecord => ({
          threadId: "typing-err",
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
      threadContext: new Map(),
    });

    // sendTyping が reject しても .catch() で握りつぶされる
    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: {
        id: "typing-err",
        isThread: () => true,
        sendTyping: vi.fn(() => Promise.reject(new Error("typing failed"))),
      },
      content: "hello",
    });

    // 例外は握りつぶされ、codex は通常通り呼ばれる
    expect(vi.mocked(runCodex)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendChunks)).toHaveBeenCalledTimes(1);
  });

  it("recreateJobFromRecord falls back to empty sha for push records with no sha", async () => {
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(
        (): ThreadRecord => ({
          threadId: "push-nosha",
          repo: "acme/app",
          sha: undefined,
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
      threadContext: new Map(),
    });

    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: {
        id: "push-nosha",
        isThread: () => true,
        sendTyping: vi.fn(async () => {}),
      },
      content: "ping",
    });

    // push kind + sha 無しでも handleMessage が完走し、codex が呼ばれる
    expect(vi.mocked(runCodex)).toHaveBeenCalledTimes(1);
  });

  it("handleMessage rebuilds a ReviewJob for Issue records when store job is missing", async () => {
    const store = {
      insertThread: vi.fn(),
      addMessage: vi.fn(),
      getThread: vi.fn(
        (): ThreadRecord => ({
          threadId: "issue-1",
          repo: "acme/app",
          sha: undefined,
          kind: "issues",
          number: 9,
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
      threadContext: new Map(),
    });

    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: {
        id: "issue-1",
        isThread: () => true,
        sendTyping: vi.fn(async () => {}),
      },
      content: "ping",
    });

    expect(vi.mocked(runCodex)).toHaveBeenCalledTimes(1);
    // 再構築されたプロンプトは runCodex に渡される
    const promptArg = vi.mocked(runCodex).mock.calls[0]![0].prompt;
    expect(promptArg).toContain("acme/app");
  });

  it("handleMessage updates lastActivityAt on follow-up when context exists", async () => {
    const insertThread = vi.fn();
    const addMessage = vi.fn();
    const store = {
      insertThread,
      addMessage,
      getThread: vi.fn(),
      listMessages: vi.fn(() => []),
      listRecentMessages: vi.fn(() => []),
    };
    const threadContext = new Map();
    const existingWorkspace = mkdtempSync(join(workspacesDir, "ctx-"));
    threadContext.set("active", {
      job,
      workspacePath: existingWorkspace,
      createdAt: 1,
      lastActivityAt: 1,
    });

    const bot = new DiscordBot({
      env: { ...envBase, WORKSPACES_DIR: workspacesDir },
      config,
      logger,
      store: store as any,
      threadContext,
    });

    const before = threadContext.get("active")!.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    await (bot as any).handleMessage({
      author: { bot: false, tag: "alice" },
      channel: {
        id: "active",
        isThread: () => true,
        sendTyping: vi.fn(async () => {}),
      },
      content: "update",
    });
    const after = threadContext.get("active")!.lastActivityAt;
    expect(after).toBeGreaterThan(before);
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
