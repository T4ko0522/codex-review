import { createHash } from "node:crypto";
import type { ReviewJob } from "../types.ts";

/**
 * レビュー重複判定用のキーを生成する。
 *
 * - mention 経由: コメント ID 単位でキー化。同じコメントの再送 (edited の二重発火など) のみ抑止
 * - push: コミット SHA が同じなら同一レビューとみなす
 * - pull_request: ヘッド SHA が同じなら同一レビューとみなす (synchronize で SHA が変わった場合は別キー)
 * - issues: タイトル + 本文のハッシュが同じなら同一レビューとみなす (edited で内容が変わった場合は別キー)
 *
 * 必要な識別子が欠けている場合は null を返し、呼び出し側で dedup を行わない。
 */
export function buildDedupKey(job: ReviewJob): string | null {
  if (job.triggeredBy === "mention") {
    if (!job.commentId || !job.number) return null;
    return `mention:${job.repo}:${job.kind}:${job.number}:${job.commentId}`;
  }
  if (job.kind === "push") {
    if (!job.sha) return null;
    return `push:${job.repo}:${job.sha}`;
  }
  if (job.kind === "pull_request") {
    if (!job.sha || !job.number) return null;
    return `pr:${job.repo}:${job.number}:${job.sha}`;
  }
  if (!job.number) return null;
  const hash = createHash("sha256")
    .update(`${job.title}\n\n${job.body ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `issue:${job.repo}:${job.number}:${hash}`;
}
