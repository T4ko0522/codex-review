import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Store } from "./db.ts";

let store: Store;
let dir: string;

/**
 * Store API を経由せず、sqlite の threads.job_json 列に生の文字列を書き込む。
 * safeParseJob の JSON.parse 失敗 / zod validate 失敗パスを直接叩くのに使う。
 */
function writeRawJobJson(storeDir: string, threadId: string, rawJson: string): void {
  const db = new Database(join(storeDir, "codex-review.sqlite"));
  db.pragma("foreign_keys = ON");
  db.prepare("UPDATE threads SET job_json = ? WHERE thread_id = ?").run(rawJson, threadId);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-review-test-"));
  store = new Store(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Store", () => {
  describe("threads", () => {
    it("inserts and retrieves a thread", () => {
      store.insertThread({
        threadId: "t1",
        repo: "acme/app",
        sha: "abc123",
        kind: "push",
        number: undefined,
        createdAt: 1000,
      });
      const t = store.getThread("t1");
      expect(t).not.toBeNull();
      expect(t!.repo).toBe("acme/app");
      expect(t!.sha).toBe("abc123");
      expect(t!.kind).toBe("push");
    });

    it("returns null for nonexistent thread", () => {
      expect(store.getThread("nonexistent")).toBeNull();
    });

    it("upserts on duplicate thread_id", () => {
      store.insertThread({
        threadId: "t1",
        repo: "acme/app",
        sha: "aaa",
        kind: "push",
        createdAt: 1,
      });
      store.insertThread({
        threadId: "t1",
        repo: "acme/app",
        sha: "bbb",
        kind: "push",
        createdAt: 2,
      });
      const t = store.getThread("t1");
      expect(t!.sha).toBe("bbb");
    });

    it("handles optional fields (sha, number)", () => {
      store.insertThread({
        threadId: "t2",
        repo: "acme/app",
        kind: "issues",
        number: 42,
        createdAt: 1,
      });
      const t = store.getThread("t2");
      expect(t!.sha).toBeNull();
      expect(t!.number).toBe(42);
    });

    it("persists and restores the full ReviewJob via job field", () => {
      const job = {
        kind: "pull_request" as const,
        repo: "acme/app",
        repoUrl: "https://github.com/acme/app",
        sha: "abc",
        baseSha: "def",
        headRepoUrl: "https://github.com/forker/app",
        title: "PR title",
        htmlUrl: "https://github.com/acme/app/pull/7",
        sender: "alice",
        number: 7,
        action: "opened",
        body: "PR body",
      };
      store.insertThread({
        threadId: "t3",
        repo: job.repo,
        sha: job.sha,
        kind: job.kind,
        number: job.number,
        createdAt: 1,
        job,
      });
      const t = store.getThread("t3");
      expect(t!.job).toEqual(job);
    });

    it("returns job=undefined when no job was persisted", () => {
      store.insertThread({ threadId: "t4", repo: "a/b", kind: "push", createdAt: 1 });
      const t = store.getThread("t4");
      expect(t!.job).toBeUndefined();
    });

    it("returns job=undefined when job_json is syntactically broken", () => {
      store.insertThread({ threadId: "t5", repo: "a/b", kind: "push", createdAt: 1 });
      store.close();
      writeRawJobJson(dir, "t5", "{not-json");
      store = new Store(dir);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t = store.getThread("t5");
      expect(t!.job).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("parse failed"));
      warn.mockRestore();
    });

    it("returns job=undefined when required fields are missing", () => {
      store.insertThread({ threadId: "t6", repo: "a/b", kind: "push", createdAt: 1 });
      store.close();
      // title / htmlUrl / sender などの必須フィールドを欠いた JSON を書き込む
      writeRawJobJson(
        dir,
        "t6",
        JSON.stringify({ kind: "push", repo: "a/b", repoUrl: "https://github.com/a/b" }),
      );
      store = new Store(dir);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t = store.getThread("t6");
      expect(t!.job).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
      warn.mockRestore();
    });

    it("returns job=undefined when kind is not a valid enum value", () => {
      store.insertThread({ threadId: "t7", repo: "a/b", kind: "push", createdAt: 1 });
      store.close();
      writeRawJobJson(
        dir,
        "t7",
        JSON.stringify({
          kind: "foo",
          repo: "a/b",
          repoUrl: "https://github.com/a/b",
          title: "x",
          htmlUrl: "https://github.com/a/b",
          sender: "alice",
        }),
      );
      store = new Store(dir);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const t = store.getThread("t7");
      expect(t!.job).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("validation failed"));
      warn.mockRestore();
    });
  });

  describe("messages", () => {
    it("adds and lists messages in order", () => {
      store.insertThread({ threadId: "t1", repo: "acme/app", kind: "push", createdAt: 1 });
      store.addMessage({ threadId: "t1", role: "review", content: "first", createdAt: 100 });
      store.addMessage({ threadId: "t1", role: "user", content: "second", createdAt: 200 });
      store.addMessage({ threadId: "t1", role: "assistant", content: "third", createdAt: 300 });

      const msgs = store.listMessages("t1");
      expect(msgs).toHaveLength(3);
      expect(msgs[0]!.role).toBe("review");
      expect(msgs[1]!.role).toBe("user");
      expect(msgs[2]!.role).toBe("assistant");
    });

    it("returns empty array for thread with no messages", () => {
      expect(store.listMessages("nonexistent")).toEqual([]);
    });

    it("isolates messages by thread", () => {
      store.insertThread({ threadId: "t1", repo: "a/b", kind: "push", createdAt: 1 });
      store.insertThread({ threadId: "t2", repo: "a/b", kind: "push", createdAt: 1 });
      store.addMessage({ threadId: "t1", role: "review", content: "for t1", createdAt: 1 });
      store.addMessage({ threadId: "t2", role: "review", content: "for t2", createdAt: 1 });

      expect(store.listMessages("t1")).toHaveLength(1);
      expect(store.listMessages("t1")[0]!.content).toBe("for t1");
    });

    it("preserves messages when insertThread is called twice on the same id", () => {
      // FK 有効 + INSERT OR REPLACE だと ON DELETE CASCADE で messages が消える。
      // UPSERT で保持されることを担保する。
      store.insertThread({ threadId: "t1", repo: "a/b", kind: "push", createdAt: 1 });
      store.addMessage({ threadId: "t1", role: "review", content: "keep me", createdAt: 1 });
      store.insertThread({ threadId: "t1", repo: "a/b", sha: "new", kind: "push", createdAt: 2 });

      expect(store.listMessages("t1")).toHaveLength(1);
      expect(store.listMessages("t1")[0]!.content).toBe("keep me");
      expect(store.getThread("t1")!.sha).toBe("new");
    });
  });

  describe("review_history (dedup)", () => {
    it("registers a fresh key and reports duplicate on second call", () => {
      expect(store.tryRegisterReview("push:acme/app:sha1")).toBe(true);
      expect(store.tryRegisterReview("push:acme/app:sha1")).toBe(false);
      expect(store.hasReview("push:acme/app:sha1")).toBe(true);
    });

    it("distinguishes unrelated keys", () => {
      expect(store.tryRegisterReview("a")).toBe(true);
      expect(store.tryRegisterReview("b")).toBe(true);
      expect(store.hasReview("a")).toBe(true);
      expect(store.hasReview("b")).toBe(true);
      expect(store.hasReview("c")).toBe(false);
    });

    it("unregister allows re-registration (retry after failure)", () => {
      expect(store.tryRegisterReview("k")).toBe(true);
      expect(store.tryRegisterReview("k")).toBe(false);
      store.unregisterReview("k");
      expect(store.hasReview("k")).toBe(false);
      expect(store.tryRegisterReview("k")).toBe(true);
    });
  });
});
