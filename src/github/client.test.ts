import pino from "pino";
import { describe, expect, it, vi } from "vite-plus/test";
import { createGitHubClient } from "./client.ts";
import type { Env } from "../env.ts";

const logger = pino({ level: "silent" });

const baseEnv: Env = {
  HTTP_HOST: "127.0.0.1",
  HTTP_PORT: 3000,
  WEBHOOK_SECRET: "test-secret-12345",
  GITHUB_APP_ID: 123456,
  GITHUB_APP_PRIVATE_KEY_PATH: "/nonexistent/key.pem",
  GITHUB_APP_INSTALLATION_ID: 789,
  DISCORD_BOT_TOKEN: "test",
  DISCORD_CHANNEL_ID: "123",
  CODEX_BIN: "codex",
  CODEX_EXTRA_ARGS: "",
  CODEX_TIMEOUT_MS: 900_000,
  SHUTDOWN_TIMEOUT_MS: 30_000,
  WORKSPACES_DIR: "/tmp/ws",
  DATA_DIR: "/tmp/data",
  LOG_LEVEL: "info",
  CONFIG_FILE: "/tmp/config.yml",
};

// createAppAuth と Octokit を共に mock し、auth 呼び出し回数とトークン生成を制御する。
const authMock = vi.fn();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => "-----BEGIN DUMMY KEY-----"),
  };
});

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(function MockOctokit(this: { auth: typeof authMock }) {
    this.auth = authMock;
  }),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(),
}));

describe("createGitHubClient", () => {
  it("getToken が呼ばれる度に octokit.auth を実行して新鮮な token を返す", async () => {
    authMock.mockReset();
    let counter = 0;
    authMock.mockImplementation(async () => ({ token: `token-${++counter}` }));

    const client = await createGitHubClient(baseEnv, logger);

    // 起動時 sanity check で 1 回呼ばれる
    expect(authMock).toHaveBeenCalledTimes(1);

    const t1 = await client.getToken();
    const t2 = await client.getToken();
    const t3 = await client.getToken();

    expect(authMock).toHaveBeenCalledTimes(4); // 起動時 + 3 回
    expect(t1).toBe("token-2");
    expect(t2).toBe("token-3");
    expect(t3).toBe("token-4");

    // 毎回 installation token として取得していることを確認
    for (const call of authMock.mock.calls) {
      expect(call[0]).toEqual({ type: "installation" });
    }
  });
});
