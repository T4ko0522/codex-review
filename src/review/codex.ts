import { execa } from "execa";
import type { Logger } from "../logger.ts";

export interface CodexRunArgs {
  bin: string;
  extraArgs: string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  logger: Logger;
}

const FORWARDED_ENV_KEY_GROUPS = [
  ["PATH", "Path"],
  ["PATHEXT", "PathExt"],
  ["HOME"],
  ["USERPROFILE"],
  ["APPDATA"],
  ["LOCALAPPDATA"],
  ["XDG_CONFIG_HOME"],
  ["XDG_CACHE_HOME"],
  ["XDG_DATA_HOME"],
  ["TMP"],
  ["TEMP"],
  ["TMPDIR"],
  ["SYSTEMROOT", "SystemRoot"],
  ["WINDIR", "windir"],
  ["COMSPEC", "ComSpec"],
  ["ProgramData"],
  ["ProgramFiles"],
  ["ProgramFiles(x86)"],
  ["LANG"],
  ["LC_ALL"],
  ["SSL_CERT_FILE"],
  ["SSL_CERT_DIR"],
  ["OPENAI_API_KEY"],
  ["OPENAI_BASE_URL"],
  ["OPENAI_ORG_ID"],
  ["OPENAI_PROJECT"],
  ["CODEX_HOME"],
] as const;

/**
 * `codex exec` を非対話で実行し、stdout を Markdown としてそのまま返す。
 * プロンプトは引数で渡すと長すぎる場合があるため stdin で与える。
 */
export async function runCodex({
  bin,
  extraArgs,
  cwd,
  prompt,
  timeoutMs,
  logger,
}: CodexRunArgs): Promise<string> {
  // codex exec は追加引数を受ける。プロンプトは末尾の `-` で stdin 指定。
  // 参照: https://github.com/openai/codex
  const args = ["exec", "--skip-git-repo-check", "--cd", cwd, ...extraArgs, "-"];
  logger.debug({ bin, args, cwd }, "spawning codex");
  const proc = execa(bin, args, {
    input: prompt,
    timeout: timeoutMs,
    env: buildCodexEnv(process.env),
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const { stdout } = await proc;
    return stripAnsi(stdout).trim();
  } catch (err: any) {
    const stderr: string = err?.stderr ?? "";
    const stdout: string = err?.stdout ?? "";
    logger.error(
      { code: err?.exitCode, signal: err?.signal, stderr: stderr.slice(0, 2000) },
      "codex exec failed",
    );
    const snippet = [stdout, stderr].filter(Boolean).join("\n").slice(-1500);
    throw new Error(`codex exec failed (code=${err?.exitCode ?? "?"}): ${snippet || err?.message}`);
  }
}

export function buildCodexEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NO_COLOR: "1",
    TERM: "dumb",
  };

  for (const keys of FORWARDED_ENV_KEY_GROUPS) {
    const key = keys.find((candidate) => baseEnv[candidate] !== undefined);
    if (key && baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }

  return env;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}
