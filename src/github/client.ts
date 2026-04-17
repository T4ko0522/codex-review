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
 * リポジトリのデフォルトブランチ名を取得する。
 * API エラー時は undefined を返しログに警告を出す。
 */
export async function getDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  logger?: Logger,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return data.default_branch;
  } catch (err) {
    logger?.warn(
      {
        repo: `${owner}/${repo}`,
        err: (err as Error).message,
      },
      "failed to fetch default branch",
    );
    return undefined;
  }
}
