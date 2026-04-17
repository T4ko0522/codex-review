import { mkdirSync, rmSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { loadEnv } from "./env.ts";
import { createLogger } from "./logger.ts";
import { DiscordBot } from "./discord/bot.ts";
import { createGitHubClient } from "./github/client.ts";
import { createPushIssue, postPrReview } from "./github/feedback.ts";
import { startServer } from "./http/server.ts";
import { JobQueue } from "./queue/queue.ts";
import { runReview } from "./review/runner.ts";
import { Store } from "./store/db.ts";
import type { ReviewJob, ThreadContext } from "./types.ts";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const config = loadConfig(env.CONFIG_FILE);
  logger.info({ events: config.events, filters: config.filters }, "config loaded");

  mkdirSync(env.DATA_DIR, { recursive: true });
  mkdirSync(env.WORKSPACES_DIR, { recursive: true });

  const store = new Store(env.DATA_DIR);
  const threadContext = new Map<string, ThreadContext>();

  const octokit = createGitHubClient(env.GITHUB_TOKEN || undefined, logger);
  const bot = new DiscordBot({ env, config, logger, store, threadContext });
  await bot.start();

  const queue = new JobQueue({
    logger,
    concurrency: 1,
    handle: async (job) => {
      logger.info({ repo: job.repo, kind: job.kind, number: job.number }, "review starting");
      const result = await runReview(job, { env, config, logger });

      // GitHub フィードバック (best-effort、エラーは内部で吸収)
      if (octokit) {
        if (config.github.prReviewComment && job.kind === "pull_request") {
          await postPrReview(octokit, job, result.markdown, logger);
        }
        if (config.github.pushIssueOnSevere && job.kind === "push") {
          await createPushIssue(octokit, job, result.markdown, logger);
        }
      }

      // Discord 投稿 (既存フロー)
      let kept = false;
      try {
        const thread = await bot.publish(job, result.markdown, result.workspacePath);
        if (config.discord.enableThreadChat && result.workspacePath) {
          const now = Date.now();
          threadContext.set(thread.id, { job, workspacePath: result.workspacePath, createdAt: now, lastActivityAt: now });
          kept = true;
        }
      } finally {
        if (!kept) result.cleanup?.();
      }
    },
  });

  const server = await startServer({
    env,
    config,
    logger,
    enqueue: (job) => queue.enqueue(job),
  });

  // workspace TTL: threadAutoArchiveMinutes を TTL として再利用し、定期スイープで回収
  const ttlMs = config.discord.threadAutoArchiveMinutes * 60 * 1000;
  const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 分ごとにチェック
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, ctx] of threadContext) {
      if (now - ctx.lastActivityAt > ttlMs && ctx.workspacePath) {
        try {
          rmSync(ctx.workspacePath, { recursive: true, force: true });
          logger.info({ threadId: id, age: Math.round((now - ctx.createdAt) / 60_000) }, "stale workspace cleaned");
        } catch {
          /* best effort */
        }
        threadContext.delete(id);
      }
    }
  }, SWEEP_INTERVAL_MS);

  const cleanupAll = () => {
    for (const [, ctx] of threadContext) {
      if (ctx.workspacePath) {
        try {
          rmSync(ctx.workspacePath, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
    threadContext.clear();
  };

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    clearInterval(sweepTimer);
    await server.close();
    await queue.drain();
    await bot.stop();
    store.close();
    cleanupAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
