import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogEntryFromManifest, planOpForm } from "@kampong/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokeOp, type InvokeOpOptions } from "../../src/component.js";
import { createFirstPartyRegistry, InProcessModuleRunner } from "../../src/component-registry.js";
import { ToolCallError, type ToolFetchImpl } from "../../src/http-tool.js";
import { createModuleFixtures } from "../../src/module-fixtures.js";
import { createFixtureFetch, MissingFixtureError } from "../../src/tool-fixtures.js";

// KAN-1861: kampong/supabase (PostgREST) and kampong/alpha-vantage against fake servers. Nothing here
// reaches the network. Every op is also recorded and replayed at the invoke boundary (KAN-1833).

const registry = createFirstPartyRegistry();
const runner = new InProcessModuleRunner(registry);
const noSleep = { now: () => 0, sleep: async () => {} };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fake(route: (seen: Seen) => Response): { fetchImpl: ToolFetchImpl; seen: Seen[] } {
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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// ---- Supabase --------------------------------------------------------------------------------------

const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";
const SB_ENV = { SUPABASE_URL: PROJECT_URL, SUPABASE_KEY: "sb_secret_key_123" };

async function sb(
  op: string,
  input: Record<string, unknown>,
  fetchImpl: ToolFetchImpl,
  extra: Partial<InvokeOpOptions> = {},
): Promise<unknown> {
  const { manifest } = await registry.resolve("kampong/supabase", "1.0.0");
  return invokeOp(manifest, op, input, {
    runner,
    fetchImpl,
    clock: noSleep,
    env: SB_ENV,
    ...extra,
  });
}

const errorOf = async (p: Promise<unknown>): Promise<ToolCallError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ToolCallError);
  return e as ToolCallError;
};

describe("kampong/supabase", () => {
  it("binds both slots and egress to supabase.co only", async () => {
    const { manifest } = await registry.resolve("kampong/supabase", "1.0.0");
    expect(manifest.kind).toBe("module");
    expect(manifest.permissions?.egress).toEqual(["*.supabase.co"]);
    expect(manifest.auth?.slots.url?.hosts).toEqual(["*.supabase.co"]);
    expect(manifest.auth?.slots.key?.hosts).toEqual(["*.supabase.co"]);
    expect(manifest.auth?.slots.url?.env).toBe("SUPABASE_URL");
    expect(manifest.auth?.slots.key?.env).toBe("SUPABASE_KEY");
    expect(manifest.auth?.slots.key?.probe?.op).toBe("check_key");
    expect(Object.keys(manifest.ops).sort()).toEqual([
      "check_key",
      "insert",
      "rpc",
      "select",
      "upsert",
    ]);
  });

  it("check_key reads the auth settings with the apikey header", async () => {
    const { fetchImpl, seen } = fake(() => json({ external: {} }));
    expect(await sb("check_key", {}, fetchImpl)).toEqual({ ok: true });
    expect(seen[0]!.url).toBe(`${PROJECT_URL}/auth/v1/settings`);
    expect(seen[0]!.headers.apikey).toBe("sb_secret_key_123");
  });

  it("insert posts the rows as a JSON array with Prefer return=minimal and returns the count", async () => {
    const { fetchImpl, seen } = fake(() => new Response(null, { status: 201 }));
    const rows = [{ name: "a" }, { name: "b" }];
    expect(await sb("insert", { table: "tickets", rows }, fetchImpl)).toEqual({
      count: 2,
      rows: [],
    });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${PROJECT_URL}/rest/v1/tickets`);
    expect(seen[0]!.headers.Prefer).toBe("return=minimal");
    expect(seen[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seen[0]!.body!)).toEqual(rows);
  });

  it("insert can return the stored rows", async () => {
    const { fetchImpl, seen } = fake(() => json([{ id: 1, name: "a" }], 201));
    const result = await sb(
      "insert",
      { table: "tickets", rows: [{ name: "a" }], returning: "representation", schema: "support" },
      fetchImpl,
    );
    expect(result).toEqual({ count: 1, rows: [{ id: 1, name: "a" }] });
    expect(seen[0]!.headers.Prefer).toBe("return=representation");
    expect(seen[0]!.headers["Content-Profile"]).toBe("support");
  });

  it("upsert sends on_conflict and Prefer resolution=merge-duplicates,return=minimal", async () => {
    const { fetchImpl, seen } = fake(() => new Response(null, { status: 201 }));
    await sb(
      "upsert",
      { table: "tickets", rows: [{ id: 1 }], on_conflict: "org_id,email" },
      fetchImpl,
    );
    expect(seen[0]!.url).toBe(`${PROJECT_URL}/rest/v1/tickets?on_conflict=org_id%2Cemail`);
    expect(seen[0]!.headers.Prefer).toBe("resolution=merge-duplicates,return=minimal");
  });

  it("upsert with on_duplicate ignore asks PostgREST to skip the existing row", async () => {
    const { fetchImpl, seen } = fake(() => new Response(null, { status: 201 }));
    await sb(
      "upsert",
      { table: "t", rows: [{ id: 1 }], on_conflict: "id", on_duplicate: "ignore" },
      fetchImpl,
    );
    expect(seen[0]!.headers.Prefer).toBe("resolution=ignore-duplicates,return=minimal");
  });

  it("select turns the filter into PostgREST query parameters and reports when it stopped at the limit", async () => {
    const { fetchImpl, seen } = fake(() => json([{ id: 1 }, { id: 2 }]));
    const result = await sb(
      "select",
      {
        table: "tickets",
        columns: "id,status",
        filter: { status: "eq.open", priority: ["gte.2", "lt.9"], archived: false, owner: null },
        order: "created_at.desc",
        limit: 2,
        offset: 4,
        schema: "support",
      },
      fetchImpl,
    );
    expect(result).toEqual({ rows: [{ id: 1 }, { id: 2 }], count: 2, truncated: true });
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe(`${PROJECT_URL}/rest/v1/tickets`);
    expect([...url.searchParams.entries()]).toEqual([
      ["select", "id,status"],
      ["status", "eq.open"],
      ["priority", "gte.2"],
      ["priority", "lt.9"],
      ["archived", "eq.false"],
      ["owner", "is.null"],
      ["order", "created_at.desc"],
      ["limit", "2"],
      ["offset", "4"],
    ]);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers["Accept-Profile"]).toBe("support");
    expect(seen[0]!.body).toBeUndefined();
  });

  it("select defaults to every column and 100 rows, and a short page is not truncated", async () => {
    const { fetchImpl, seen } = fake(() => json([]));
    expect(await sb("select", { table: "t" }, fetchImpl)).toEqual({
      rows: [],
      count: 0,
      truncated: false,
    });
    expect(new URL(seen[0]!.url).search).toBe("?select=*&limit=100");
  });

  it("rpc posts the named arguments to /rpc/<name> and returns the result", async () => {
    const { fetchImpl, seen } = fake(() => json(42));
    expect(await sb("rpc", { name: "score", args: { id: 7 } }, fetchImpl)).toEqual({ result: 42 });
    expect(seen[0]!.url).toBe(`${PROJECT_URL}/rest/v1/rpc/score`);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ id: 7 });
    // A void function answers 204 with no body.
    const empty = fake(() => new Response(null, { status: 204 }));
    expect(await sb("rpc", { name: "ping" }, empty.fetchImpl)).toEqual({ result: null });
    expect(JSON.parse(empty.seen[0]!.body!)).toEqual({});
  });

  it.each([
    ["table", { table: "t; drop table x", rows: [{ a: 1 }] }, /table must be a plain identifier/],
    ["table", { table: "../auth/users", rows: [{ a: 1 }] }, /table must be a plain identifier/],
    ["rows", { table: "t", rows: [] }, /minimum|non-empty|at least/i],
    ["rows", { table: "t", rows: [1] }, /rows\[0\] must be an object/],
  ])("insert refuses a bad %s before any request", async (_f, input, message) => {
    const { fetchImpl, seen } = fake(() => json([]));
    await expect(sb("insert", input, fetchImpl)).rejects.toThrow(message);
    expect(seen).toEqual([]);
  });

  it("upsert refuses an on_conflict that is not column names, and a name that is not a function", async () => {
    const { fetchImpl, seen } = fake(() => json([]));
    await expect(
      sb("upsert", { table: "t", rows: [{ a: 1 }], on_conflict: "id, x" }, fetchImpl),
    ).rejects.toThrow(/on_conflict/);
    await expect(sb("rpc", { name: "a/b" }, fetchImpl)).rejects.toThrow(/name must be/);
    await expect(sb("select", { table: "t", order: "x;y" }, fetchImpl)).rejects.toThrow(/order/);
    await expect(
      sb("select", { table: "t", filter: { "a&b": "eq.1" } }, fetchImpl),
    ).rejects.toThrow(/not a column name/);
    expect(seen).toEqual([]);
  });

  it("refuses a project URL that is not https://<ref>.supabase.co, so the key cannot be sent elsewhere", async () => {
    for (const url of [
      "https://evil.example.com",
      "http://abcdefghijklmnopqrst.supabase.co",
      "https://abcdefghijklmnopqrst.supabase.co.evil.test",
      "https://abcdefghijklmnopqrst.supabase.co:8443",
      "not a url",
    ]) {
      const { fetchImpl, seen } = fake(() => json({}));
      await expect(
        sb("select", { table: "t" }, fetchImpl, { env: { ...SB_ENV, SUPABASE_URL: url } }),
      ).rejects.toThrow(/project URL/);
      expect(seen).toEqual([]);
    }
  });

  it("a missing key is a visible auth failure naming the variable, not a request", async () => {
    const { fetchImpl, seen } = fake(() => json({}));
    const e = await errorOf(
      sb("select", { table: "t" }, fetchImpl, { env: { SUPABASE_URL: PROJECT_URL } }),
    );
    expect(e.message).toContain("SUPABASE_KEY");
    expect(seen).toEqual([]);
  });

  describe("PostgREST error bodies", () => {
    const failing = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      fake(() => json(body, status, headers)).fetchImpl;

    it("a unique violation reports the code, message, details and advice, with the status", async () => {
      const e = await errorOf(
        sb(
          "insert",
          { table: "t", rows: [{ id: 1 }] },
          failing(409, {
            code: "23505",
            message: 'duplicate key value violates unique constraint "t_pkey"',
            details: "Key (id)=(1) already exists.",
            hint: null,
          }),
        ),
      );
      expect(e.status).toBe(409);
      expect(e.message).toContain('23505 duplicate key value violates unique constraint "t_pkey"');
      expect(e.message).toContain("details: Key (id)=(1) already exists.");
      expect(e.message).toContain("use upsert");
      expect(e.retryable).toBe(false);
    });

    it("a row-level-security refusal says so", async () => {
      const e = await errorOf(
        sb(
          "insert",
          { table: "t", rows: [{ id: 1 }] },
          failing(403, {
            code: "42501",
            message: 'new row violates row-level security policy for table "t"',
          }),
        ),
      );
      expect(e.status).toBe(403);
      expect(e.message).toMatch(/row-level security/);
    });

    it("a missing table and a missing function are named", async () => {
      const t = await errorOf(
        sb(
          "select",
          { table: "nope" },
          failing(404, {
            code: "PGRST205",
            message: "Could not find the table 'public.nope'",
            hint: "Perhaps you meant 'notes'",
          }),
        ),
      );
      expect(t.message).toContain("hint: Perhaps you meant 'notes'");
      expect(t.message).toContain("schema is exposed");
      const f = await errorOf(
        sb(
          "rpc",
          { name: "nope" },
          failing(404, { code: "PGRST202", message: "Could not find the function" }),
        ),
      );
      expect(f.message).toContain("no such function");
    });

    it("a rejected key is an auth error and never echoes the key", async () => {
      const e = await errorOf(
        sb(
          "select",
          { table: "t" },
          failing(401, { code: "PGRST301", message: "JWT expired for sb_secret_key_123" }),
        ),
      );
      expect(e.status).toBe(401);
      expect(e.message).not.toContain("sb_secret_key_123");
    });

    it("an HTML gateway error still reports the status", async () => {
      const e = await errorOf(
        sb(
          "select",
          { table: "t" },
          async () => new Response("<html>Bad gateway</html>", { status: 502 }),
        ),
      );
      expect(e.message).toContain("HTTP 502");
      expect(e.message).not.toContain("<html>");
    });
  });

  describe("retry (ADR-0035)", () => {
    it("retries a select through a 503, and honours Retry-After on a 429", async () => {
      let n = 0;
      const { fetchImpl, seen } = fake(() => {
        n += 1;
        return n === 1 ? json({ message: "down" }, 503) : json([{ id: 1 }]);
      });
      expect(await sb("select", { table: "t" }, fetchImpl)).toMatchObject({ count: 1 });
      expect(seen).toHaveLength(2);

      const sleeps: number[] = [];
      let m = 0;
      const limited = fake(() => {
        m += 1;
        return m === 1 ? json({ message: "slow down" }, 429, { "retry-after": "3" }) : json([]);
      });
      await sb("select", { table: "t" }, limited.fetchImpl, {
        clock: { now: () => 0, sleep: async (ms: number) => void sleeps.push(ms) },
      });
      expect(sleeps).toEqual([3000]);
    });

    it("does not repeat a write after a 5xx, which may have been processed, but does after a 429", async () => {
      const down = fake(() => json({ message: "boom" }, 500));
      const e = await errorOf(sb("insert", { table: "t", rows: [{ a: 1 }] }, down.fetchImpl));
      expect(down.seen).toHaveLength(1);
      expect(e.status).toBe(500);

      let n = 0;
      const limited = fake(() => {
        n += 1;
        return n === 1 ? json({ message: "slow" }, 429) : new Response(null, { status: 201 });
      });
      await sb("insert", { table: "t", rows: [{ a: 1 }] }, limited.fetchImpl);
      expect(limited.seen).toHaveLength(2);
    });
  });

  describe("recorded fixtures at the invoke boundary (KAN-1833)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "kampong-supabase-fixtures-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const cases: [string, Record<string, unknown>, () => Response][] = [
      ["check_key", {}, () => json({})],
      ["insert", { table: "t", rows: [{ a: 1 }] }, () => new Response(null, { status: 201 })],
      [
        "upsert",
        { table: "t", rows: [{ a: 1 }], on_conflict: "a" },
        () => new Response(null, { status: 201 }),
      ],
      ["select", { table: "t", filter: { a: "eq.1" } }, () => json([{ a: 1 }])],
      ["rpc", { name: "f", args: { x: 1 } }, () => json({ y: 2 })],
    ];

    it.each(cases)(
      "%s: replays what was recorded with no runner, network or credentials",
      async (op, input, respond) => {
        const live = fake(respond);
        const recorded = await sb(op, input, live.fetchImpl, {
          moduleFixtures: createModuleFixtures({
            mode: "record",
            fixturesDir: dir,
            secrets: ["sb_secret_key_123"],
          }),
        });
        const { manifest } = await registry.resolve("kampong/supabase", "1.0.0");
        const replayed = await invokeOp(manifest, op, input, {
          moduleFixtures: createModuleFixtures({ mode: "replay", fixturesDir: dir }),
          env: {},
        });
        expect(replayed).toEqual(recorded);
      },
    );

    it("records a PostgREST failure and replays it as the same error", async () => {
      const failing = fake(() => json({ code: "23505", message: "duplicate key" }, 409));
      const input = { table: "t", rows: [{ id: 1 }] };
      const live = await errorOf(
        sb("insert", input, failing.fetchImpl, {
          moduleFixtures: createModuleFixtures({ mode: "record", fixturesDir: dir }),
        }),
      );
      const { manifest } = await registry.resolve("kampong/supabase", "1.0.0");
      const replayed = await errorOf(
        invokeOp(manifest, "insert", input, {
          moduleFixtures: createModuleFixtures({ mode: "replay", fixturesDir: dir }),
          env: {},
        }),
      );
      expect(replayed.status).toBe(409);
      expect(replayed.message).toBe(live.message);
    });

    it("never writes the key into a fixture", async () => {
      const live = fake(() => json([{ note: "key is sb_secret_key_123" }]));
      await sb("select", { table: "t" }, live.fetchImpl, {
        moduleFixtures: createModuleFixtures({
          mode: "record",
          fixturesDir: dir,
          secrets: ["sb_secret_key_123"],
        }),
      });
      const { readdirSync, readFileSync } = await import("node:fs");
      for (const file of readdirSync(dir)) {
        expect(readFileSync(join(dir, file), "utf8")).not.toContain("sb_secret_key_123");
      }
    });

    it("a replay with nothing recorded is a missing-fixture error, never a live call", async () => {
      const { manifest } = await registry.resolve("kampong/supabase", "1.0.0");
      await expect(
        invokeOp(
          manifest,
          "select",
          { table: "t" },
          {
            moduleFixtures: createModuleFixtures({ mode: "replay", fixturesDir: dir }),
            env: {},
          },
        ),
      ).rejects.toBeInstanceOf(MissingFixtureError);
    });
  });
});

// ---- Alpha Vantage ---------------------------------------------------------------------------------

const AV_ENV = { ALPHAVANTAGE_API_KEY: "av-secret-key" };
const PRICES = {
  "Meta Data": { "1. Information": "Daily Prices", "2. Symbol": "IBM" },
  "Time Series (Daily)": {
    "2026-10-09": {
      "1. open": "230.0",
      "2. high": "233.0",
      "3. low": "229.0",
      "4. close": "232.0",
      "5. volume": "3000000",
    },
  },
};
const DAILY = { symbol: "IBM" };

async function av(
  input: Record<string, unknown>,
  fetchImpl: ToolFetchImpl,
  extra: Partial<InvokeOpOptions> = {},
): Promise<unknown> {
  const { manifest } = await registry.resolve("kampong/alpha-vantage", "1.0.0");
  return invokeOp(manifest, "time_series_daily", input, {
    fetchImpl,
    clock: noSleep,
    pacer: { wait: async () => {} },
    env: AV_ENV,
    ...extra,
  });
}

describe("kampong/alpha-vantage", () => {
  it("is a rest component bound to www.alphavantage.co, paced at one request a second", async () => {
    const { manifest } = await registry.resolve("kampong/alpha-vantage", "1.0.0");
    expect(manifest.kind).toBe("rest");
    expect(manifest.permissions?.egress).toEqual(["www.alphavantage.co"]);
    expect(manifest.auth?.slots.key?.hosts).toEqual(["www.alphavantage.co"]);
    expect(manifest.auth?.slots.key?.probe?.op).toBe("time_series_daily");
    const op = manifest.ops.time_series_daily as { pace?: { rps: number }; retry?: unknown };
    expect(op.pace).toEqual({ rps: 1 });
    expect(op.retry).toBeDefined();
  });

  it("builds the query with the key injected and returns the prices", async () => {
    const { fetchImpl, seen } = fake(() => json(PRICES));
    expect(await av(DAILY, fetchImpl)).toEqual(PRICES);
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe("https://www.alphavantage.co/query");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      function: "TIME_SERIES_DAILY",
      symbol: "IBM",
      outputsize: "compact",
      datatype: "json",
      apikey: "av-secret-key",
    });
  });

  it("holds requests to one per second through the pacer", async () => {
    const waits: [string, number][] = [];
    const { fetchImpl } = fake(() => json(PRICES));
    await av(DAILY, fetchImpl, {
      pacer: { wait: async (key: string, rps: number) => void waits.push([key, rps]) },
    });
    expect(waits).toEqual([["www.alphavantage.co", 1]]);
  });

  describe("failures that arrive as HTTP 200", () => {
    const burst = {
      Information:
        "Burst pattern detected. Please consider spreading out your free API requests more sparingly (1 request per second).",
    };
    const daily = {
      Information:
        "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans.",
    };
    const note = {
      Note: "Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute.",
    };
    const bad = { "Error Message": "Invalid API call. Please retry or visit the documentation." };

    it.each([
      ["daily-limit Information", daily, /25 requests per day/],
      ["Note", note, /5 calls per minute/],
      ["Error Message", bad, /Invalid API call/],
      ["a 200 with no prices and no known field", { whatever: 1 }, /Time Series \(Daily\)/],
    ])(
      "%s is a visible failure, never an empty success, and is not retried",
      async (_n, body, message) => {
        const { fetchImpl, seen } = fake(() => json(body));
        const e = await errorOf(av(DAILY, fetchImpl));
        expect(e.code).toBe("failure_when");
        expect(e.message).toMatch(message);
        // A spent daily quota or a bad symbol will not be fixed by trying again in two seconds.
        expect(seen).toHaveLength(1);
      },
    );

    it("the burst limit is retried with backoff and then succeeds", async () => {
      const sleeps: number[] = [];
      let n = 0;
      const { fetchImpl, seen } = fake(() => {
        n += 1;
        return json(n === 1 ? burst : PRICES);
      });
      expect(
        await av(DAILY, fetchImpl, {
          clock: { now: () => 0, sleep: async (ms: number) => void sleeps.push(ms) },
        }),
      ).toEqual(PRICES);
      expect(seen).toHaveLength(2);
      expect(sleeps).toEqual([2000]);
    });

    it("a burst limit that persists fails after the last attempt, saying how many", async () => {
      const { fetchImpl, seen } = fake(() => json(burst));
      const e = await errorOf(av(DAILY, fetchImpl));
      expect(seen).toHaveLength(3);
      expect(e.message).toContain("after 3 attempts");
      expect(e.message).toMatch(/1 request per second/);
    });

    it("never puts the key in an error", async () => {
      const { fetchImpl } = fake(() => json({ "Error Message": "bad key av-secret-key" }));
      const e = await errorOf(av(DAILY, fetchImpl));
      expect(e.message).not.toContain("av-secret-key");
    });
  });

  it("retries a 503 and reports a 429 as rate_limit", async () => {
    let n = 0;
    const flaky = fake(() => (++n === 1 ? new Response("down", { status: 503 }) : json(PRICES)));
    expect(await av(DAILY, flaky.fetchImpl)).toEqual(PRICES);
    const limited = fake(() => new Response("slow", { status: 429 }));
    expect((await errorOf(av(DAILY, limited.fetchImpl))).code).toBe("rate_limit");
  });

  it("refuses input that is not a symbol before any request", async () => {
    const { fetchImpl, seen } = fake(() => json(PRICES));
    await expect(av({ symbol: "IBM", outputsize: "huge" }, fetchImpl)).rejects.toThrow(
      /outputsize/,
    );
    await expect(av({}, fetchImpl)).rejects.toThrow(/symbol/);
    expect(seen).toEqual([]);
  });

  describe("recorded fixtures (KAN-1833)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "kampong-av-fixtures-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const replayFetch = () => createFixtureFetch({ mode: "replay", fixturesDir: dir });

    it("replays recorded prices without the network or the key", async () => {
      const recorded = await av(
        DAILY,
        createFixtureFetch({
          mode: "record",
          fixturesDir: dir,
          secrets: ["av-secret-key"],
          fetchImpl: async () => json(PRICES),
        }),
      );
      expect(await av(DAILY, replayFetch(), { env: AV_ENV })).toEqual(recorded);
    });

    it("replays the recorded 200-OK rate limit as the same failure", async () => {
      const limit = {
        Information: "Our standard API rate limit is 25 requests per day.",
      };
      const live = await errorOf(
        av(
          DAILY,
          createFixtureFetch({
            mode: "record",
            fixturesDir: dir,
            secrets: ["av-secret-key"],
            fetchImpl: async () => json(limit),
          }),
        ),
      );
      const replayed = await errorOf(av(DAILY, replayFetch()));
      expect(replayed.code).toBe("failure_when");
      expect(replayed.message).toBe(live.message);
    });

    it("a replay with nothing recorded is a missing-fixture error", async () => {
      const e = await errorOf(av(DAILY, replayFetch()));
      expect(e.message).toMatch(/No recorded fixture/);
    });
  });
});

// ---- Canvas forms ----------------------------------------------------------------------------------

describe("canvas forms from the op input schemas (KAN-1885)", () => {
  it("Alpha Vantage gets a real form: symbol as text, outputsize as an enum with its default", async () => {
    const { manifest, digest } = await registry.resolve("kampong/alpha-vantage", "1.0.0");
    const op = catalogEntryFromManifest(manifest, digest).ops.time_series_daily!;
    const plan = planOpForm(op.input);
    expect(plan.supported).toBe(true);
    expect(plan.fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["symbol", "text", true],
      ["outputsize", "enum", false],
    ]);
    expect(plan.fields[1]!.default).toBe("compact");
  });

  it("Supabase check_key has nothing to fill in; the table ops fall back to the YAML editor for their free-form rows, filter and args, naming the property", async () => {
    const { manifest, digest } = await registry.resolve("kampong/supabase", "1.0.0");
    const ops = catalogEntryFromManifest(manifest, digest).ops;
    expect(planOpForm(ops.check_key!.input)).toEqual({ supported: true, fields: [] });
    for (const [op, property] of [
      ["insert", "rows"],
      ["upsert", "rows"],
      ["select", "filter"],
      ["rpc", "args"],
    ] as const) {
      const plan = planOpForm(ops[op]!.input);
      expect(plan.supported, op).toBe(false);
      expect(plan.reason, op).toContain(property);
    }
  });
});
