import { describe, expect, it, vi } from "vite-plus/test";
import { ChannelType } from "discord.js";
import type { TextChannel, ThreadChannel } from "discord.js";
import type { AppConfig } from "../config.ts";
import type { ReviewJob } from "../types.ts";
import { assertTextChannel, chunkMarkdown, publishReview, sendChunks } from "./publish.ts";

const config: AppConfig = {
  events: { push: true, pull_request: true, issues: true },
  filters: { repositories: [], branches: [], skipDraftPullRequests: true, skipBotSenders: true },
  review: { maxDiffChars: 200_000, cloneDepth: 50, includeExtensions: [], excludePaths: [] },
  github: { prReviewComment: true, pushIssueOnSevere: true },
  discord: { chunkSize: 1900, threadAutoArchiveMinutes: 1440, enableThreadChat: true },
  workspace: { ttlMinutes: 1440 },
};

interface FakeThread {
  id: string;
  send: ReturnType<typeof vi.fn>;
}

function makeFakeChannel(threadId = "thread-1") {
  const thread: FakeThread = {
    id: threadId,
    send: vi.fn(async () => ({})),
  };
  const startThread = vi.fn(async (_opts: { name: string; autoArchiveDuration: number }) => thread);
  const parent = { startThread };
  const send = vi.fn(async (_content: string) => parent);
  const channel = { send } as unknown as TextChannel;
  return { channel, send, startThread, thread };
}

describe("chunkMarkdown", () => {
  it("returns input unchanged when within limit", () => {
    const text = "hello world";
    expect(chunkMarkdown(text, 100)).toEqual(["hello world"]);
  });

  it("splits long text on newline boundaries", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(`line ${i} `.repeat(5));
    const full = lines.join("\n");
    const chunks = chunkMarkdown(full, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it("closes and reopens code fences across chunks", () => {
    const body = Array.from({ length: 40 }, (_, i) => `console.log(${i});`).join("\n");
    const md = `prefix\n\`\`\`ts\n${body}\n\`\`\`\nsuffix`;
    const chunks = chunkMarkdown(md, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // すべてのチャンク内でフェンスの数が偶数 (開閉が揃っている)
    for (const c of chunks) {
      const fenceCount = (c.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
    // 連結すればセマンティクスが保たれる (先頭以外はフェンスで始まるかチェック不要、閉じ具合のみ)
    const joined = chunks.join("\n");
    expect(joined).toContain("prefix");
    expect(joined).toContain("suffix");
  });

  it("handles empty string", () => {
    expect(chunkMarkdown("", 100)).toEqual([""]);
  });

  it("never exceeds the specified size even with code fences", () => {
    const body = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(60)}`).join("\n");
    const md = `\`\`\`ts\n${body}\n\`\`\``;
    const limit = 2000;
    const chunks = chunkMarkdown(md, limit);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit);
    }
  });

  it("handles text with no newlines", () => {
    const text = "a".repeat(500);
    const chunks = chunkMarkdown(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it("handles multiple code fence pairs", () => {
    const md = "```ts\ncode1\n```\ntext\n```js\ncode2\n```";
    const chunks = chunkMarkdown(md, 50);
    for (const c of chunks) {
      const fenceCount = (c.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("does not treat inline ``` mentions as fence openings", () => {
    // 行中の ``` 言及 (例: 「```diff は不要」) は fence として扱わない
    const padding = "word ".repeat(80);
    const md = `${padding}書式は \`\`\`ts のように使います。${padding}\n${padding}\n末尾。`;
    const chunks = chunkMarkdown(md, 200);
    // どのチャンクも fence を挿入されない (インライン言及は本物のフェンスではない)
    for (const c of chunks) {
      expect(c.startsWith("```")).toBe(false);
    }
  });
});

describe("assertTextChannel", () => {
  it("accepts a guild text channel", () => {
    expect(() => assertTextChannel({ type: ChannelType.GuildText })).not.toThrow();
  });

  it("rejects null", () => {
    expect(() => assertTextChannel(null)).toThrow(
      "DISCORD_CHANNEL_ID must point to a guild text channel",
    );
  });

  it("rejects DM channel type", () => {
    expect(() => assertTextChannel({ type: ChannelType.DM })).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => assertTextChannel(undefined)).toThrow();
  });
});

describe("publishReview", () => {
  it("posts a PR header, creates a thread, and sends chunks", async () => {
    const { channel, send, startThread, thread } = makeFakeChannel("pr-thread");
    const job: ReviewJob = {
      kind: "pull_request",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      sha: "abcdef1234567890",
      ref: "refs/heads/feature/login",
      title: "Add login flow",
      htmlUrl: "https://github.com/acme/app/pull/42",
      sender: "alice",
      number: 42,
    };

    const result = await publishReview(channel, config, job, "short review body");

    expect(result).toBe(thread);
    expect(send).toHaveBeenCalledTimes(1);
    const header = send.mock.calls[0]![0] as string;
    expect(header).toContain("**[PR]**");
    expect(header).toContain("`acme/app`");
    expect(header).toContain("#42");
    expect(header).toContain("`feature/login`");
    expect(header).toContain("`abcdef1`");
    expect(header).toContain("by `alice`");
    expect(header).toContain("Add login flow");
    expect(header).toContain("https://github.com/acme/app/pull/42");

    expect(startThread).toHaveBeenCalledTimes(1);
    const threadOpts = startThread.mock.calls[0]![0] as {
      name: string;
      autoArchiveDuration: number;
    };
    expect(threadOpts.name).toBe("acme/app - PR #42");
    expect(threadOpts.autoArchiveDuration).toBe(config.discord.threadAutoArchiveMinutes);

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(thread.send.mock.calls[0]![0]).toBe("short review body");
  });

  it("uses PUSH badge and formats ref/sha for push events", async () => {
    const { channel, send, startThread } = makeFakeChannel();
    const job: ReviewJob = {
      kind: "push",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      sha: "0123456789abcdef0123456789abcdef01234567",
      ref: "refs/heads/main",
      title: "add more tests",
      htmlUrl: "https://github.com/acme/app/commit/0123456",
      sender: "bob",
    };
    await publishReview(channel, config, job, "body");
    const header = send.mock.calls[0]![0] as string;
    expect(header.startsWith("**[PUSH]**")).toBe(true);
    expect(header).toContain("`main`");
    expect(header).toContain("`0123456`");
    expect(header).not.toContain("#");
    const name = (startThread.mock.calls[0]![0] as { name: string }).name;
    expect(name).toBe("acme/app - push main 0123456");
  });

  it("uses ISSUE badge and omits ref/sha when absent", async () => {
    const { channel, send, startThread } = makeFakeChannel();
    const job: ReviewJob = {
      kind: "issues",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      title: "Crash on startup",
      htmlUrl: "https://github.com/acme/app/issues/7",
      sender: "carol",
      number: 7,
    };
    await publishReview(channel, config, job, "body");
    const header = send.mock.calls[0]![0] as string;
    expect(header).toContain("**[ISSUE]**");
    expect(header).toContain(" #7");
    // ref も sha も無いので、バッククォート囲みの ref / sha 部分が挟まらない
    expect(header).not.toMatch(/` @ `/);
    expect(header).toContain("Crash on startup");

    const name = (startThread.mock.calls[0]![0] as { name: string }).name;
    expect(name).toBe("acme/app - Issue #7");
  });

  it("truncates very long titles to 100 chars with ellipsis", async () => {
    const { channel, send } = makeFakeChannel();
    const longTitle = "A".repeat(200);
    const job: ReviewJob = {
      kind: "pull_request",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      title: longTitle,
      htmlUrl: "https://github.com/acme/app/pull/1",
      sender: "eve",
      number: 1,
    };
    await publishReview(channel, config, job, "body");
    const header = send.mock.calls[0]![0] as string;
    // 元の改行区切りでタイトル行を取り出す
    const lines = header.split("\n");
    const titleLine = lines[1]!;
    expect(titleLine.endsWith("...")).toBe(true);
    expect(titleLine.length).toBe(100);
  });

  it("clamps thread names to 100 characters", async () => {
    const { channel, startThread } = makeFakeChannel();
    const longRepo = `${"o".repeat(60)}/${"n".repeat(60)}`;
    const job: ReviewJob = {
      kind: "pull_request",
      repo: longRepo,
      repoUrl: `https://github.com/${longRepo}`,
      title: "t",
      htmlUrl: `https://github.com/${longRepo}/pull/99`,
      sender: "x",
      number: 99,
    };
    await publishReview(channel, config, job, "body");
    const name = (startThread.mock.calls[0]![0] as { name: string }).name;
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("sends multiple chunks when the markdown exceeds chunkSize", async () => {
    const { channel, thread } = makeFakeChannel();
    const job: ReviewJob = {
      kind: "pull_request",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      title: "big",
      htmlUrl: "https://github.com/acme/app/pull/1",
      sender: "x",
      number: 1,
    };
    // chunkSize を小さくして分割が発生する状況を作る
    const smallChunkConfig: AppConfig = {
      ...config,
      discord: { ...config.discord, chunkSize: 100 },
    };
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
    await publishReview(channel, smallChunkConfig, job, lines);
    expect(thread.send.mock.calls.length).toBeGreaterThan(1);
  });

  it("builds a thread name for push events with no ref/sha", async () => {
    const { channel, startThread } = makeFakeChannel();
    const job: ReviewJob = {
      kind: "push",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      // ref / sha を意図的に省略 (型上は optional)
      title: "t",
      htmlUrl: "https://github.com/acme/app",
      sender: "x",
    };
    await publishReview(channel, config, job, "body");
    const name = (startThread.mock.calls[0]![0] as { name: string }).name;
    // ref / sha が空文字フォールバックになる → "push  " で余分な空白が残るが trim で整う
    expect(name.startsWith("acme/app - push")).toBe(true);
  });

  it("omits the number segment when job.number is undefined on push events", async () => {
    const { channel, send } = makeFakeChannel();
    const job: ReviewJob = {
      kind: "push",
      repo: "acme/app",
      repoUrl: "https://github.com/acme/app",
      ref: "refs/heads/main",
      sha: "abcdef0000000000000000000000000000000000",
      title: "t",
      htmlUrl: "https://github.com/acme/app/commit/abcdef0",
      sender: "x",
    };
    await publishReview(channel, config, job, "body");
    const header = send.mock.calls[0]![0] as string;
    // "#" が PR/Issue 番号として含まれない
    expect(header).not.toMatch(/`acme\/app` #/);
  });
});

describe("sendChunks", () => {
  it("sends the text as a single chunk when within the limit", async () => {
    const thread = { send: vi.fn(async () => ({})) } as unknown as ThreadChannel;
    await sendChunks(thread, "hello", 1900);
    expect((thread.send as any).mock.calls.length).toBe(1);
    expect((thread.send as any).mock.calls[0][0]).toBe("hello");
  });

  it("splits long input across multiple sends", async () => {
    const thread = { send: vi.fn(async () => ({})) } as unknown as ThreadChannel;
    const long = Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n");
    await sendChunks(thread, long, 100);
    expect((thread.send as any).mock.calls.length).toBeGreaterThan(1);
  });

  it("awaits send calls in order", async () => {
    const order: number[] = [];
    const thread = {
      send: vi.fn(async (_content: string) => {
        order.push(order.length);
        return {};
      }),
    } as unknown as ThreadChannel;
    const long = Array.from({ length: 20 }, (_, i) => `row-${i}`).join("\n");
    await sendChunks(thread, long, 50);
    // 送信が直列化され、順序が保たれる
    const count = (thread.send as any).mock.calls.length;
    expect(order).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});
