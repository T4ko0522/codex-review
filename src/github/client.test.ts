import { describe, expect, it } from "vite-plus/test";
import { createGitHubClient } from "./client.ts";
import type { Env } from "../env.ts";
import pino from "pino";

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
  WORKSPACES_DIR: "/tmp/ws",
  DATA_DIR: "/tmp/data",
  LOG_LEVEL: "info",
  CONFIG_FILE: "/tmp/config.yml",
};

describe("createGitHubClient", () => {
  it("throws when private key file does not exist", async () => {
    await expect(createGitHubClient(baseEnv, logger)).rejects.toThrow();
  });
});
