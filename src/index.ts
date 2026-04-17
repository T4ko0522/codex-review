import { mkdirSync, rmSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { loadEnv } from "./env.ts";
import { createLogger } from "./logger.ts";
import { DiscordBot } from "./discord/bot.ts";
import { startServer } from "./http/server.ts";
import { JobQueue } from "./queue/queue.ts";
import { runReview } from "./review/runner.ts";
import { Store } from "./store/db.ts";
import type { ReviewJob } from "./types.ts";

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const config = loadConfig(env.CONFIG_FILE);
  logger.info({ events: config.events, filters: config.filters }, "config loaded");

  mkdirSync(env.DATA_DIR, { recursive: true });
  mkdirSync(env.WORKSPACES_DIR, { recursive: true });

  const store = new Store(env.DATA_DIR);
  const threadContext = new Map<string, { job: ReviewJob; workspacePath?: string }>();

  const bot = new DiscordBot({ env, config, logger, store, threadContext });
  await bot.start();

  const queue = new JobQueue({
    logger,
    concurrency: 1,
    handle: async (job) => {
      logger.info({ repo: job.repo, kind: job.kind, number: job.number }, "review starting");
      const result = await runReview(job, { env, config, logger });
      let kept = false;
      try {
        const thread = await bot.publish(job, result.markdown, result.workspacePath);
        if (config.discord.enableThreadChat && result.workspacePath) {
          threadContext.set(thread.id, { job, workspacePath: result.workspacePath });
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

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await server.close();
    await queue.drain();
    await bot.stop();
    store.close();
    // 残存 workspace を一括クリーンアップ
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
