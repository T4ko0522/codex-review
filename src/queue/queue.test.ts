import { describe, expect, it } from "vite-plus/test";
import { JobQueue } from "./queue.ts";
import pino from "pino";
import type { ReviewJob } from "../types.ts";

const logger = pino({ level: "silent" });

const makeJob = (repo = "acme/app"): ReviewJob => ({
  kind: "push",
  repo,
  repoUrl: `https://github.com/${repo}`,
  sha: "abc123",
  title: "test",
  htmlUrl: "https://example.com",
  sender: "alice",
});

describe("JobQueue", () => {
  it("processes jobs sequentially", async () => {
    const order: number[] = [];
    const queue = new JobQueue({
      logger,
      concurrency: 1,
      handle: async () => {
        order.push(order.length);
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    await queue.drain();
    expect(order).toEqual([0, 1, 2]);
  });

  it("continues processing after a handler error", async () => {
    let processed = 0;
    const queue = new JobQueue({
      logger,
      handle: async (_job) => {
        processed++;
        if (processed === 1) throw new Error("test error");
      },
    });
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    await queue.drain();
    expect(processed).toBe(2);
  });

  it("drain resolves immediately when queue is empty", async () => {
    const queue = new JobQueue({ logger, handle: async () => {} });
    await queue.drain(); // should not hang
  });

  it("drain with timeout returns before handler finishes when exceeded", async () => {
    const queue = new JobQueue({
      logger,
      handle: async () => {
        await new Promise((r) => setTimeout(r, 2000));
      },
    });
    queue.enqueue(makeJob());
    const start = Date.now();
    await queue.drain(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);
  });

  it("drain without timeout waits until all jobs complete", async () => {
    let completed = 0;
    const queue = new JobQueue({
      logger,
      handle: async () => {
        await new Promise((r) => setTimeout(r, 50));
        completed++;
      },
    });
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    await queue.drain();
    expect(completed).toBe(2);
  });
});
