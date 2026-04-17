import PQueue from "p-queue";
import type { Logger } from "../logger.ts";
import type { ReviewJob } from "../types.ts";

export interface JobQueueDeps {
  logger: Logger;
  handle: (job: ReviewJob) => Promise<void>;
  concurrency?: number;
}

/**
 * レビュー処理を 1 件ずつ (デフォルト concurrency=1) さばく薄いラッパ。
 * handle 内の例外はログに落として飲み込み、後続ジョブが止まらないようにする。
 */
export class JobQueue {
  private q: PQueue;
  constructor(private deps: JobQueueDeps) {
    this.q = new PQueue({ concurrency: deps.concurrency ?? 1 });
  }

  enqueue(job: ReviewJob): void {
    const { logger, handle } = this.deps;
    this.q.add(async () => {
      const start = Date.now();
      try {
        await handle(job);
        logger.info(
          { ms: Date.now() - start, repo: job.repo, kind: job.kind, number: job.number },
          "job done",
        );
      } catch (err) {
        logger.error({ err: (err as Error).message, repo: job.repo, kind: job.kind }, "job failed");
      }
    });
  }

  async drain(timeoutMs?: number): Promise<void> {
    if (timeoutMs === undefined) {
      await this.q.onIdle();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const result = await Promise.race([this.q.onIdle().then(() => "idle" as const), timeout]);
      if (result === "timeout") {
        this.deps.logger.warn(
          { pending: this.q.pending, size: this.q.size },
          "drain timed out",
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
