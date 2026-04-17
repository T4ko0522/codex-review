import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { startServer } from "./server.ts";
import pino from "pino";
import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { ReviewJob } from "../types.ts";
import type { FastifyInstance } from "fastify";

const logger = pino({ level: "silent" });

const SECRET = "test-secret-12345678";

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

const baseEnv: Env = {
  HTTP_HOST: "127.0.0.1",
  HTTP_PORT: 0,
  WEBHOOK_SECRET: SECRET,
  GITHUB_APP_ID: 123456,
  GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/key.pem",
  GITHUB_APP_INSTALLATION_ID: 789,
  DISCORD_BOT_TOKEN: "test",
  DISCORD_CHANNEL_ID: "123",
  CODEX_BIN: "codex",
  CODEX_EXTRA_ARGS: "",
  CODEX_TIMEOUT_MS: 900_000,
  WORKSPACES_DIR: "/tmp/ws",
  DATA_DIR: "/tmp/data",
  LOG_LEVEL: "error" as const,
  CONFIG_FILE: "/tmp/config.yml",
};

const baseConfig: AppConfig = {
  events: { push: true, pull_request: true, issues: true },
  filters: { repositories: [], branches: [], skipDraftPullRequests: true, skipBotSenders: true },
  review: { maxDiffChars: 200_000, cloneDepth: 50, includeExtensions: [], excludePaths: [] },
  github: { prReviewComment: true, pushIssueOnSevere: true },
  discord: { chunkSize: 1900, threadAutoArchiveMinutes: 1440, enableThreadChat: true },
};

function makePayload(event = "push") {
  return JSON.stringify({
    event,
    repository: "acme/app",
    sender: "alice",
    deliveredAt: "2026-01-01T00:00:00Z",
    payload: {
      ref: "refs/heads/main",
      before: "0000000",
      after: "abc1234",
      head_commit: { id: "abc1234", message: "test" },
      commits: [{ id: "abc1234", message: "test" }],
      compare: "https://github.com/acme/app/compare/000...abc",
    },
  });
}

let app: FastifyInstance;
const enqueued: ReviewJob[] = [];

beforeEach(async () => {
  enqueued.length = 0;
  app = await startServer({
    env: baseEnv,
    config: baseConfig,
    logger,
    enqueue: (job) => enqueued.push(job),
  });
});

afterEach(async () => {
  await app.close();
});

describe("HTTP server", () => {
  it("GET /health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      body: "",
    });
    // Fastify の JSON パーサーがエラーを返す
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rejects invalid signature", async () => {
    const body = makePayload();
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": "sha256=bad",
      },
      body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts valid push and enqueues job", async () => {
    const body = makePayload("push");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, queued: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe("push");
  });

  it("skips disabled event", async () => {
    await app.close();
    app = await startServer({
      env: baseEnv,
      config: { ...baseConfig, events: { ...baseConfig.events, push: false } },
      logger,
      enqueue: (job) => enqueued.push(job),
    });
    const body = makePayload("push");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().skipped).toBe("event-disabled");
    expect(enqueued).toHaveLength(0);
  });

  it("skips filtered repository", async () => {
    await app.close();
    app = await startServer({
      env: baseEnv,
      config: { ...baseConfig, filters: { ...baseConfig.filters, repositories: ["other/repo"] } },
      logger,
      enqueue: (job) => enqueued.push(job),
    });
    const body = makePayload("push");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().skipped).toBe("repo-filtered");
  });

  it("skips bot sender", async () => {
    const body = JSON.stringify({
      event: "push",
      repository: "acme/app",
      sender: "dependabot[bot]",
      payload: {
        ref: "refs/heads/main",
        before: "000",
        after: "abc",
        head_commit: { id: "abc", message: "bump" },
        commits: [{ id: "abc", message: "bump" }],
        compare: "https://example.com",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().skipped).toBe("bot-sender");
  });

  it("rejects invalid payload schema", async () => {
    const body = JSON.stringify({ event: "unknown_event", repository: "x" });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("skips duplicate review when tryRegisterReview returns false", async () => {
    await app.close();
    const seen = new Set<string>();
    app = await startServer({
      env: baseEnv,
      config: baseConfig,
      logger,
      enqueue: (job) => enqueued.push(job),
      tryRegisterReview: (key) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });

    const body = makePayload("push");
    const first = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(first.json()).toEqual({ ok: true, queued: true });
    expect(enqueued).toHaveLength(1);

    const second = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().skipped).toBe("duplicate");
    expect(enqueued).toHaveLength(1);
  });
});
