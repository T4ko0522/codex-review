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
  SHUTDOWN_TIMEOUT_MS: 30_000,
  WORKSPACES_DIR: "/tmp/ws",
  DATA_DIR: "/tmp/data",
  LOG_LEVEL: "error" as const,
  CONFIG_FILE: "/tmp/config.yml",
};

// テストでは mode:"all" と全 PR/issue action 許可でデフォルトフローを通りやすくする。
// protected-only や autoReviewOn の個別振る舞いは専用テストで検証する。
const baseConfig: AppConfig = {
  events: {
    push: { enabled: true, mode: "all" },
    pull_request: {
      enabled: true,
      autoReviewOn: ["opened", "synchronize", "reopened", "ready_for_review", "edited"],
    },
    issues: { enabled: true, autoReviewOn: ["opened", "edited", "reopened"] },
  },
  filters: { repositories: [], branches: [], skipDraftPullRequests: true, skipBotSenders: true },
  review: { maxDiffChars: 200_000, cloneDepth: 50, includeExtensions: [], excludePaths: [] },
  github: { prReviewComment: true, pushCommitComment: true, pushIssueOnSevere: true },
  mention: { triggers: ["@CodexRabbit[bot]"] },
  discord: { chunkSize: 1900, threadAutoArchiveMinutes: 1440, enableThreadChat: true },
  workspace: { ttlMinutes: 1440 },
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

  it("accepts valid push (mode=all) and enqueues job", async () => {
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
      config: {
        ...baseConfig,
        events: { ...baseConfig.events, push: { enabled: false, mode: "all" } },
      },
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

describe("HTTP server - protected-only push", () => {
  it("skips push to non-protected branch", async () => {
    await app.close();
    const getBranchProtection = vi.fn().mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const fakeOctokit = {
      rest: {
        repos: { getBranchProtection },
      },
    } as any;
    app = await startServer({
      env: baseEnv,
      config: {
        ...baseConfig,
        events: { ...baseConfig.events, push: { enabled: true, mode: "protected-only" } },
      },
      logger,
      octokit: fakeOctokit,
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
    expect(res.json().skipped).toBe("non-protected");
    expect(enqueued).toHaveLength(0);
    expect(getBranchProtection).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "app", branch: "main" }),
    );
  });

  it("enqueues push to protected branch", async () => {
    await app.close();
    const getBranchProtection = vi.fn().mockResolvedValue({ data: {} });
    const fakeOctokit = { rest: { repos: { getBranchProtection } } } as any;
    app = await startServer({
      env: baseEnv,
      config: {
        ...baseConfig,
        events: { ...baseConfig.events, push: { enabled: true, mode: "protected-only" } },
      },
      logger,
      octokit: fakeOctokit,
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
    expect(res.json()).toEqual({ ok: true, queued: true });
    expect(enqueued).toHaveLength(1);
  });

  it("skips when octokit is not provided under protected-only", async () => {
    await app.close();
    app = await startServer({
      env: baseEnv,
      config: {
        ...baseConfig,
        events: { ...baseConfig.events, push: { enabled: true, mode: "protected-only" } },
      },
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
    expect(res.json().skipped).toBe("non-protected");
  });
});

describe("HTTP server - PR autoReviewOn", () => {
  function makePrBody(action: string) {
    return JSON.stringify({
      event: "pull_request",
      repository: "acme/app",
      sender: "bob",
      payload: {
        action,
        pull_request: {
          number: 42,
          title: "x",
          body: "",
          draft: false,
          html_url: "https://github.com/acme/app/pull/42",
          user: { login: "bob" },
          head: { ref: "feature", sha: "hhh" },
          base: { ref: "main", sha: "bbb" },
        },
      },
    });
  }

  it("enqueues PR with action in autoReviewOn", async () => {
    await app.close();
    app = await startServer({
      env: baseEnv,
      config: {
        ...baseConfig,
        events: {
          ...baseConfig.events,
          pull_request: { enabled: true, autoReviewOn: ["opened"] },
        },
      },
      logger,
      enqueue: (job) => enqueued.push(job),
    });
    const body = makePrBody("opened");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.json()).toEqual({ ok: true, queued: true });
    expect(enqueued).toHaveLength(1);
  });

  it("skips PR with action not in autoReviewOn", async () => {
    await app.close();
    app = await startServer({
      env: baseEnv,
      config: {
        ...baseConfig,
        events: {
          ...baseConfig.events,
          pull_request: { enabled: true, autoReviewOn: ["opened"] },
        },
      },
      logger,
      enqueue: (job) => enqueued.push(job),
    });
    const body = makePrBody("synchronize");
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.json().skipped).toBe("pr-not-auto");
    expect(enqueued).toHaveLength(0);
  });
});

describe("HTTP server - mention via issue_comment", () => {
  function makeIssueCommentBody(opts: {
    body: string;
    isPr?: boolean;
    number?: number;
  }) {
    const number = opts.number ?? 42;
    const issue: Record<string, unknown> = {
      number,
      title: "X",
      body: "desc",
      html_url: opts.isPr
        ? `https://github.com/acme/app/pull/${number}`
        : `https://github.com/acme/app/issues/${number}`,
    };
    if (opts.isPr) issue.pull_request = { url: "https://api" };
    return JSON.stringify({
      event: "issue_comment",
      repository: "acme/app",
      sender: "carol",
      payload: {
        action: "created",
        comment: {
          id: 100,
          body: opts.body,
          html_url: "https://github.com/acme/app/x#issuecomment-100",
          user: { login: "carol" },
        },
        issue,
      },
    });
  }

  it("skips when no mention trigger matches", async () => {
    const body = makeIssueCommentBody({ body: "no trigger here", isPr: false });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.json().skipped).toBe("payload-ignored");
    expect(enqueued).toHaveLength(0);
  });

  it("enqueues issue mention job", async () => {
    const body = makeIssueCommentBody({ body: "@CodexRabbit[bot] please look", isPr: false });
    const res = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-codex-review-signature": sign(body),
      },
      body,
    });
    expect(res.json()).toEqual({ ok: true, queued: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe("issues");
    expect(enqueued[0]!.triggeredBy).toBe("mention");
  });

  it("enqueues PR mention job with sha filled via pulls.get", async () => {
    await app.close();
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        head: { sha: "headsha0", ref: "feature", repo: { full_name: "acme/app" } },
        base: { sha: "basesha0", ref: "main" },
        draft: false,
      },
    });
    const fakeOctokit = { rest: { pulls: { get: pullsGet } } } as any;
    app = await startServer({
      env: baseEnv,
      config: baseConfig,
      logger,
      octokit: fakeOctokit,
      enqueue: (job) => enqueued.push(job),
    });
    const body = makeIssueCommentBody({
      body: "hey @CodexRabbit[bot]",
      isPr: true,
      number: 42,
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
    expect(res.json()).toEqual({ ok: true, queued: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe("pull_request");
    expect(enqueued[0]!.triggeredBy).toBe("mention");
    expect(enqueued[0]!.sha).toBe("headsha0");
    expect(enqueued[0]!.baseSha).toBe("basesha0");
    expect(pullsGet).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "app", pull_number: 42 }),
    );
  });

  it("skips PR mention when pulls.get fails", async () => {
    await app.close();
    const pullsGet = vi.fn().mockRejectedValue(new Error("boom"));
    const fakeOctokit = { rest: { pulls: { get: pullsGet } } } as any;
    app = await startServer({
      env: baseEnv,
      config: baseConfig,
      logger,
      octokit: fakeOctokit,
      enqueue: (job) => enqueued.push(job),
    });
    const body = makeIssueCommentBody({
      body: "@CodexRabbit[bot]",
      isPr: true,
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
    expect(res.json().skipped).toBe("pr-fetch-failed");
    expect(enqueued).toHaveLength(0);
  });
});
