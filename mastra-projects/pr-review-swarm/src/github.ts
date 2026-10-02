import { Octokit } from "@octokit/rest";

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  diff: string;
  files: string[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

export function createGithubClient() {
  const token = requireEnv("GITHUB_TOKEN");
  return new Octokit({ auth: token });
}

/** Fetches a real PR's diff and changed-file list via the real GitHub API. */
export async function fetchPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestContext> {
  const [{ data: pr }, diffResponse, filesResponse] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: number }),
    octokit.pulls.get({
      owner,
      repo,
      pull_number: number,
      mediaType: { format: "diff" },
    }),
    octokit.pulls.listFiles({ owner, repo, pull_number: number }),
  ]);

  return {
    owner,
    repo,
    number,
    title: pr.title,
    // Octokit types this as the parsed object; requesting the diff media
    // type makes it a raw string at runtime -- see README's gap-analysis
    // note on this exact rough edge.
    diff: diffResponse.data as unknown as string,
    files: filesResponse.data.map((f) => f.filename),
  };
}

/** Posts one real issue comment (a PR is an issue under the hood) with the merged review. */
export async function postReviewComment(
  octokit: Octokit,
  pr: PullRequestContext,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    body,
  });
}
