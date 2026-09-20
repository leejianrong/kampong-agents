import type { PullRequestContext } from "./github.js";
import { createGithubClient, fetchPullRequest, postReviewComment } from "./github.js";
import { planReview } from "./agents/planner.js";
import { runSpecialist } from "./agents/specialists.js";
import { SPECIALISTS, type Review, type Specialist } from "./agents/schema.js";
import { emitSwarmEvent } from "./events.js";

const SEVERITY_EMOJI: Record<Review["findings"][number]["severity"], string> = {
  info: "ℹ️",
  warning: "⚠️",
  blocker: "🛑",
};

function formatSection(specialist: Specialist, review: Review): string {
  const lines = [`### ${specialist}\n\n${review.summary}`];
  for (const finding of review.findings) {
    lines.push(`- ${SEVERITY_EMOJI[finding.severity]} ${finding.comment}`);
  }
  return lines.join("\n");
}

function mergeReview(ran: Specialist[], reviews: Record<Specialist, Review | undefined>): string {
  const skipped = SPECIALISTS.filter((s) => !ran.includes(s));
  const sections = ran.map((s) => formatSection(s, reviews[s]!));
  const skippedLine =
    skipped.length > 0
      ? `\n\n_Skipped: ${skipped.join(", ")} (planner judged this diff out of scope for them)._`
      : "";
  return [
    "## pr-review-swarm (real, multi-agent)",
    "",
    ...sections,
    skippedLine,
  ].join("\n");
}

/** The real end-to-end pipeline: fetch diff -> plan -> run specialists -> post one merged comment. */
export async function reviewPullRequest(owner: string, repo: string, number: number): Promise<void> {
  const label = `${owner}/${repo}#${number}`;
  try {
    const octokit = createGithubClient();
    const pr: PullRequestContext = await fetchPullRequest(octokit, owner, repo, number);

    const ran = await planReview(pr.diff, pr.files);
    emitSwarmEvent({ type: "planner_routed", pr: label, specialists: ran, at: Date.now() });

    if (ran.length === 0) {
      await postReviewComment(
        octokit,
        pr,
        "## pr-review-swarm (real, multi-agent)\n\nPlanner judged no specialist review was needed for this diff.",
      );
      emitSwarmEvent({ type: "comment_posted", pr: label, at: Date.now() });
      return;
    }

    const reviews: Record<Specialist, Review | undefined> = {
      security: undefined,
      style: undefined,
      "test-coverage": undefined,
    };
    await Promise.all(
      ran.map(async (specialist) => {
        const review = await runSpecialist(specialist, pr.diff, pr.files);
        reviews[specialist] = review;
        emitSwarmEvent({
          type: "specialist_verdict",
          pr: label,
          specialist,
          findings: review.findings.length,
          at: Date.now(),
        });
      }),
    );

    await postReviewComment(octokit, pr, mergeReview(ran, reviews));
    emitSwarmEvent({ type: "comment_posted", pr: label, at: Date.now() });
  } catch (err) {
    emitSwarmEvent({
      type: "review_error",
      pr: label,
      message: err instanceof Error ? err.message : String(err),
      at: Date.now(),
    });
    throw err;
  }
}
