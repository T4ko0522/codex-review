import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Env } from "../env.ts";
import type { Logger } from "../logger.ts";

export interface GitHubClient {
  octokit: Octokit;
  /** git clone 用の Installation Token */
  token: string;
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

  const { token } = (await octokit.auth({ type: "installation" })) as { token: string };
  logger.info(
    { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_APP_INSTALLATION_ID },
    "GitHub App authenticated",
  );

  return { octokit, token };
}
