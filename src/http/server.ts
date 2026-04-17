import Fastify from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.ts";
import { branchAllowed, repoAllowed } from "../config.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../logger.ts";
import { buildDedupKey } from "../review/dedup.ts";
import type { EventKind, IncomingWebhook, ReviewJob } from "../types.ts";
import { buildJobFromPayload } from "../github/events.ts";
import { verifySignature } from "./verify.ts";

const IncomingSchema = z.object({
  event: z.enum(["push", "pull_request", "issues"]),
  repository: z.string(),
  sender: z.string().optional().default(""),
  deliveredAt: z.string().optional(),
  payload: z.record(z.any()),
});

// raw body をリクエストボディに添える際の衝突しないキー。
// 文字列キーだとクライアント側ペイロードとぶつかり得るため Symbol を使う。
const RAW_BODY = Symbol("rawBody");
type WithRaw = { [RAW_BODY]?: Buffer };

export interface StartServerDeps {
  env: Env;
  config: AppConfig;
  logger: Logger;
  enqueue: (job: ReviewJob) => void;
  /**
   * 重複レビュー防止: 同一キーで再送された場合は false を返してスキップさせる。
   * 未指定なら dedup を行わない。
   */
  tryRegisterReview?: (key: string) => boolean;
}

export async function startServer({
  env,
  config,
  logger,
  enqueue,
  tryRegisterReview,
}: StartServerDeps) {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024, // 10MB
  });

  // raw body を保持して HMAC 検証に使う
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    try {
      const buf = body as Buffer;
      const json = JSON.parse(buf.toString("utf8"));
      (json as WithRaw)[RAW_BODY] = buf;
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/webhook", async (req, reply) => {
    const signature = req.headers["x-codex-review-signature"];
    const sig = Array.isArray(signature) ? signature[0] : signature;
    const body = req.body as (IncomingWebhook & WithRaw) | undefined;
    const raw = body?.[RAW_BODY];
    if (!raw) {
      return reply.code(400).send({ ok: false, error: "empty body" });
    }
    if (!verifySignature(env.WEBHOOK_SECRET, raw, sig)) {
      logger.warn({ sig }, "signature verification failed");
      return reply.code(401).send({ ok: false, error: "invalid signature" });
    }

    const parsed = IncomingSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "payload schema error");
      return reply.code(400).send({ ok: false, error: "invalid payload" });
    }
    const data = parsed.data;

    if (!isEventEnabled(config, data.event)) {
      logger.info({ event: data.event }, "event disabled, skip");
      return reply.code(202).send({ ok: true, skipped: "event-disabled" });
    }
    if (!repoAllowed(config.filters.repositories, data.repository)) {
      logger.info({ repo: data.repository }, "repo filtered, skip");
      return reply.code(202).send({ ok: true, skipped: "repo-filtered" });
    }

    const job = buildJobFromPayload(data);
    if (!job) {
      logger.info({ event: data.event }, "payload ignored");
      return reply.code(202).send({ ok: true, skipped: "payload-ignored" });
    }

    if (config.filters.skipBotSenders && /\[bot\]$/i.test(job.sender)) {
      logger.info({ sender: job.sender }, "bot sender, skip");
      return reply.code(202).send({ ok: true, skipped: "bot-sender" });
    }
    if (job.kind === "push" && !branchAllowed(config.filters.branches, job.ref)) {
      logger.info({ ref: job.ref }, "branch filtered, skip");
      return reply.code(202).send({ ok: true, skipped: "branch-filtered" });
    }
    if (job.kind === "pull_request" && config.filters.skipDraftPullRequests && job.isDraft) {
      logger.info({ pr: job.number }, "draft PR, skip");
      return reply.code(202).send({ ok: true, skipped: "draft-pr" });
    }

    if (tryRegisterReview) {
      const dedupKey = buildDedupKey(job);
      if (dedupKey && !tryRegisterReview(dedupKey)) {
        logger.info(
          { kind: job.kind, repo: job.repo, number: job.number, dedupKey },
          "duplicate review, skip",
        );
        return reply.code(202).send({ ok: true, skipped: "duplicate" });
      }
    }

    enqueue(job);
    logger.info(
      { kind: job.kind, repo: job.repo, ref: job.ref, number: job.number },
      "job enqueued",
    );
    return reply.code(202).send({ ok: true, queued: true });
  });

  await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
  logger.info({ host: env.HTTP_HOST, port: env.HTTP_PORT }, "http server listening");
  return app;
}

function isEventEnabled(config: AppConfig, event: EventKind): boolean {
  return config.events[event] === true;
}
