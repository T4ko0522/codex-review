import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { Message, TextChannel, ThreadChannel } from "discord.js";
import type { AppConfig } from "../config.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../logger.ts";
import type { ReviewJob, ThreadContext } from "../types.ts";
import { splitArgs } from "../env.ts";
import { runCodex } from "../review/codex.ts";
import { buildFollowUpPrompt } from "../review/prompt.ts";
import { getFollowUpWorkspace } from "../review/workspace.ts";
import type { Store } from "../store/db.ts";
import { assertTextChannel, publishReview, sendChunks } from "./publish.ts";

/** Discord Bot に渡す環境変数 (DISCORD_* が確定済み) */
export type DiscordEnv = Env & { DISCORD_BOT_TOKEN: string; DISCORD_CHANNEL_ID: string };

export interface BotDeps {
  env: DiscordEnv;
  config: AppConfig;
  logger: Logger;
  store: Store;
  /** スレッド ID → 継続レビューに必要な情報 */
  threadContext: Map<string, ThreadContext>;
}

export class DiscordBot {
  readonly client: Client;
  private channel?: TextChannel;

  constructor(private deps: BotDeps) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start(): Promise<void> {
    const { env, logger, config } = this.deps;
    this.client.once("clientReady", (c) => {
      logger.info({ tag: c.user.tag }, "discord bot ready");
    });

    if (config.discord.enableThreadChat) {
      this.client.on("messageCreate", async (msg) => {
        try {
          await this.handleMessage(msg);
        } catch (err) {
          logger.error({ err: (err as Error).message }, "messageCreate handler failed");
        }
      });
    }

    await this.client.login(env.DISCORD_BOT_TOKEN);
    const ch = await this.client.channels.fetch(env.DISCORD_CHANNEL_ID);
    assertTextChannel(ch);
    this.channel = ch;
  }

  async publish(job: ReviewJob, markdown: string, workspacePath?: string): Promise<ThreadChannel> {
    if (!this.channel) throw new Error("discord bot not ready");
    const thread = await publishReview(this.channel, this.deps.config, job, markdown);
    this.deps.store.insertThread({
      threadId: thread.id,
      repo: job.repo,
      sha: job.sha,
      kind: job.kind,
      number: job.number,
      createdAt: Date.now(),
      job,
    });
    this.deps.store.addMessage({
      threadId: thread.id,
      role: "review",
      content: markdown,
      createdAt: Date.now(),
    });
    if (workspacePath) {
      const now = Date.now();
      this.deps.threadContext.set(thread.id, {
        job,
        workspacePath,
        createdAt: now,
        lastActivityAt: now,
      });
    }
    return thread;
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async handleMessage(msg: Message): Promise<void> {
    const { logger, env, config, store, threadContext } = this.deps;
    if (msg.author.bot) return;
    if (!msg.channel.isThread()) return;
    const thread = msg.channel;
    const ctx = threadContext.get(thread.id);
    const record =
      ctx ??
      (() => {
        const r = store.getThread(thread.id);
        if (!r) return null;
        // 永続化された ReviewJob があればそれを優先 (action/htmlUrl/title などを保持)
        const job = r.job ?? this.recreateJobFromRecord(r);
        return { job, workspacePath: undefined };
      })();
    if (!record) return; // このスレッドは管理対象外

    const content = msg.content?.trim();
    if (!content) return;

    logger.info({ threadId: thread.id, user: msg.author.tag }, "thread follow-up");
    await thread.sendTyping().catch(() => {});

    store.addMessage({ threadId: thread.id, role: "user", content, createdAt: Date.now() });

    // workspace TTL を延長
    if (ctx) ctx.lastActivityAt = Date.now();

    const history = store.listRecentMessages(thread.id, 20);
    const prompt = buildFollowUpPrompt(record.job, history, content);
    const workspace = getFollowUpWorkspace(env.WORKSPACES_DIR, record.workspacePath, logger);

    let reply: string;
    try {
      reply = await runCodex({
        bin: env.CODEX_BIN,
        extraArgs: splitArgs(env.CODEX_EXTRA_ARGS),
        cwd: workspace.path,
        prompt,
        timeoutMs: env.CODEX_TIMEOUT_MS,
        logger,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "codex follow-up failed");
      reply = `:warning: codex 実行に失敗しました。サーバーログを確認してください。`;
    } finally {
      workspace.cleanup();
    }

    store.addMessage({
      threadId: thread.id,
      role: "assistant",
      content: reply,
      createdAt: Date.now(),
    });
    await sendChunks(thread, reply, config.discord.chunkSize);
  }

  private recreateJobFromRecord(r: {
    repo: string;
    sha?: string;
    kind: "push" | "pull_request" | "issues";
    number?: number;
  }): ReviewJob {
    return {
      kind: r.kind,
      repo: r.repo,
      repoUrl: `https://github.com/${r.repo}`,
      sha: r.sha,
      title:
        r.kind === "pull_request"
          ? `PR #${r.number}`
          : r.kind === "issues"
            ? `Issue #${r.number}`
            : `push @ ${r.sha?.slice(0, 7) ?? ""}`,
      htmlUrl: r.number
        ? `https://github.com/${r.repo}/${r.kind === "issues" ? "issues" : "pull"}/${r.number}`
        : `https://github.com/${r.repo}`,
      sender: "unknown",
      number: r.number,
    };
  }
}
