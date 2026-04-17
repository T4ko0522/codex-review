import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { ReviewJob } from "../types.ts";
import { runReview } from "./runner.ts";
import { runCodex } from "./codex.ts";

vi.mock("./codex.ts", () => ({
  runCodex: vi.fn(),
}));

// execa を fail させて issue レビューの fallback (isolated workspace) を通す
vi.mock("execa", () => ({
  execa: vi.fn(async () => {
    throw new Error("execa disabled in tests");
  }),
}));

const logger = pino({ level: "silent" });

const config: AppConfig = {
  events: { push: true, pull_request: true, issues: true },
  filters: { repositories: [], branches: [], skipDraftPullRequests: true, skipBotSenders: true },
  review: { maxDiffChars: 200_000, cloneDepth: 50, includeExtensions: [], excludePaths: [] },
  github: { prReviewComment: true, pushIssueOnSevere: true },
  discord: { chunkSize: 1900, threadAutoArchiveMinutes: 1440, enableThreadChat: true },
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
    WORKSPACES_DIR: workspacesDir,
    DATA_DIR: workspacesDir,
    LOG_LEVEL: "info",
    CONFIG_FILE: "/tmp/config.yml",
  };
  vi.mocked(runCodex).mockReset();
  vi.mocked(runCodex).mockImplementation(async ({ cwd }) => `cwd=${cwd}`);
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
});
