import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Env } from "../env.ts";
import type { Logger } from "../logger.ts";

export interface GitHubClient {
  octokit: Octokit;
  /**
   * git clone 用の Installation Token を取得する。
   *
   * Installation Token は約 1 時間で失効するため固定保持は避ける。
   * `@octokit/auth-app` は内部で token をキャッシュし、期限が近い場合のみ
   * 再取得するため、呼び出すたびに新鮮な token が返る。
   */
  getToken: () => Promise<string>;
}

/**
 * GitHub App の Installation Token で認証された Octokit を生成する。
 */
export async function createGitHubClient(env: Env, logger: Logger): Promise<GitHubClient> {
  const privateKey = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.GITHUB_APP_ID,
      privateKey,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
    },
  });

  const getToken = async () => {
    const result = (await octokit.auth({ type: "installation" })) as { token: string };
    return result.token;
  };

  // 起動時 sanity check: 認証が成立することをここで確認する。
  await getToken();
  logger.info(
    { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID },
    "GitHub App authenticated",
  );

  return { octokit, getToken };
}

/**
 * 指定ブランチが Protected Branch かを問い合わせる。
 * - 未保護 (404) なら false
 * - 権限不足等の他エラーも「保護されてるとは確定できない」として false を返し、
 *   ログに警告を出す。ユーザーが意図的に protected-only モードを使う時は
 *   Administration: Read 権限を App に付与している前提。
 */
export async function isBranchProtected(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  logger?: Logger,
): Promise<boolean> {
  try {
    await octokit.rest.repos.getBranchProtection({ owner, repo, branch });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return false;
    logger?.warn(
      {
        repo: `${owner}/${repo}`,
        branch,
        status,
        err: (err as Error).message,
      },
      "branch protection check failed, treating as not protected",
    );
    return false;
  }
}
