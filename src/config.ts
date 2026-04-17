import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ConfigSchema = z.object({
  events: z
    .object({
      push: z.boolean().default(true),
      pull_request: z.boolean().default(true),
      issues: z.boolean().default(true),
    })
    .default({ push: true, pull_request: true, issues: true }),

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
      pushIssueOnSevere: z.boolean().default(true),
    })
    .default({
      prReviewComment: true,
      pushIssueOnSevere: true,
    }),

  discord: z
    .object({
      chunkSize: z.number().int().positive().max(2000).default(1900),
      threadAutoArchiveMinutes: z
        .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
        .default(1440),
      enableThreadChat: z.boolean().default(true),
    })
    .default({
      chunkSize: 1900,
      threadAutoArchiveMinutes: 1440,
      enableThreadChat: true,
    }),
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
