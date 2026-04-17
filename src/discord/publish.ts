import type { TextChannel, ThreadChannel } from "discord.js";
import { ChannelType } from "discord.js";
import type { AppConfig } from "../config.ts";
import type { ReviewJob } from "../types.ts";

/**
 * 親メッセージを投稿 → スレッド作成 → レビュー本文をチャンク送信。
 * 返り値は作成したスレッド。
 */
export async function publishReview(
  channel: TextChannel,
  config: AppConfig,
  job: ReviewJob,
  markdown: string,
): Promise<ThreadChannel> {
  const header = buildHeader(job);
  const parent = await channel.send(header);
  const thread = await parent.startThread({
    name: buildThreadName(job),
    autoArchiveDuration: config.discord.threadAutoArchiveMinutes,
  });
  for (const chunk of chunkMarkdown(markdown, config.discord.chunkSize)) await thread.send(chunk);
  return thread;
}

/**
 * 既存スレッドへチャンク投稿。
 */
export async function sendChunks(
  thread: ThreadChannel,
  markdown: string,
  chunkSize: number,
): Promise<void> {
  for (const chunk of chunkMarkdown(markdown, chunkSize)) await thread.send(chunk);
}

function buildHeader(job: ReviewJob): string {
  const badge = job.kind === "push" ? "PUSH" : job.kind === "pull_request" ? "PR" : "ISSUE";
  const number = job.number ? ` #${job.number}` : "";
  const ref = job.ref ? ` \`${job.ref.replace(/^refs\/heads\//, "")}\`` : "";
  const sha = job.sha ? ` @ \`${job.sha.slice(0, 7)}\`` : "";
  const title = job.title.length > 100 ? `${job.title.slice(0, 97)}...` : job.title;
  return `**[${badge}]** \`${job.repo}\`${number}${ref}${sha} — by \`${job.sender}\`\n${title}\n${job.htmlUrl}`;
}

function buildThreadName(job: ReviewJob): string {
  const base =
    job.kind === "push"
      ? `push ${job.ref?.replace(/^refs\/heads\//, "") ?? ""} ${job.sha?.slice(0, 7) ?? ""}`
      : job.kind === "pull_request"
        ? `PR #${job.number}`
        : `Issue #${job.number}`;
  const name = `${job.repo} - ${base}`.trim();
  return name.length > 100 ? name.slice(0, 100) : name;
}

/**
 * Markdown を Discord の文字数制限で分割する。
 * コードブロックは境界で閉じ直して次チャンクの冒頭で再度開く。
 * フェンス再開閉分 (最大 ~20 文字) を予約して、最終サイズが size を超えないようにする。
 */
export function chunkMarkdown(input: string, size: number): string[] {
  if (input.length <= size) return [input];
  // フェンス挿入による膨張を防ぐ予約幅: "```lang\n" (先頭) + "\n```" (末尾)
  const FENCE_RESERVE = 20;
  const effectiveSize = size - FENCE_RESERVE;

  const out: string[] = [];
  let offset = 0;
  let openFence: string | null = null;
  while (offset < input.length) {
    const remaining = input.length - offset;
    const slice = input.slice(offset, offset + effectiveSize);
    // 改行優先で切る
    let cut = slice.length;
    if (remaining > effectiveSize) {
      const nl = slice.lastIndexOf("\n");
      if (nl > effectiveSize * 0.6) cut = nl;
    }
    let chunk = input.slice(offset, offset + cut);
    offset += cut;

    // コードフェンスの開閉を揃える (行頭の ``` のみ対象。インライン言及を誤検出しない)
    const fences = chunk.match(/^```[^\n]*/gm) ?? [];
    let localOpen: string | null = openFence;
    for (const f of fences) {
      if (localOpen) localOpen = null;
      else localOpen = f;
    }
    if (openFence && !chunk.startsWith("```")) chunk = `${openFence}\n${chunk}`;
    if (localOpen) {
      chunk += "\n```";
      openFence = localOpen;
    } else {
      openFence = null;
    }

    out.push(chunk.trim());
  }
  return out;
}

export function assertTextChannel(channel: unknown): asserts channel is TextChannel {
  const ch = channel as { type?: number } | null;
  if (!ch || ch.type !== ChannelType.GuildText)
    throw new Error("DISCORD_CHANNEL_ID must point to a guild text channel");
}
