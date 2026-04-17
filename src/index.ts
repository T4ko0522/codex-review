import { mkdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
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
import type { ThreadContext } from "./types.ts";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const config = loadConfig(env.CONFIG_FILE);
  logger.info({ events: config.events, filters: config.filters }, "config loaded");

  mkdirSync(env.DATA_DIR, { recursive: true });
  mkdirSync(env.WORKSPACES_DIR, { recursive: true });

  const store = new Store(env.DATA_DIR);
  const threadContext = new Map<string, ThreadContext>();

  const gh = await createGitHubClient(env, logger);
  const bot = new DiscordBot({ env, config, logger, store, threadContext });
  await bot.start();

  const queue = new JobQueue({
    logger,
    concurrency: 1,
    handle: async (job) => {
      logger.info({ repo: job.repo, kind: job.kind, number: job.number }, "review starting");
      const result = await runReview(job, { env, config, logger, githubToken: gh.token });

      // GitHub フィードバック (best-effort、エラーは内部で吸収)
      if (config.github.prReviewComment && job.kind === "pull_request") {
        await postPrReview(gh.octokit, job, result.markdown, logger);
      }
      if (config.github.pushIssueOnSevere && job.kind === "push") {
        await createPushIssue(gh.octokit, job, result.markdown, logger);
      }

      // Discord 投稿 (既存フロー)
      let kept = false;
      try {
        await bot.publish(job, result.markdown, result.workspacePath);
        kept = config.discord.enableThreadChat && Boolean(result.workspacePath);
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
      if (now - ctx.lastActivityAt <= ttlMs) continue;
      if (ctx.workspacePath) {
        rm(ctx.workspacePath, { recursive: true, force: true })
          .then(() =>
            logger.info(
              { threadId: id, age: Math.round((now - ctx.createdAt) / 60_000) },
              "stale workspace cleaned",
            ),
          )
          .catch(() => {
            /* best effort */
          });
      }
      threadContext.delete(id);
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
