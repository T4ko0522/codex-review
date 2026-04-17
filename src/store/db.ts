import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ReviewJobSchema } from "../types.ts";
import type { MessageRecord, ReviewJob, ThreadRecord } from "../types.ts";

export class Store {
  private db: Database.Database;
  private stmtInsertThread!: Database.Statement;
  private stmtGetThread!: Database.Statement;
  private stmtAddMessage!: Database.Statement;
  private stmtListMessages!: Database.Statement;
  private stmtListRecentMessages!: Database.Statement;
  private stmtTryRegisterReview!: Database.Statement;
  private stmtUnregisterReview!: Database.Statement;
  private stmtHasReview!: Database.Statement;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "codex-review.sqlite"));
    this.db.pragma("journal_mode = WAL");
    // FK 制約を有効化。messages → threads の ON DELETE CASCADE を機能させる。
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.prepareStatements();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        sha TEXT,
        kind TEXT NOT NULL,
        number INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
      CREATE TABLE IF NOT EXISTS review_history (
        dedup_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `);
    // ReviewJob を JSON で永続化する列。既存 DB との互換のため追加式マイグレーション。
    const hasJobJson = (
      this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>
    ).some((c) => c.name === "job_json");
    if (!hasJobJson) {
      this.db.exec("ALTER TABLE threads ADD COLUMN job_json TEXT");
    }
  }

  private prepareStatements() {
    // INSERT OR REPLACE は FK 有効下で既存行を DELETE するため、
    // ON DELETE CASCADE で messages が全消失する。UPSERT で安全に更新する。
    this.stmtInsertThread = this.db.prepare(
      `INSERT INTO threads (thread_id, repo, sha, kind, number, created_at, job_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         repo = excluded.repo,
         sha = excluded.sha,
         kind = excluded.kind,
         number = excluded.number,
         created_at = excluded.created_at,
         job_json = excluded.job_json`,
    );
    this.stmtGetThread = this.db.prepare(
      "SELECT thread_id as threadId, repo, sha, kind, number, created_at as createdAt, job_json as jobJson FROM threads WHERE thread_id = ?",
    );
    this.stmtAddMessage = this.db.prepare(
      "INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)",
    );
    this.stmtListMessages = this.db.prepare(
      "SELECT thread_id as threadId, role, content, created_at as createdAt FROM messages WHERE thread_id = ? ORDER BY id ASC",
    );
    this.stmtListRecentMessages = this.db.prepare(
      "SELECT * FROM (SELECT thread_id as threadId, role, content, created_at as createdAt FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?) ORDER BY createdAt ASC",
    );
    this.stmtTryRegisterReview = this.db.prepare(
      "INSERT OR IGNORE INTO review_history (dedup_key, created_at) VALUES (?, ?)",
    );
    this.stmtUnregisterReview = this.db.prepare("DELETE FROM review_history WHERE dedup_key = ?");
    this.stmtHasReview = this.db.prepare("SELECT 1 FROM review_history WHERE dedup_key = ?");
  }

  insertThread(t: ThreadRecord): void {
    this.stmtInsertThread.run(
      t.threadId,
      t.repo,
      t.sha ?? null,
      t.kind,
      t.number ?? null,
      t.createdAt,
      t.job ? JSON.stringify(t.job) : null,
    );
  }

  getThread(threadId: string): ThreadRecord | null {
    const row = this.stmtGetThread.get(threadId) as
      | (Omit<ThreadRecord, "job"> & { jobJson: string | null })
      | undefined;
    if (!row) return null;
    const { jobJson, ...rest } = row;
    return { ...rest, job: jobJson ? (this.safeParseJob(jobJson, threadId) ?? undefined) : undefined };
  }

  private safeParseJob(json: string, threadId: string): ReviewJob | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      // 手動編集や旧バージョン由来の壊れた JSON は無視して reconstruction にフォールバック
      // eslint-disable-next-line no-console
      console.warn(`threads.job_json parse failed for ${threadId}`);
      return null;
    }
    const result = ReviewJobSchema.safeParse(parsed);
    if (!result.success) {
      // 必須フィールド欠落や kind 不正など、構造的に不正な JSON は破棄する
      // eslint-disable-next-line no-console
      console.warn(`threads.job_json validation failed for ${threadId}: ${result.error.message}`);
      return null;
    }
    return result.data;
  }

  addMessage(m: MessageRecord): void {
    this.stmtAddMessage.run(m.threadId, m.role, m.content, m.createdAt);
  }

  listMessages(threadId: string): MessageRecord[] {
    return this.stmtListMessages.all(threadId) as MessageRecord[];
  }

  listRecentMessages(threadId: string, limit: number): MessageRecord[] {
    return this.stmtListRecentMessages.all(threadId, limit) as MessageRecord[];
  }

  /**
   * 重複レビュー防止用のキーを原子的に登録する。
   * 新規登録できれば true、既に存在すれば (= 重複) false。
   */
  tryRegisterReview(dedupKey: string, now: number = Date.now()): boolean {
    const info = this.stmtTryRegisterReview.run(dedupKey, now);
    return info.changes > 0;
  }

  /** 登録済みキーを削除する (レビュー失敗時の再試行用)。 */
  unregisterReview(dedupKey: string): void {
    this.stmtUnregisterReview.run(dedupKey);
  }

  /** 既にそのキーで登録されているかを確認する。 */
  hasReview(dedupKey: string): boolean {
    return this.stmtHasReview.get(dedupKey) !== undefined;
  }

  close(): void {
    this.db.close();
  }
}
