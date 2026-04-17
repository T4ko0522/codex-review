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

  async drain(): Promise<void> {
    await this.q.onIdle();
  }
}
