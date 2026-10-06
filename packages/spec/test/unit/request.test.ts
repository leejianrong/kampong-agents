import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/parse.js";

// KAN-1845 (ADR-0029): the shared request description on `http_request`.

function specWithTool(toolYaml: string): string {
  return `version: "1.0"
agent:
  id: caller
  name: "Caller"
  role: "Fetcher"
  goal: "Call an API."
  tools:
${toolYaml
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
  workflow:
    - step: fetch
      type: tool
      tool: call
`;
}

function parse(toolYaml: string) {
  return parseSpec(specWithTool(toolYaml));
}

const BASE = `- name: call
  action: http_request
  method: GET
  url: "https://api.example.test/v1/data"`;

describe("http_request request fields", () => {
  it("still accepts the original shape with none of the new fields", () => {
    expect(parse(BASE).success).toBe(true);
  });

  it("accepts headers, query, a json body and a response mode together", () => {
    const result = parse(`- name: call
  action: http_request
  method: POST
  url: "https://api.example.test/v1/data"
  headers:
    Authorization: "Bearer \${API_TOKEN}"
    Accept: application/json
  query:
    function: TIME_SERIES_DAILY
    apikey: "\${ALPHAVANTAGE_KEY}"
  body:
    json:
      symbol: "{{ input }}"
  response:
    mode: json`);

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("accepts form and raw bodies and text/bytes response modes", () => {
    expect(
      parse(`- name: call
  action: http_request
  method: POST
  url: "https://api.example.test/form"
  body:
    form:
      a: "1"
  response:
    mode: text`).success,
    ).toBe(true);
    expect(
      parse(`- name: call
  action: http_request
  method: PUT
  url: "https://api.example.test/raw"
  body:
    raw: "hello"
    content_type: text/plain
  response:
    mode: bytes`).success,
    ).toBe(true);
  });

  it("rejects a literal secret in a credential-looking header", () => {
    const result = parse(`${BASE}
  headers:
    Authorization: "Bearer sk-live-literal"`);

    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join(" ")).toMatch(/looks like a credential/);
  });

  it("rejects a literal secret in a credential-looking query parameter", () => {
    const result = parse(`${BASE}
  query:
    api_key: "literal-key"`);

    expect(result.success).toBe(false);
  });

  it("does not flag ordinary headers and query parameters", () => {
    expect(
      parse(`${BASE}
  headers:
    Accept: application/vnd.github.diff
  query:
    keyword: shoes
    symbol: IBM`).success,
    ).toBe(true);
  });

  it("rejects a body that names two encodings", () => {
    expect(
      parse(`${BASE}
  body:
    json: {}
    form: {}`).success,
    ).toBe(false);
  });

  it("rejects an unknown response mode and an invalid header name", () => {
    expect(
      parse(`${BASE}
  response:
    mode: xml`).success,
    ).toBe(false);
    expect(
      parse(`${BASE}
  headers:
    "bad header": x`).success,
    ).toBe(false);
  });

  it("flags real credentials but not look-alike parameters (review finding)", () => {
    expect(
      parse(`${BASE}
  headers:
    Idempotency-Key: "{{ input }}"
    X-Request-Id: "{{ input }}"
  query:
    author: Tolkien
    sort_key: price
    oauth_version: "1.0"`).success,
    ).toBe(true);
    expect(
      parse(`${BASE}
  headers:
    X-API-Key: literal`).success,
    ).toBe(false);
    expect(
      parse(`${BASE}
  query:
    key: literal`).success,
    ).toBe(false);
  });

  it("rejects a GET with a body at validation time", () => {
    const result = parse(`${BASE}
  body:
    raw: "x"`);

    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join(" ")).toMatch(/GET request cannot send a body/);
  });

  it("rejects extract on a non-json response at validation time", () => {
    const result = parse(`- name: call
  action: http_request
  method: GET
  url: "https://api.example.test/x"
  extract: a.b
  response:
    mode: text`);

    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join(" ")).toMatch(/extract only applies/);
  });
});
