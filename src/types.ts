import { z } from "zod";

/** HTTP で受け取る GitHub イベントの種類 */
export type EventKind = "push" | "pull_request" | "issues" | "issue_comment";

/** 内部ジョブとして扱う対象種別 (issue_comment は発火トリガにしかならないので含めない) */
export type JobKind = "push" | "pull_request" | "issues";

/** GitHub Actions から送られてくる HTTP ペイロード本体 */
export interface IncomingWebhook {
  event: EventKind;
  repository: string; // owner/name
  sender: string;
  payload: Record<string, any>; // GitHub event の raw payload
  deliveredAt?: string;
}

/**
 * キューへ積むレビュージョブの Zod schema。
 * DB 永続化された JSON を復元する際の validate に使う。
 * `ReviewJob` 型は本 schema から z.infer して再定義するため、二重管理にならない。
 */
export const ReviewJobSchema = z.object({
  kind: z.enum(["push", "pull_request", "issues"]),
  repo: z.string(),
  repoUrl: z.string(),
  /** push: head_commit.id / PR: pull_request.head.sha */
  sha: z.string().optional(),
  /** push: before / PR: pull_request.base.sha */
  baseSha: z.string().optional(),
  /** push: ref / PR: pull_request.head.ref */
  ref: z.string().optional(),
  baseRef: z.string().optional(),
  /** fork PR の場合、head 側リポジトリの clone URL */
  headRepoUrl: z.string().optional(),
  title: z.string(),
  htmlUrl: z.string(),
  sender: z.string(),
  /** PR 番号 or issue 番号 */
  number: z.number().optional(),
  /** PR/issue の本文 */
  body: z.string().optional(),
  /** PR の action (opened / synchronize / ...) or "mention" */
  action: z.string().optional(),
  /** push のコミット一覧などから作るサマリ文 */
  summary: z.string().optional(),
  isDraft: z.boolean().optional(),
  /** 自動発火 or mention 発火の区別 */
  triggeredBy: z.enum(["auto", "mention"]).optional(),
  /** mention 経由レビュー時の起因コメント ID */
  commentId: z.number().optional(),
  /** mention 経由レビュー時の起因コメント URL */
  commentUrl: z.string().optional(),
});

/** キューへ積むレビュージョブ */
export type ReviewJob = z.infer<typeof ReviewJobSchema>;

export interface ThreadRecord {
  threadId: string;
  repo: string;
  sha?: string;
  kind: JobKind;
  number?: number;
  createdAt: number;
  /**
   * 作成時点の ReviewJob を丸ごと保持する。
   * 再起動後の follow-up で action/htmlUrl/title/baseSha 等を復元するのに使う。
   * 既存行 (マイグレーション前) が読まれたときは undefined。
   */
  job?: ReviewJob;
}

export interface MessageRecord {
  threadId: string;
  role: "review" | "user" | "assistant";
  content: string;
  createdAt: number;
}

/** スレッドに紐付くレビューコンテキスト (workspace 保持用) */
export interface ThreadContext {
  job: ReviewJob;
  workspacePath?: string;
  createdAt: number;
  /** 最後にスレッド内で活動があった時刻 (TTL 判定に使用) */
  lastActivityAt: number;
}
