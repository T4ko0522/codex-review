import { z } from "zod";

const EnvSchema = z.object({
  HTTP_HOST: z.string().default("127.0.0.1"),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),

  WEBHOOK_SECRET: z.string().min(8, "WEBHOOK_SECRET must be at least 8 chars"),

  // GitHub App 認証 (必須)
  GITHUB_APP_ID: z.coerce.number().int().positive("GITHUB_APP_ID is required"),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1, "GITHUB_APP_PRIVATE_KEY_PATH is required"),
  GITHUB_APP_INSTALLATION_ID: z.coerce
    .number()
    .int()
    .positive("GITHUB_APP_INSTALLATION_ID is required"),

  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_CHANNEL_ID: z.string().min(1, "DISCORD_CHANNEL_ID is required"),

  CODEX_BIN: z.string().default("codex"),
  CODEX_EXTRA_ARGS: z.string().optional().default(""),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  WORKSPACES_DIR: z.string().default("/app/workspaces"),
  DATA_DIR: z.string().default("/app/data"),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  CONFIG_FILE: z.string().default("/app/config.yml"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return parsed.data;
}

/**
 * シェル風のトークン分割。空白区切り + シングル/ダブルクォート + バックスラッシュエスケープに対応。
 * - `--model gpt-4 --foo="bar baz"` → ["--model", "gpt-4", "--foo=bar baz"]
 * - `"hello \"world\""` → [`hello "world"`]
 * - クォート中の内容はそのまま (ネスト不可)
 * 完全な POSIX 再現ではないが、codex の extra args 程度の入力には十分。
 */
export function splitArgs(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < value.length) {
        const next = value[i + 1]!;
        // ダブルクォート内は \" と \\ のみエスケープとして解釈
        if (next === '"' || next === "\\") {
          cur += next;
          i++;
          continue;
        }
      }
      if (ch === '"') inDouble = false;
      else cur += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < value.length) {
      cur += value[i + 1];
      i++;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch!)) {
      if (hasToken) {
        out.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) out.push(cur);
  return out;
}
