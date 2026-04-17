import { describe, expect, it } from "vite-plus/test";
import { ChannelType } from "discord.js";
import { assertTextChannel, chunkMarkdown } from "./publish.ts";

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
