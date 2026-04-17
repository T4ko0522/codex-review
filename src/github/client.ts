import { Octokit } from "@octokit/rest";
import type { Logger } from "../logger.ts";

export function createGitHubClient(token: string | undefined, logger: Logger): Octokit | null {
	if (!token) {
		logger.info("GITHUB_TOKEN not set, GitHub feedback disabled");
		return null;
	}
	return new Octokit({ auth: token });
}
