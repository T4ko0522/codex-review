import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildCodexEnv, runCodex, stripAnsi } from "./codex.ts";
import { execa } from "execa";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

const logger = pino({ level: "silent" });

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

describe("buildCodexEnv (edge cases)", () => {
  it("prefers the first candidate when multiple casings are present (Path wins over nothing)", () => {
    const env = buildCodexEnv({ PATH: "/a", Path: "/b" });
    // グループ先頭の "PATH" が優先される
    expect(env.PATH).toBe("/a");
    expect(env.Path).toBeUndefined();
  });

  it("falls back to alternate casing when the primary key is missing", () => {
    const env = buildCodexEnv({ Path: "/from-alt" });
    expect(env.Path).toBe("/from-alt");
  });

  it("forwards proxy-adjacent TLS variables when set", () => {
    const env = buildCodexEnv({
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl",
    });
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem");
    expect(env.SSL_CERT_DIR).toBe("/etc/ssl");
  });

  it("ignores keys whose value is undefined even if the key exists", () => {
    const env = buildCodexEnv({ HOME: undefined, USERPROFILE: "/home/x" });
    expect(env.HOME).toBeUndefined();
    expect(env.USERPROFILE).toBe("/home/x");
  });

  it("returns only NO_COLOR/TERM when baseEnv is empty", () => {
    const env = buildCodexEnv({});
    expect(env.NO_COLOR).toBe("1");
    expect(env.TERM).toBe("dumb");
    expect(Object.keys(env).sort()).toEqual(["NO_COLOR", "TERM"]);
  });
});

describe("runCodex", () => {
  beforeEach(() => {
    vi.mocked(execa).mockReset();
  });

  afterEach(() => {
    vi.mocked(execa).mockReset();
  });

  it("returns trimmed and ansi-stripped stdout on success", async () => {
    vi.mocked(execa).mockReturnValue(
      Promise.resolve({ stdout: "\x1b[32m  hello  \x1b[0m\n" }) as any,
    );
    const result = await runCodex({
      bin: "codex",
      extraArgs: [],
      cwd: "/tmp/ws",
      prompt: "p",
      timeoutMs: 1000,
      logger,
    });
    expect(result).toBe("hello");
  });

  it("passes the expected argv: exec / --skip-git-repo-check / --cd / extraArgs / -", async () => {
    vi.mocked(execa).mockReturnValue(Promise.resolve({ stdout: "ok" }) as any);
    await runCodex({
      bin: "mycodex",
      extraArgs: ["--model", "gpt-4o"],
      cwd: "/work/dir",
      prompt: "the-prompt",
      timeoutMs: 5000,
      logger,
    });
    const call = (vi.mocked(execa).mock.calls as any[])[0]!;
    const [bin, args, opts] = call as [string, string[], any];
    expect(bin).toBe("mycodex");
    expect(args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--cd",
      "/work/dir",
      "--model",
      "gpt-4o",
      "-",
    ]);
    expect(opts).toMatchObject({ input: "the-prompt", timeout: 5000 });
    // maxBuffer を明示的に渡す (stdout が巨大でも切れないよう 64MiB)
    expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
    // 環境変数は buildCodexEnv 経由で絞られる
    expect(opts.env.NO_COLOR).toBe("1");
    expect(opts.env.TERM).toBe("dumb");
  });

  it("throws with a helpful message including stderr snippet on failure", async () => {
    const err = new Error("process exited") as any;
    err.exitCode = 2;
    err.stderr = "boom: something went wrong";
    err.stdout = "partial";
    vi.mocked(execa).mockReturnValue(Promise.reject(err) as any);

    await expect(
      runCodex({
        bin: "codex",
        extraArgs: [],
        cwd: "/tmp",
        prompt: "p",
        timeoutMs: 1000,
        logger,
      }),
    ).rejects.toThrow(/codex exec failed \(code=2\).*boom: something went wrong/s);
  });

  it("falls back to err.message when stderr/stdout are empty", async () => {
    const err = new Error("spawn ENOENT") as any;
    err.exitCode = undefined;
    err.stderr = "";
    err.stdout = "";
    vi.mocked(execa).mockReturnValue(Promise.reject(err) as any);

    await expect(
      runCodex({
        bin: "nonexistent",
        extraArgs: [],
        cwd: "/tmp",
        prompt: "p",
        timeoutMs: 1000,
        logger,
      }),
    ).rejects.toThrow(/codex exec failed \(code=\?\).*spawn ENOENT/s);
  });

  it("handles errors without stderr/stdout properties (nullish coalescing fallback)", async () => {
    const err = new Error("raw error") as any;
    // stderr/stdout が undefined (プロパティ自体が存在しない)
    vi.mocked(execa).mockReturnValue(Promise.reject(err) as any);

    await expect(
      runCodex({
        bin: "codex",
        extraArgs: [],
        cwd: "/tmp",
        prompt: "p",
        timeoutMs: 1000,
        logger,
      }),
    ).rejects.toThrow(/codex exec failed \(code=\?\).*raw error/s);
  });

  it("truncates very long stderr output to trailing 1500 chars", async () => {
    const longErr = "S".repeat(5000) + "TAIL";
    const err = new Error("big") as any;
    err.exitCode = 1;
    err.stderr = longErr;
    err.stdout = "";
    vi.mocked(execa).mockReturnValue(Promise.reject(err) as any);

    const rejection = runCodex({
      bin: "codex",
      extraArgs: [],
      cwd: "/tmp",
      prompt: "p",
      timeoutMs: 1000,
      logger,
    });
    await expect(rejection).rejects.toThrow(/TAIL/);
    // 1500 chars 以下に切り詰められていれば、先頭の "S" 連鎖は一部しか残らない
    try {
      await rejection;
    } catch (e) {
      const msg = (e as Error).message;
      // prefix "codex exec failed (code=1): " + 末尾 1500 char
      expect(msg.length).toBeLessThan(1600);
    }
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
