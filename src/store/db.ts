import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { MessageRecord, ThreadRecord } from "../types.ts";

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
  }

  private prepareStatements() {
    this.stmtInsertThread = this.db.prepare(
      "INSERT OR REPLACE INTO threads (thread_id, repo, sha, kind, number, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtGetThread = this.db.prepare(
      "SELECT thread_id as threadId, repo, sha, kind, number, created_at as createdAt FROM threads WHERE thread_id = ?",
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
    );
  }

  getThread(threadId: string): ThreadRecord | null {
    return (this.stmtGetThread.get(threadId) as ThreadRecord | undefined) ?? null;
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
