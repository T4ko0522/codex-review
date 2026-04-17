import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { MessageRecord, ThreadRecord } from "../types.ts";

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "codex-review.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
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
    `);
  }

  insertThread(t: ThreadRecord): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO threads (thread_id, repo, sha, kind, number, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(t.threadId, t.repo, t.sha ?? null, t.kind, t.number ?? null, t.createdAt);
  }

  getThread(threadId: string): ThreadRecord | null {
    const row = this.db
      .prepare(
        "SELECT thread_id as threadId, repo, sha, kind, number, created_at as createdAt FROM threads WHERE thread_id = ?",
      )
      .get(threadId) as ThreadRecord | undefined;
    return row ?? null;
  }

  addMessage(m: MessageRecord): void {
    this.db
      .prepare("INSERT INTO messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(m.threadId, m.role, m.content, m.createdAt);
  }

  listMessages(threadId: string): MessageRecord[] {
    return this.db
      .prepare(
        "SELECT thread_id as threadId, role, content, created_at as createdAt FROM messages WHERE thread_id = ? ORDER BY id ASC",
      )
      .all(threadId) as MessageRecord[];
  }

  close(): void {
    this.db.close();
  }
}
