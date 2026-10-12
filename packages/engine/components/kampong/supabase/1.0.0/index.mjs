// kampong/supabase: insert, upsert, select and rpc over a project's PostgREST API (ADR-0044).
//
// A module rather than a manifest because a request template cannot send an array as the whole body, build
// a query string whose parameter names come from the input (PostgREST filters are `column=op.value`), or
// read the error body of a non-2xx answer. It sees only `ctx`: the project URL and the key come from two
// declared slots, and the only hosts it can reach are a project's own `<ref>.supabase.co`.

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_$.]*$/;
const PROJECT_HOST = /^[a-z0-9-]+\.supabase\.co$/;
const ORDER_TERM = "[A-Za-z_][A-Za-z0-9_$.]*(?:\\.(?:asc|desc))?(?:\\.(?:nullsfirst|nullslast))?";
const ORDER = new RegExp(`^${ORDER_TERM}(?:,${ORDER_TERM})*$`);
const CONFLICT = /^[A-Za-z_][A-Za-z0-9_$]*(,[A-Za-z_][A-Za-z0-9_$]*)*$/;
const DEFAULT_LIMIT = 100;

export async function invoke(op, input, ctx) {
  switch (op) {
    case "check_key": {
      await request(ctx, "GET", "/auth/v1/settings");
      return { ok: true };
    }
    case "insert":
      return write(ctx, input, [], [`return=${returning(input)}`]);
    case "upsert": {
      if (typeof input.on_conflict !== "string" || !CONFLICT.test(input.on_conflict)) {
        throw new Error(
          "on_conflict must be a column name, or comma-separated column names, with no spaces",
        );
      }
      // merge-duplicates updates the existing row; ignore-duplicates leaves it and skips the new one.
      const resolution = input.on_duplicate === "ignore" ? "ignore-duplicates" : "merge-duplicates";
      return write(
        ctx,
        input,
        [["on_conflict", input.on_conflict]],
        [`resolution=${resolution}`, `return=${returning(input)}`],
      );
    }
    case "select":
      return select(ctx, input);
    case "rpc":
      return rpc(ctx, input);
    default:
      throw new Error(`kampong/supabase has no op "${op}"`);
  }
}

async function write(ctx, input, query, prefer) {
  const rows = input.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("rows must be a non-empty array of objects");
  }
  if (!rows.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
    throw new Error("every entry of rows must be an object");
  }
  const response = await request(ctx, "POST", `/rest/v1/${ident(input.table, "table")}`, {
    query,
    body: rows,
    prefer,
    schemaHeader: ["Content-Profile", input.schema],
  });
  const text = await response.text();
  // return=minimal answers 201 with no body; return=representation echoes the rows.
  return { count: rows.length, rows: text.trim() === "" ? [] : parse(text) };
}

async function select(ctx, input) {
  const query = [["select", columns(input.columns)]];
  for (const [column, expression] of Object.entries(input.filter ?? {})) {
    if (!COLUMN.test(column) && column !== "or" && column !== "and") {
      throw new Error(`filter column "${column}" is not a column name`);
    }
    for (const value of Array.isArray(expression) ? expression : [expression]) {
      query.push([column, filterValue(column, value)]);
    }
  }
  if (input.order !== undefined) {
    if (typeof input.order !== "string" || !ORDER.test(input.order)) {
      throw new Error('order must look like "created_at.desc" (comma-separated for more than one)');
    }
    query.push(["order", input.order]);
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  query.push(["limit", String(whole(limit, "limit", 1))]);
  if (input.offset !== undefined) query.push(["offset", String(whole(input.offset, "offset", 0))]);
  const response = await request(ctx, "GET", `/rest/v1/${ident(input.table, "table")}`, {
    query,
    schemaHeader: ["Accept-Profile", input.schema],
  });
  const rows = parse(await response.text());
  if (!Array.isArray(rows)) {
    throw new Error("Supabase returned a select result that is not an array");
  }
  // A full page may have been cut by the limit (or the project's max-rows): say so rather than imply it is all.
  return { rows, count: rows.length, truncated: rows.length >= limit };
}

async function rpc(ctx, input) {
  const args = input.args ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("args must be an object of named arguments");
  }
  const response = await request(ctx, "POST", `/rest/v1/rpc/${ident(input.name, "name")}`, {
    body: args,
    schemaHeader: ["Content-Profile", input.schema],
  });
  const text = await response.text();
  return { result: text.trim() === "" ? null : parse(text) };
}

// A filter written as "eq.open" is already an operator expression; a bare number, boolean or null means equals.
function filterValue(column, value) {
  if (typeof value === "string") return value;
  if (value === null) return "is.null";
  if (typeof value === "number" || typeof value === "boolean") return `eq.${value}`;
  throw new Error(
    `filter "${column}" must be a PostgREST expression such as "eq.open", or a number or boolean`,
  );
}

function columns(value) {
  if (value === undefined) return "*";
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("columns must be a non-empty string");
  }
  return value;
}

function returning(input) {
  return input.returning === "representation" ? "representation" : "minimal";
}

function ident(value, field) {
  if (typeof value !== "string" || !IDENT.test(value)) {
    throw new Error(`${field} must be a plain identifier (letters, digits, underscore)`);
  }
  return value;
}

function whole(value, field, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be a whole number of at least ${min}`);
  }
  return value;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Supabase returned a response that is not JSON");
  }
}

// The project's base URL, from the slot: https://<ref>.supabase.co and nothing else, so a mistyped or
// hostile value cannot point the key at another host (the engine's egress check says the same).
function base(ctx) {
  const raw = ctx.secrets.get("url");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the project URL is not a URL; expected https://<project-ref>.supabase.co");
  }
  if (url.protocol !== "https:" || !PROJECT_HOST.test(url.hostname) || url.port !== "") {
    throw new Error("the project URL must be https://<project-ref>.supabase.co");
  }
  return url.origin;
}

async function request(ctx, method, path, options = {}) {
  const { query = [], body, prefer = [], schemaHeader } = options;
  const origin = base(ctx);
  const search = new URLSearchParams(query).toString();
  const response = await ctx.fetch(`${origin}${path}${search ? `?${search}` : ""}`, {
    method,
    headers: {
      Accept: "application/json",
      apikey: ctx.secrets.get("key"),
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...(prefer.length > 0 && { Prefer: prefer.join(",") }),
      ...(schemaHeader?.[1] !== undefined && {
        [schemaHeader[0]]: ident(schemaHeader[1], "schema"),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: ctx.signal,
  });
  if (!response.ok) {
    // `status` lets `kampong doctor` tell a refused key (401) from a service that is down, and lets a
    // recorded failure replay. The runner scrubs any secret from the message.
    const retryAfter = Number(response.headers.get("retry-after"));
    throw Object.assign(new Error(await describeFailure(response)), {
      status: response.status,
      ...(response.headers.has("retry-after") && Number.isFinite(retryAfter) && retryAfter >= 0
        ? { retryAfterMs: retryAfter * 1000 }
        : {}),
    });
  }
  return response;
}

// What a person can do about the PostgREST and Postgres codes most often seen. The code and message are
// always reported as well, so an unlisted code still says what the server said.
const ADVICE = {
  23505: "a row with this key already exists; use upsert to update it",
  23503: "a foreign key points at a row that does not exist",
  23502: "a required column has no value",
  23514: "a check constraint refused the value",
  "22P02": "a value is not valid for its column type",
  42501:
    "refused by permissions or row-level security; check the key's role and the table's policies",
  "42P01": "no such table or view",
  42703: "no such column",
  PGRST100: "the filter or query string could not be parsed",
  PGRST102: "the request body could not be parsed",
  PGRST116: "the result did not have exactly one row",
  PGRST202: "no such function, or its argument names do not match",
  PGRST204: "a column in the body does not exist on the table",
  PGRST205: "no such table in the schema cache; check the name and that the schema is exposed",
  PGRST301: "the key is not accepted (JWT problem)",
  PGRST303: "the key is not accepted (JWT claims)",
};

// PostgREST answers errors as { code, message, details, hint }.
async function describeFailure(response) {
  const parts = [];
  try {
    const body = JSON.parse(await response.text());
    const head = [body.code, body.message]
      .filter((p) => typeof p === "string" && p !== "")
      .join(" ");
    if (head) parts.push(head);
    if (typeof body.details === "string" && body.details) parts.push(`details: ${body.details}`);
    if (typeof body.hint === "string" && body.hint) parts.push(`hint: ${body.hint}`);
    const advice = typeof body.code === "string" ? ADVICE[body.code] : undefined;
    if (advice) parts.push(advice);
  } catch {
    // Not JSON (a gateway error page): report the status alone.
  }
  const detail = parts.join("; ").slice(0, 600);
  // Redirects are not followed (they could carry the key to another host), so say where it went.
  const location =
    response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
  const moved = location ? `; moved to ${location.slice(0, 200)}` : "";
  return `Supabase returned HTTP ${response.status}${detail ? ` (${detail})` : ""}${moved}`;
}
