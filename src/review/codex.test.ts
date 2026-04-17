import { describe, expect, it } from "vite-plus/test";
import { buildCodexEnv, stripAnsi } from "./codex.ts";

describe("buildCodexEnv", () => {
  it("forwards only the allowlisted runtime/auth variables", () => {
    const env = buildCodexEnv({
      Path: "/usr/bin",
      HOME: "/home/test",
      OPENAI_API_KEY: "sk-test",
      DISCORD_BOT_TOKEN: "discord-secret",
      GITHUB_TOKEN: "github-secret",
      WEBHOOK_SECRET: "webhook-secret",
    });

    expect(env.Path).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.NO_COLOR).toBe("1");
    expect(env.TERM).toBe("dumb");
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.WEBHOOK_SECRET).toBeUndefined();
  });
});

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes bold/underline codes", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[22m \x1b[4munderline\x1b[24m")).toBe("bold underline");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips complex SGR sequences", () => {
    expect(stripAnsi("\x1b[38;5;196mcolored\x1b[0m")).toBe("colored");
  });
});
