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

export function splitArgs(value: string): string[] {
  // シンプルなスペース区切り + ダブルクォート対応
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(value)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter(Boolean);
}
