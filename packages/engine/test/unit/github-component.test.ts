import { describe, expect, it } from "vitest";
import { invokeOp } from "../../src/component.js";
import { createFirstPartyRegistry, InProcessModuleRunner } from "../../src/component-registry.js";
import { ToolCallError, type ToolFetchImpl } from "../../src/http-tool.js";

// KAN-1872: kampong/github against a fake api.github.com. Nothing here reaches the network.

const registry = createFirstPartyRegistry();
const runner = new InProcessModuleRunner(registry);

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeGitHub(route: (seen: Seen) => Response): { fetchImpl: ToolFetchImpl; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      const entry: Seen = {
        url: String(url),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        ...(typeof init?.body === "string" && { body: init.body }),
      };
      seen.push(entry);
      return route(entry);
    },
  };
}

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers as object) },
    ...init,
  });

async function call(
  op: string,
  input: Record<string, unknown>,
  fetchImpl: ToolFetchImpl,
): Promise<unknown> {
  const { manifest } = await registry.resolve("kampong/github", "1.0.0");
  return invokeOp(manifest, op, input, {
    runner,
    fetchImpl,
    env: { GITHUB_TOKEN: "ghp_secret_token" },
  });
}

const PR = { owner: "acme", repo: "widgets", pull_number: 7 };

describe("kampong/github", () => {
  it("sends the token only to api.github.com, with the API version and a user agent", async () => {
    const { fetchImpl, seen } = fakeGitHub(() => jsonResponse({ login: "octo" }));
    expect(await call("get_user", {}, fetchImpl)).toEqual({ login: "octo" });
    expect(seen[0]!.url).toBe("https://api.github.com/user");
    expect(seen[0]!.headers.Authorization).toBe("Bearer ghp_secret_token");
    expect(seen[0]!.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(seen[0]!.headers["User-Agent"]).toBe("kampong-agents");
  });

  it("get_pull_request returns the fields a reviewer needs", async () => {
    const { fetchImpl, seen } = fakeGitHub(() =>
      jsonResponse({
        number: 7,
        title: "Fix it",
        body: null,
        state: "open",
        draft: false,
        user: { login: "octo" },
        base: { ref: "main" },
        head: { ref: "fix" },
        changed_files: 2,
        additions: 10,
        deletions: 3,
        html_url: "https://github.com/acme/widgets/pull/7",
        extra: "ignored",
      }),
    );
    expect(await call("get_pull_request", PR, fetchImpl)).toEqual({
      number: 7,
      title: "Fix it",
      body: "",
      state: "open",
      draft: false,
      author: "octo",
      base: "main",
      head: "fix",
      changed_files: 2,
      additions: 10,
      deletions: 3,
      html_url: "https://github.com/acme/widgets/pull/7",
    });
    expect(seen[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7");
  });

  describe("get_pull_diff", () => {
    const file = (name: string, size: number) =>
      `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n+${"x".repeat(size)}\n`;

    it("asks for the diff media type and returns a small diff whole", async () => {
      const text = file("a.ts", 10) + file("b.ts", 10);
      const { fetchImpl, seen } = fakeGitHub(() => new Response(text, { status: 200 }));
      expect(await call("get_pull_diff", PR, fetchImpl)).toEqual({
        diff: text,
        truncated: false,
        total_chars: text.length,
        files_included: 2,
        files_omitted: 0,
      });
      expect(seen[0]!.headers.Accept).toBe("application/vnd.github.diff");
    });

    it("cuts a large diff at the last whole file and says what was left out", async () => {
      const text = file("a.ts", 400) + file("b.ts", 400) + file("c.ts", 400);
      const { fetchImpl } = fakeGitHub(() => new Response(text, { status: 200 }));
      const result = (await call("get_pull_diff", { ...PR, max_chars: 1000 }, fetchImpl)) as {
        diff: string;
        truncated: boolean;
        files_included: number;
        files_omitted: number;
        total_chars: number;
      };
      expect(result.truncated).toBe(true);
      expect(result.files_included).toBe(2);
      expect(result.files_omitted).toBe(1);
      expect(result.total_chars).toBe(text.length);
      expect(result.diff.length).toBeLessThanOrEqual(1000);
      expect(result.diff).toBe(file("a.ts", 400) + file("b.ts", 400));
    });

    it("never returns more than max_chars, even when the next file's boundary falls exactly on it", async () => {
      const overhead = file("a.ts", 0).length;
      const first = file("a.ts", 1001 - overhead); // 1001 characters, so the next file's "\n" is at index 1000
      expect(first.length).toBe(1001);
      const text = first + file("b.ts", 50);
      const { fetchImpl } = fakeGitHub(() => new Response(text, { status: 200 }));
      const result = (await call("get_pull_diff", { ...PR, max_chars: 1000 }, fetchImpl)) as {
        diff: string;
        truncated: boolean;
      };
      expect(result.truncated).toBe(true);
      expect(result.diff.length).toBeLessThanOrEqual(1000);
    });

    it("does not cut a surrogate pair in half", async () => {
      const text = `diff --git a/e b/e\n+${"😀".repeat(2000)}\n`;
      const { fetchImpl } = fakeGitHub(() => new Response(text, { status: 200 }));
      for (const max_chars of [1000, 1001, 1002]) {
        const { diff } = (await call("get_pull_diff", { ...PR, max_chars }, fetchImpl)) as {
          diff: string;
        };
        expect(diff.length).toBeLessThanOrEqual(max_chars);
        expect(() => encodeURIComponent(diff)).not.toThrow();
      }
    });

    it("cuts inside the first file rather than return nothing when it alone is too large", async () => {
      const text = file("big.ts", 5000);
      const { fetchImpl } = fakeGitHub(() => new Response(text, { status: 200 }));
      const result = (await call("get_pull_diff", { ...PR, max_chars: 1000 }, fetchImpl)) as {
        diff: string;
        truncated: boolean;
        files_included: number;
      };
      expect(result.truncated).toBe(true);
      expect(result.diff).toHaveLength(1000);
      expect(result.files_included).toBe(1);
    });
  });

  describe("list_pull_files", () => {
    const filesPage = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        filename: `f${from + i}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@",
      }));

    it("follows every page instead of stopping at the first 30 (or 100)", async () => {
      const { fetchImpl, seen } = fakeGitHub((req) => {
        const page = Number(new URL(req.url).searchParams.get("page"));
        const next =
          page < 3 ? { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` } : {};
        return jsonResponse(filesPage((page - 1) * 100, page < 3 ? 100 : 40), { headers: next });
      });
      const result = (await call("list_pull_files", PR, fetchImpl)) as {
        files: { filename: string; patch?: unknown }[];
        total: number;
        truncated: boolean;
      };
      expect(result.total).toBe(240);
      expect(result.truncated).toBe(false);
      expect(result.files[239]!.filename).toBe("f239.ts");
      expect(seen.map((s) => new URL(s.url).searchParams.get("per_page"))).toEqual([
        "100",
        "100",
        "100",
      ]);
      expect("patch" in result.files[0]!).toBe(false);
    });

    it("says so when max_pages stops it with more remaining", async () => {
      const { fetchImpl } = fakeGitHub((req) => {
        const page = Number(new URL(req.url).searchParams.get("page"));
        return jsonResponse(filesPage((page - 1) * 100, 100), {
          headers: { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` },
        });
      });
      const result = (await call("list_pull_files", { ...PR, max_pages: 2 }, fetchImpl)) as {
        total: number;
        truncated: boolean;
      };
      expect(result).toMatchObject({ total: 200, truncated: true });
    });

    it("keeps going after a full page even when no Link header comes back (as under replay)", async () => {
      const { fetchImpl } = fakeGitHub((req) => {
        const page = Number(new URL(req.url).searchParams.get("page"));
        return jsonResponse(filesPage((page - 1) * 100, page === 1 ? 100 : 5));
      });
      const result = (await call("list_pull_files", PR, fetchImpl)) as {
        total: number;
        truncated: boolean;
      };
      expect(result).toEqual(expect.objectContaining({ total: 105, truncated: false }));
    });

    it("includes patches only when asked", async () => {
      const { fetchImpl } = fakeGitHub(() => jsonResponse(filesPage(0, 1)));
      const result = (await call("list_pull_files", { ...PR, include_patch: true }, fetchImpl)) as {
        files: { patch: string }[];
      };
      expect(result.files[0]!.patch).toBe("@@");
    });
  });

  it("create_issue_comment posts the body to the conversation", async () => {
    const { fetchImpl, seen } = fakeGitHub(() =>
      jsonResponse(
        { id: 99, html_url: "https://github.com/acme/widgets/pull/7#c99" },
        { status: 201 },
      ),
    );
    const result = await call(
      "create_issue_comment",
      { owner: "acme", repo: "widgets", issue_number: 7, body: "LGTM" },
      fetchImpl,
    );
    expect(result).toEqual({ id: 99, html_url: "https://github.com/acme/widgets/pull/7#c99" });
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/widgets/issues/7/comments",
      body: JSON.stringify({ body: "LGTM" }),
    });
    expect(seen[0]!.headers["Content-Type"]).toBe("application/json");
  });

  it("create_review sends the verdict and normalised line comments", async () => {
    const { fetchImpl, seen } = fakeGitHub(() =>
      jsonResponse({ id: 5, state: "CHANGES_REQUESTED", html_url: "u" }),
    );
    await call(
      "create_review",
      {
        ...PR,
        event: "REQUEST_CHANGES",
        body: "see inline",
        comments: [{ path: "a.ts", line: 3, body: "nit", extra: "dropped" }],
      },
      fetchImpl,
    );
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      event: "REQUEST_CHANGES",
      body: "see inline",
      comments: [{ path: "a.ts", line: 3, body: "nit", side: "RIGHT" }],
    });
    expect(seen[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/reviews");
  });

  it("create_review can pin the commit the review is about", async () => {
    const { fetchImpl, seen } = fakeGitHub(() =>
      jsonResponse({ id: 1, state: "COMMENTED", html_url: "u" }),
    );
    await call(
      "create_review",
      { ...PR, event: "COMMENT", body: "x", commit_id: "abc123" },
      fetchImpl,
    );
    expect(JSON.parse(seen[0]!.body!).commit_id).toBe("abc123");
  });

  it("refuses a malformed line comment before sending anything", async () => {
    const { fetchImpl, seen } = fakeGitHub(() => jsonResponse({}));
    await expect(
      call(
        "create_review",
        { ...PR, event: "COMMENT", comments: [{ path: "a.ts", body: "x" }] },
        fetchImpl,
      ),
    ).rejects.toThrow(/integer line/);
    expect(seen).toEqual([]);
  });

  it("refuses an owner or repo that could change the URL path, before sending anything", async () => {
    const { fetchImpl, seen } = fakeGitHub(() => jsonResponse({}));
    for (const bad of [
      { owner: "../orgs", repo: "r" },
      { owner: "a/b", repo: "r" },
      { owner: "a", repo: ".." },
      { owner: "a", repo: "r?x=1" },
    ]) {
      await expect(call("get_pull_request", { ...bad, pull_number: 1 }, fetchImpl)).rejects.toThrow(
        /must be a GitHub name/,
      );
    }
    expect(seen).toEqual([]);
  });

  it("refuses a pull number that is not a positive integer", async () => {
    const { fetchImpl } = fakeGitHub(() => jsonResponse({}));
    await expect(call("get_pull_request", { ...PR, pull_number: 0 }, fetchImpl)).rejects.toThrow();
  });

  describe("failures", () => {
    it("carries the HTTP status and GitHub's message, with the token scrubbed", async () => {
      const { fetchImpl } = fakeGitHub(() =>
        jsonResponse({ message: "Bad credentials ghp_secret_token" }, { status: 401 }),
      );
      const err = (await call("get_user", {}, fetchImpl).catch((e) => e)) as ToolCallError;
      expect(err).toBeInstanceOf(ToolCallError);
      expect((err.cause as { status?: number }).status).toBe(401);
      expect(err.message).toContain("HTTP 401");
      expect(err.message).toContain("Bad credentials");
      expect(err.message).not.toContain("ghp_secret_token");
    });

    it("says when the rate limit is spent, and when it resets", async () => {
      const { fetchImpl } = fakeGitHub(() =>
        jsonResponse(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
          },
        ),
      );
      const err = (await call("get_pull_request", PR, fetchImpl).catch((e) => e)) as Error;
      expect(err.message).toContain("rate limit exhausted, resets at 2027-01-15T08:00:00.000Z");
    });

    it("includes GitHub's errors array, so a bad line comment can be corrected", async () => {
      const { fetchImpl } = fakeGitHub(() =>
        jsonResponse(
          {
            message: "Unprocessable Entity",
            errors: ["Pull request review thread line must be part of the diff"],
          },
          { status: 422 },
        ),
      );
      const err = (await call(
        "create_review",
        { ...PR, event: "COMMENT", body: "x" },
        fetchImpl,
      ).catch((e) => e)) as Error;
      expect(err.message).toContain("HTTP 422");
      expect(err.message).toContain("line must be part of the diff");
    });

    it("says where a moved repository went, without following it", async () => {
      const { fetchImpl, seen } = fakeGitHub(
        () =>
          new Response(null, {
            status: 301,
            headers: { location: "https://api.github.com/repositories/42/pulls/7" },
          }),
      );
      const err = (await call("get_pull_request", PR, fetchImpl).catch((e) => e)) as Error;
      expect(err.message).toContain("moved to https://api.github.com/repositories/42/pulls/7");
      expect(seen).toHaveLength(1);
    });

    it("does not accept a redirect to another host", async () => {
      const { fetchImpl } = fakeGitHub(
        () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }),
      );
      await expect(call("get_pull_request", PR, fetchImpl)).rejects.toThrow(/HTTP 302/);
    });
  });

  it("declares the probe op the doctor uses, as a read", async () => {
    const { manifest } = await registry.resolve("kampong/github", "1.0.0");
    expect(manifest.auth?.slots.token?.probe?.op).toBe("get_user");
    expect(manifest.ops.get_user!.effect).toBe("read");
    for (const op of ["create_issue_comment", "create_review"]) {
      expect(manifest.ops[op]!.effect).toBe("write");
    }
  });
});
