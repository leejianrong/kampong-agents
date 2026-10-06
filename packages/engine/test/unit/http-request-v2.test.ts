import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool } from "@kampong/spec";
import { buildToolRequest, callHttpTool } from "../../src/http-tool.js";
import { createFixtureFetch } from "../../src/tool-fixtures.js";

// KAN-1845 (ADR-0029): http_request headers, query, body encodings and response modes. Uses an
// injected fake fetch and env; no live network (AGENTS.md testing approach).

type HttpTool = Extract<Tool, { action: "http_request" }>;

function tool(overrides: Partial<HttpTool> = {}): HttpTool {
  return {
    name: "call",
    action: "http_request",
    method: "GET",
    url: "https://api.example.test/v1/data",
    ...overrides,
  };
}

const ENV = { API_TOKEN: "tok-123", ALPHA_KEY: "key-456" } as NodeJS.ProcessEnv;

describe("buildToolRequest -- http_request v2", () => {
  it("is unchanged for a tool with none of the new fields", () => {
    const request = buildToolRequest(tool(), {}, ENV);

    expect(request).toMatchObject({
      url: "https://api.example.test/v1/data",
      method: "GET",
      headers: {},
      responseMode: "json",
      secrets: [],
    });
    expect(request.body).toBeUndefined();
  });

  it("appends encoded query parameters, joining with & when the URL already has a query", () => {
    const plain = buildToolRequest(tool({ query: { symbol: "IBM", q: "a b&c" } }), {}, ENV);
    const existing = buildToolRequest(
      tool({ url: "https://api.example.test/v1/data?fixed=1", query: { symbol: "IBM" } }),
      {},
      ENV,
    );

    expect(plain.url).toBe("https://api.example.test/v1/data?symbol=IBM&q=a%20b%26c");
    expect(existing.url).toBe("https://api.example.test/v1/data?fixed=1&symbol=IBM");
  });

  it("resolves ${ENV} inside headers and query values, and records them as secrets", () => {
    const request = buildToolRequest(
      tool({
        headers: { Authorization: "Bearer ${API_TOKEN}" },
        query: { apikey: "${ALPHA_KEY}" },
      }),
      {},
      ENV,
    );

    expect(request.headers.Authorization).toBe("Bearer tok-123");
    expect(request.url).toContain("apikey=key-456");
    expect(request.secrets.sort()).toEqual(["key-456", "tok-123"]);
  });

  it("fails visibly, naming the variable, when a referenced env var is unset", () => {
    expect(() =>
      buildToolRequest(tool({ headers: { Authorization: "Bearer ${MISSING_TOKEN}" } }), {}, ENV),
    ).toThrow(/MISSING_TOKEN/);
  });

  it("never expands ${ENV} that arrives through data references (no secret smuggling)", () => {
    const request = buildToolRequest(
      tool({ query: { q: "{{ input }}" } }),
      { input: "${API_TOKEN}" },
      ENV,
    );

    expect(request.url).toBe("https://api.example.test/v1/data?q=%24%7BAPI_TOKEN%7D");
    expect(request.secrets).toEqual([]);
  });

  it("substitutes data references into headers, query values and body fields", () => {
    const request = buildToolRequest(
      tool({
        method: "POST",
        headers: { "X-Trace": "{{ classify.id }}" },
        query: { ticket: "{{ classify.id }}" },
        body: { json: { note: "re: {{ classify.id }}", nested: { list: ["{{ classify.id }}"] } } },
      }),
      { "classify.id": "T-9" },
      ENV,
    );

    expect(request.headers["X-Trace"]).toBe("T-9");
    expect(request.url).toContain("ticket=T-9");
    expect(JSON.parse(request.body!)).toEqual({ note: "re: T-9", nested: { list: ["T-9"] } });
  });

  it("encodes a json body, sets a default content type, and respects an explicit one", () => {
    const defaulted = buildToolRequest(tool({ method: "POST", body: { json: { a: 1 } } }), {}, ENV);
    const explicit = buildToolRequest(
      tool({
        method: "POST",
        headers: { "content-type": "application/vnd.api+json" },
        body: { json: { a: 1 } },
      }),
      {},
      ENV,
    );

    expect(defaulted.headers["Content-Type"]).toBe("application/json");
    expect(explicit.headers["Content-Type"]).toBeUndefined();
    expect(explicit.headers["content-type"]).toBe("application/vnd.api+json");
  });

  it("encodes form and raw bodies", () => {
    const form = buildToolRequest(
      tool({ method: "POST", body: { form: { a: "1 2", b: "x&y" } } }),
      {},
      ENV,
    );
    const raw = buildToolRequest(
      tool({ method: "PUT", body: { raw: "hello", content_type: "text/csv" } }),
      {},
      ENV,
    );

    expect(form.body).toBe("a=1+2&b=x%26y");
    expect(form.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(raw.body).toBe("hello");
    expect(raw.headers["Content-Type"]).toBe("text/csv");
  });

  it("rejects a body on a GET, and extract on a non-json response", () => {
    expect(() => buildToolRequest(tool({ body: { raw: "x" } }), {}, ENV)).toThrow(/GET/);
    expect(() =>
      buildToolRequest(tool({ extract: "a.b", response: { mode: "text" } }), {}, ENV),
    ).toThrow(/extract/);
  });
});

describe("callHttpTool -- response modes and secret hygiene", () => {
  it("reads a text response as a string (a diff is not JSON)", async () => {
    const fetchImpl = vi.fn(async () => new Response("diff --git a/x b/x", { status: 200 }));

    const result = await callHttpTool(tool({ response: { mode: "text" } }), {}, { fetchImpl });

    expect(result).toBe("diff --git a/x b/x");
  });

  it("returns a bytes response base64-encoded", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0, 1, 2, 255])));

    const result = await callHttpTool(tool({ response: { mode: "bytes" } }), {}, { fetchImpl });

    expect(result).toBe(Buffer.from([0, 1, 2, 255]).toString("base64"));
  });

  it("sends the built headers, body and method to fetch", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init!);
      return new Response("{}", { status: 200 });
    });

    await callHttpTool(
      tool({
        method: "POST",
        headers: { Authorization: "Bearer ${API_TOKEN}" },
        body: { json: { a: 1 } },
      }),
      {},
      { fetchImpl, env: ENV },
    );

    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(seen[0]?.headers).toMatchObject({ Authorization: "Bearer tok-123" });
  });

  it("redacts a query-string secret from error messages (non-ok and network failure)", async () => {
    const notOk = vi.fn(async () => new Response("no", { status: 429, statusText: "Too Many" }));
    const down = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED https://api.example.test/v1/data?apikey=key-456");
    });
    const t = tool({ query: { apikey: "${ALPHA_KEY}" } });

    const a = await callHttpTool(t, {}, { fetchImpl: notOk, env: ENV }).catch((e: Error) => e);
    const b = await callHttpTool(t, {}, { fetchImpl: down, env: ENV }).catch((e: Error) => e);

    for (const error of [a, b]) {
      expect((error as Error).message).not.toContain("key-456");
      expect((error as Error).message).toContain("[REDACTED]");
    }
  });
});

describe("fixtures -- response modes and rotated secrets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-v2-fixtures-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function roundTrip(response: () => Response, t: HttpTool) {
    const inner = (async () => response()) as unknown as typeof fetch;
    const record = createFixtureFetch({ mode: "record", fixturesDir: dir, fetchImpl: inner });
    const live = await callHttpTool(t, {}, { fetchImpl: record, env: ENV });
    const replay = createFixtureFetch({ mode: "replay", fixturesDir: dir });
    const replayed = await callHttpTool(t, {}, { fetchImpl: replay, env: ENV });
    return { live, replayed };
  }

  it("replays a text response exactly, including JSON-looking text with its own whitespace", async () => {
    const text = '{ "a" :   1 }\n';
    const { live, replayed } = await roundTrip(
      () => new Response(text, { headers: { "content-type": "text/plain" } }),
      tool({ response: { mode: "text" } }),
    );

    expect(live).toBe(text);
    expect(replayed).toBe(text);
  });

  it("replays a binary response byte for byte", async () => {
    const { live, replayed } = await roundTrip(
      () => new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x80])),
      tool({ response: { mode: "bytes" } }),
    );

    expect(replayed).toBe(live);
  });

  it("still replays fixtures recorded before raw bodies existed (JSON from `body`)", async () => {
    const { live, replayed } = await roundTrip(
      () => new Response(JSON.stringify({ ok: true })),
      tool({ extract: "ok" }),
    );

    expect(live).toBe(true);
    expect(replayed).toBe(true);
  });

  it("finds the same fixture after a query-string secret is rotated", async () => {
    const t = tool({ query: { apikey: "${ALPHA_KEY}" } });
    const inner = (async () => new Response(JSON.stringify({ v: 1 }))) as unknown as typeof fetch;
    const record = createFixtureFetch({
      mode: "record",
      fixturesDir: dir,
      fetchImpl: inner,
      secrets: ["key-456"],
    });
    await callHttpTool(t, {}, { fetchImpl: record, env: ENV });

    const rotated = { ...ENV, ALPHA_KEY: "key-NEW" } as NodeJS.ProcessEnv;
    const replay = createFixtureFetch({ mode: "replay", fixturesDir: dir, secrets: ["key-NEW"] });
    const result = await callHttpTool(t, {}, { fetchImpl: replay, env: rotated });

    expect(result).toEqual({ v: 1 });
  });
});
