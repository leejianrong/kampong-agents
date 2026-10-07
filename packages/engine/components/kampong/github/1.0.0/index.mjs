// kampong/github: pull requests, their diffs and files, comments and reviews, with a personal access token.
//
// A module rather than a manifest because a request template cannot follow pages (GitHub returns 30 files
// by default and a naive caller silently stops there) or cut a large diff at a file boundary. It sees only
// `ctx`: the token comes from the declared slot and the only host it can reach is api.github.com.

const API = "https://api.github.com";
const DEFAULT_DIFF_CHARS = 60_000;
const DEFAULT_MAX_PAGES = 10;
const NAME = /^[A-Za-z0-9._-]+$/;

export async function invoke(op, input, ctx) {
  switch (op) {
    case "get_user": {
      const user = await json(ctx, "GET", "/user");
      return { login: user.login };
    }
    case "get_pull_request": {
      const pr = await json(ctx, "GET", `${pullPath(input)}`);
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body ?? "",
        state: pr.state,
        draft: Boolean(pr.draft),
        author: pr.user?.login ?? "",
        base: pr.base?.ref ?? "",
        head: pr.head?.ref ?? "",
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        html_url: pr.html_url,
      };
    }
    case "get_pull_diff":
      return getPullDiff(input, ctx);
    case "list_pull_files":
      return listPullFiles(input, ctx);
    case "create_issue_comment": {
      const comment = await json(
        ctx,
        "POST",
        `${repoPath(input)}/issues/${number(input.issue_number, "issue_number")}/comments`,
        { body: input.body },
      );
      return { id: comment.id, html_url: comment.html_url };
    }
    case "create_review": {
      const payload = { event: input.event };
      if (input.body !== undefined) payload.body = input.body;
      if (input.comments !== undefined) payload.comments = input.comments.map(lineComment);
      const review = await json(ctx, "POST", `${pullPath(input)}/reviews`, payload);
      return { id: review.id, state: review.state, html_url: review.html_url };
    }
    default:
      throw new Error(`kampong/github has no op "${op}"`);
  }
}

async function getPullDiff(input, ctx) {
  const limit = input.max_chars ?? DEFAULT_DIFF_CHARS;
  const response = await request(ctx, "GET", pullPath(input), undefined, {
    Accept: "application/vnd.github.diff",
  });
  const text = await response.text();
  if (text.length <= limit) {
    const files = countFiles(text);
    return {
      diff: text,
      truncated: false,
      total_chars: text.length,
      files_included: files,
      files_omitted: 0,
    };
  }
  // Cut at the last file boundary that fits, so the model never sees half a file; if the first file alone
  // is over the limit, cut inside it rather than return nothing.
  const boundary = text.lastIndexOf("\ndiff --git ", limit);
  const diff = boundary > 0 ? text.slice(0, boundary + 1) : text.slice(0, limit);
  const total = countFiles(text);
  const included = countFiles(diff);
  return {
    diff,
    truncated: true,
    total_chars: text.length,
    files_included: included,
    files_omitted: Math.max(0, total - included),
  };
}

async function listPullFiles(input, ctx) {
  const maxPages = input.max_pages ?? DEFAULT_MAX_PAGES;
  const files = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request(
      ctx,
      "GET",
      `${pullPath(input)}/files?per_page=100&page=${page}`,
    );
    const batch = parse(await response.text());
    if (!Array.isArray(batch)) throw new Error("GitHub returned a file list that is not an array");
    for (const file of batch) {
      files.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        ...(file.previous_filename !== undefined && { previous_filename: file.previous_filename }),
        ...(input.include_patch === true && { patch: file.patch ?? null }),
      });
    }
    const more = /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "");
    if (!more) break;
    if (page === maxPages) truncated = true;
  }
  return { files, total: files.length, truncated };
}

function lineComment(comment) {
  if (
    typeof comment?.path !== "string" ||
    typeof comment?.body !== "string" ||
    !Number.isInteger(comment?.line)
  ) {
    throw new Error("each line comment needs a path, a body and an integer line");
  }
  return {
    path: comment.path,
    line: comment.line,
    body: comment.body,
    side: comment.side === "LEFT" ? "LEFT" : "RIGHT",
  };
}

function repoPath(input) {
  for (const field of ["owner", "repo"]) {
    const value = input[field];
    if (typeof value !== "string" || !NAME.test(value) || value === "." || value === "..") {
      throw new Error(`${field} must be a GitHub name (letters, digits, dot, hyphen, underscore)`);
    }
  }
  return `/repos/${input.owner}/${input.repo}`;
}

function pullPath(input) {
  return `${repoPath(input)}/pulls/${number(input.pull_number, "pull_number")}`;
}

function number(value, field) {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${field} must be a positive whole number`);
  return value;
}

function countFiles(diff) {
  return diff.startsWith("diff --git ")
    ? 1 + (diff.match(/\ndiff --git /g)?.length ?? 0)
    : (diff.match(/\ndiff --git /g)?.length ?? 0);
}

async function json(ctx, method, path, body) {
  return parse(await (await request(ctx, method, path, body)).text());
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GitHub returned a response that is not JSON");
  }
}

async function request(ctx, method, path, body, headers = {}) {
  const response = await ctx.fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${ctx.secrets.get("token")}`,
      "User-Agent": "kampong-agents",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: ctx.signal,
  });
  if (!response.ok) {
    // `status` lets `kampong doctor` tell a refused token (401) from a service that is down, and lets a
    // recorded failure replay. The runner scrubs any secret from the message.
    throw Object.assign(new Error(await describeFailure(response)), { status: response.status });
  }
  return response;
}

// GitHub answers errors as { "message": "..." }; a rate limit is a 403 or 429 with the budget in headers.
async function describeFailure(response) {
  let detail = "";
  try {
    const message = JSON.parse(await response.text()).message;
    if (typeof message === "string") detail = message.slice(0, 300);
  } catch {
    // Not JSON: report the status alone.
  }
  const limited = response.headers.get("x-ratelimit-remaining") === "0";
  const reset = response.headers.get("x-ratelimit-reset");
  const suffix = limited
    ? `; rate limit exhausted${reset ? `, resets at ${new Date(Number(reset) * 1000).toISOString()}` : ""}`
    : "";
  return `GitHub returned HTTP ${response.status}${detail ? ` (${detail})` : ""}${suffix}`;
}
