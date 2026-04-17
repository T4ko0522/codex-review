import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  events: z
    .object({
      push: z
        .object({
          enabled: z.boolean().default(true),
          // "all": 全 push を自動レビュー
          // "protected-only": Protected Branch への push だけ自動レビュー
          mode: z.enum(["all", "protected-only"]).default("protected-only"),
        })
        .default({ enabled: true, mode: "protected-only" }),
      pull_request: z
        .object({
          enabled: z.boolean().default(true),
          // ここに含まれる action だけ自動レビュー。他は mention 待ち
          autoReviewOn: z.array(z.string()).default(["opened"]),
        })
        .default({ enabled: true, autoReviewOn: ["opened"] }),
      issues: z
        .object({
          enabled: z.boolean().default(true),
          // 空 = 全アクションを mention 待ち
          autoReviewOn: z.array(z.string()).default([]),
        })
        .default({ enabled: true, autoReviewOn: [] }),
    })
    .default({
      push: { enabled: true, mode: "protected-only" },
      pull_request: { enabled: true, autoReviewOn: ["opened"] },
      issues: { enabled: true, autoReviewOn: [] },
    }),

  filters: z
    .object({
      repositories: z.array(z.string()).default([]),
      branches: z.array(z.string()).default([]),
      skipDraftPullRequests: z.boolean().default(true),
      skipBotSenders: z.boolean().default(true),
    })
    .default({
      repositories: [],
      branches: [],
      skipDraftPullRequests: true,
      skipBotSenders: true,
    }),

  review: z
    .object({
      maxDiffChars: z.number().int().positive().default(200_000),
      cloneDepth: z.number().int().default(50),
      includeExtensions: z.array(z.string()).default([]),
      excludePaths: z.array(z.string()).default([]),
    })
    .default({
      maxDiffChars: 200_000,
      cloneDepth: 50,
      includeExtensions: [],
      excludePaths: [],
    }),

  github: z
    .object({
      prReviewComment: z.boolean().default(true),
      // push 時にコミットコメント (POST /commits/:sha/comments) で投稿
      pushCommitComment: z.boolean().default(true),
      pushIssueOnSevere: z.boolean().default(true),
    })
    .default({
      prReviewComment: true,
      pushCommitComment: true,
      pushIssueOnSevere: true,
    }),

  mention: z
    .object({
      // PR/Issue コメント本文にこれらの文字列が含まれると mention 経由レビューを実行。
      // 空配列なら mention 機能そのものを無効化。
      triggers: z.array(z.string()).default(["@CodexRabbit[bot]"]),
    })
    .default({ triggers: ["@CodexRabbit[bot]"] }),

  discord: z
    .object({
      enabled: z.boolean().default(true),
      chunkSize: z.number().int().positive().max(2000).default(1900),
      threadAutoArchiveMinutes: z
        .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
        .default(1440),
      enableThreadChat: z.boolean().default(true),
    })
    .default({
      enabled: true,
      chunkSize: 1900,
      threadAutoArchiveMinutes: 1440,
      enableThreadChat: true,
    }),

  workspace: z
    .object({
      // スレッド対話終了後に残留する clone ディレクトリを回収するまでの猶予 (分)。
      // Discord のスレッド自動アーカイブ時間とは独立。
      ttlMinutes: z.number().int().positive().default(1440),
    })
    .default({ ttlMinutes: 1440 }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): AppConfig {
  let raw: unknown = {};
  try {
    const text = readFileSync(path, "utf8");
    raw = parseYaml(text) ?? {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw err;
    // ファイル未配置ならデフォルト値で動かす
    raw = {};
  }
  return ConfigSchema.parse(raw);
}

/**
 * リポジトリ一致判定。"owner/*" のワイルドカードをサポート。
 * allowList が空なら全て許可。
 */
export function repoAllowed(allowList: string[], fullName: string): boolean {
  if (allowList.length === 0) return true;
  return allowList.some((pattern) => {
    if (pattern === fullName) return true;
    if (pattern.endsWith("/*")) {
      const owner = pattern.slice(0, -2);
      return fullName.startsWith(`${owner}/`);
    }
    return false;
  });
}

/**
 * ref ("refs/heads/main" or "main") が許可ブランチに含まれるか。
 * allowList が空なら全て許可。
 */
export function branchAllowed(allowList: string[], ref: string | undefined): boolean {
  if (allowList.length === 0) return true;
  if (!ref) return false;
  const name = ref.replace(/^refs\/heads\//, "");
  return allowList.includes(name);
}
