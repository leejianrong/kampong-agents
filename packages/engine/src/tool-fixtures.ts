import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolFetchImpl } from "./http-tool.js";
import { mapStringsDeep, redactString } from "./redact.js";

// Mock/record tool layer (PLAN.md Shape S4, SLICES.md V3 KAN-1111; Q17:
// plain files, no DB, for this storage). Wraps the `fetchImpl` seam
// `callHttpTool` already threads through `EngineDeps` (workflow.ts) --
// `callHttpTool` is the ONLY caller of `fetchImpl` in this package, and (see
// http-tool.ts) it now passes the tool's name as an explicit third
// `ToolContext` argument on every call, specifically so this wrapper can key
// a fixture on {tool name, method, substituted URL} -- the exact bar
// SLICES.md's integration test plan sets ("recording a tool call once and
// replaying it in mock mode produces identical results across multiple
// replay runs") -- with zero changes to workflow.ts's call site.
//
// The tool name travels as a plain function argument, never as an HTTP
// header: an AgentSpec tool name is an unrestricted, author-controlled
// string, and stamping it onto a real outgoing request risked a
// Headers/ByteString `TypeError` on live calls (a newline or non-Latin1
// character) as well as leaking an internal implementation detail to
// third-party endpoints that never asked for it (finding #1).
//
// Three modes:
//  - "live" (default elsewhere in the engine: simply don't use this file):
//    passthrough to the real fetch, unchanged from pre-V3 behavior.
//  - "record": makes the real call, then persists a fixture to disk.
//  - "replay": never touches the network; a fixture miss is a specific,
//    actionable MissingFixtureError, never a silent fallback to a live call
//    (AGENTS.md/ADR-0004's fail-visibly convention applies here too, not
//    just to the model-call path).
//
// SECURITY (see AGENTS.md's BYOK convention): a tool as defined by
// schema.ts's `toolSchema` has no auth-header field -- `callHttpTool` sends
// no `Authorization` header today -- so nothing is silently dropped by not
// recording request headers here. What CAN legitimately leak onto disk is a
// `${ENV_VAR}`-resolved secret value that happens to appear inside the
// substituted URL (e.g. an API key baked into a query string) or inside the
// response body itself. `secrets` is the caller-supplied list of resolved
// values (e.g. every BYOK env var value currently in play) to scrub from
// anything this module writes to disk, so a fixture is always safe to
// commit even if a tool URL was written carelessly.

export type ToolFixtureMode = "live" | "record" | "replay";

export interface CreateFixtureFetchOptions {
  mode: ToolFixtureMode;
  /** Directory fixture files are read from / written to (plain JSON files, Q17). */
  fixturesDir: string;
  /** The real fetch to delegate to in "live"/"record" modes. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Literal secret values to redact from anything persisted to a fixture file. */
  secrets?: string[];
}

export class MissingFixtureError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly fixturePath: string,
    hasRequestBody = false,
  ) {
    super(
      `No recorded fixture for tool "${toolName}" at ${fixturePath}. Run once with tool mode ` +
        `"record" (against a live network) to create it before replaying in "replay" mode -- ` +
        `mock mode never falls back to a live call.` +
        (hasRequestBody
          ? ` The request body is part of the fixture key, so a fixture recorded with a ` +
            `different body (or before bodies were keyed) needs re-recording.`
          : ""),
    );
    this.name = "MissingFixtureError";
  }
}

interface FixtureFile {
  toolName: string;
  method: string;
  url: string;
  /** Normalised (redacted, canonical-JSON) request body; absent for body-less requests. */
  requestBody?: string;
  status: number;
  body: unknown;
  /**
   * The exact response payload (KAN-1845), so text and binary responses replay byte for byte.
   * Absent in fixtures recorded before response modes existed, which replay from `body` as JSON.
   */
  bodyRaw?: string;
  bodyFormat?: "utf8" | "base64";
  contentType?: string;
}

/** JSON with object keys sorted at every depth, so key order never changes a request's identity. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The request body as it is keyed and persisted: secrets redacted first (so a rotated secret still
 * finds its fixture), and a JSON body canonicalised (so key order and whitespace don't matter).
 * `undefined` for a request with no body. A body type we can't key faithfully is an error, never a
 * silent collision on "[object Object]".
 */
function normalizedBody(body: RequestInit["body"], secrets: readonly string[]): string | undefined {
  if (body === undefined || body === null) return undefined;
  let text: string;
  if (typeof body === "string") text = body;
  else if (body instanceof URLSearchParams) text = body.toString();
  else {
    throw new Error(
      "Fixture mock/record layer can only key string or URLSearchParams request bodies; " +
        `got ${Object.prototype.toString.call(body)}.`,
    );
  }
  if (text === "") return undefined;
  const redacted = redactString(text, secrets);
  try {
    return canonicalJson(JSON.parse(redacted));
  } catch {
    return redacted;
  }
}

/**
 * The fixture key: tool name + method + the already-*substituted* URL
 * (params, e.g. `{charge_id}`, vary run to run -- the substituted URL is
 * what's actually deterministic across replays of "the same recorded
 * scenario", per SLICES.md's phrasing) + a hash of the normalised request
 * body when there is one (KAN-1829: two POSTs to one URL, e.g. Slack
 * `chat.postMessage`, must not share a fixture). A request with no body
 * keeps the original key, so fixtures recorded before this change still
 * replay. Hashed rather than used verbatim as a filename since a URL can
 * contain characters that aren't safe/portable as a path segment.
 */
function fixtureKey(toolName: string, method: string, url: string, body?: string): string {
  const bodyPart = body === undefined ? "" : `::${createHash("sha256").update(body).digest("hex")}`;
  return createHash("sha256")
    .update(`${toolName}::${method}::${url}${bodyPart}`)
    .digest("hex")
    .slice(0, 16);
}

/** The start of every fixture file name for a tool (`<safe name>.`); `kampong doctor` looks for it. */
export function fixtureFilePrefix(toolName: string): string {
  return `${toolName.replace(/[^A-Za-z0-9_-]/g, "_") || "tool"}.`;
}

function fixturePathFor(
  fixturesDir: string,
  toolName: string,
  method: string,
  url: string,
  body?: string,
): string {
  return join(
    fixturesDir,
    `${fixtureFilePrefix(toolName)}${fixtureKey(toolName, method, url, body)}.json`,
  );
}

/**
 * Builds a `fetchImpl`-compatible function (drop-in for `EngineDeps.fetchImpl`
 * / `HttpToolCallOptions.fetchImpl`) implementing the mode above. Callers
 * only need this at all for "record"/"replay" -- "live" mode is provided
 * for completeness/direct testing, but the CLI (KAN-1110) simply omits
 * `fetchImpl` entirely (falling back to `callHttpTool`'s own `fetch`
 * default) when the user hasn't asked for mock/record.
 */
export function createFixtureFetch(options: CreateFixtureFetchOptions): ToolFetchImpl {
  const { mode, fixturesDir, fetchImpl = fetch, secrets: configuredSecrets = [] } = options;

  const wrapped: ToolFetchImpl = async (input, init, context) => {
    if (mode === "live") {
      return fetchImpl(input, init);
    }

    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const toolName = context.toolName;
    // Secrets the caller configured plus the ones this very request carries (KAN-1845), so a
    // query-string or header credential is redacted without the CLI having to enumerate it.
    const secrets = [...configuredSecrets, ...(context.secrets ?? [])];
    const requestBody = normalizedBody(init?.body, secrets);
    // Keyed on the redacted URL so a rotated query-string secret still finds its fixture.
    const path = fixturePathFor(
      fixturesDir,
      toolName,
      method,
      redactString(url, secrets),
      requestBody,
    );

    if (mode === "replay") {
      if (!existsSync(path)) {
        throw new MissingFixtureError(toolName, path, requestBody !== undefined);
      }
      const fixture = JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
      const headers = { "content-type": fixture.contentType ?? "application/json" };
      if (fixture.bodyRaw !== undefined) {
        const payload =
          fixture.bodyFormat === "base64"
            ? Buffer.from(fixture.bodyRaw, "base64")
            : fixture.bodyRaw;
        // 101/204/205/304 cannot carry a body; the Response constructor throws if given one.
        const noBody = [101, 204, 205, 304].includes(fixture.status);
        return new Response(noBody ? null : payload, { status: fixture.status, headers });
      }
      return new Response(JSON.stringify(fixture.body), { status: fixture.status, headers });
    }

    // mode === "record"
    const response = await fetchImpl(input, init);
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    let bodyRaw: string;
    let bodyFormat: "utf8" | "base64";
    let body: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      bodyRaw = redactString(text, secrets);
      bodyFormat = "utf8";
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } catch {
      // Not valid UTF-8 (a binary payload): keep the exact bytes. A secret cannot be redacted out
      // of base64, so a binary response must never be recorded from an endpoint that echoes one.
      bodyRaw = bytes.toString("base64");
      bodyFormat = "base64";
      body = null;
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    const fixture: FixtureFile = {
      toolName,
      method,
      url: redactString(url, secrets),
      ...(requestBody === undefined ? {} : { requestBody }),
      status: response.status,
      body: mapStringsDeep(body, (text) => redactString(text, secrets)),
      bodyRaw,
      bodyFormat,
      ...(contentType === undefined ? {} : { contentType }),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    return response;
  };

  return wrapped;
}
