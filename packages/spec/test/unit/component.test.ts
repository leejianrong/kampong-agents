import { describe, expect, it } from "vitest";
import { parseComponentManifest } from "../../src/component.js";

// KAN-1832 part A (ADR-0029): the connector manifest schema and its lint.

export const SLACK_MANIFEST = `kind: rest
id: kampong/slack
version: 0.1.0
license: Apache-2.0
permissions:
  egress: [slack.com]
auth:
  slots:
    token:
      env: SLACK_BOT_TOKEN
      hosts: [slack.com]
      inject: { header: Authorization, template: "Bearer {{ secret }}" }
ops:
  post_message:
    title: Post a message
    effect: write
    input:
      type: object
      required: [channel, text]
      properties:
        channel: { type: string, title: Channel, description: "ID or #name" }
        text: { type: string, title: Message, format: multiline }
    request:
      method: POST
      url: https://slack.com/api/chat.postMessage
      body:
        json: { channel: "{{ input.channel }}", text: "{{ input.text }}" }
    response: { mode: json }
    failure_when:
      - { path: ok, equals: false, message_path: error }
    output:
      type: object
      properties: { ts: { type: string }, channel: { type: string } }
    pace: { rps: 1 }
    retry: { max: 3, backoff: exponential }
`;

const MODULE_MANIFEST = `kind: module
id: kampong/gmail-imap
version: 0.1.0
entry: ./index.ts
deps: { imapflow: "1.0.0", mailparser: "3.7.0" }
permissions: { egress: ["imap.gmail.com:993"] }
auth:
  slots:
    user: { env: GMAIL_USER, hosts: ["imap.gmail.com:993"] }
    password: { env: GMAIL_APP_PASSWORD, hosts: ["imap.gmail.com:993"] }
ops:
  list_unseen:
    effect: read
    input: { type: object, properties: { limit: { type: integer, default: 20, minimum: 1 } } }
    output: { type: array, items: { type: object } }
`;

function messages(result: ReturnType<typeof parseComponentManifest>): string {
  return result.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("\n");
}

describe("parseComponentManifest -- valid manifests", () => {
  it("accepts the Slack post_message manifest from the design note", () => {
    const result = parseComponentManifest(SLACK_MANIFEST);

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.manifest?.kind).toBe("rest");
    expect(result.manifest?.ops.post_message?.effect).toBe("write");
  });

  it("accepts a module manifest", () => {
    const result = parseComponentManifest(MODULE_MANIFEST);

    expect(result.errors).toEqual([]);
    expect(result.manifest?.kind).toBe("module");
  });

  it("accepts config-dependent hosts and a config declaration", () => {
    const result = parseComponentManifest(`kind: rest
id: kampong/supabase
version: 0.1.0
permissions: { egress: ["{{ config.project }}.supabase.co"] }
config:
  project: { type: string, title: Project ref, pattern: "^[a-z0-9]{20}$" }
auth:
  slots:
    key:
      env: SUPABASE_KEY
      hosts: ["{{ config.project }}.supabase.co"]
      inject: { header: apikey, template: "{{ secret }}" }
ops:
  select:
    effect: read
    input: { type: object, required: [table], properties: { table: { type: string } } }
    request:
      method: GET
      url: "https://{{ config.project }}.supabase.co/rest/v1/{{ input.table }}"
`);

    expect(result.errors).toEqual([]);
  });

  it("accepts a third-party reverse-DNS namespace and a prerelease version", () => {
    const result = parseComponentManifest(
      SLACK_MANIFEST.replace("kampong/slack", "com.acme/slack-fork").replace(
        "0.1.0",
        "1.2.3-beta.1",
      ),
    );

    expect(result.errors).toEqual([]);
  });
});

describe("parseComponentManifest -- rejects", () => {
  const bad = (edit: (s: string) => string) => parseComponentManifest(edit(SLACK_MANIFEST));

  it("a malformed id and a non-exact version", () => {
    expect(bad((s) => s.replace("kampong/slack", "Slack")).success).toBe(false);
    expect(bad((s) => s.replace("version: 0.1.0", 'version: "^0.1.0"')).success).toBe(false);
    expect(bad((s) => s.replace("version: 0.1.0", "version: 1.0")).success).toBe(false);
  });

  it("an unknown kind and an unknown top-level key", () => {
    expect(bad((s) => s.replace("kind: rest", "kind: wasm")).success).toBe(false);
    expect(bad((s) => `${s}surprise: true\n`).success).toBe(false);
  });

  it("an unknown effect", () => {
    expect(bad((s) => s.replace("effect: write", "effect: nuke")).success).toBe(false);
  });

  it("a template that refers to an undeclared input", () => {
    const result = bad((s) => s.replace("{{ input.text }}", "{{ input.txt }}"));

    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/input\.txt/);
  });

  it("a template that refers to an undeclared config key", () => {
    const result = bad((s) => s.replace("slack.com/api", "{{ config.region }}.slack.com/api"));

    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/config\.region/);
  });

  it("{{ secret }} anywhere outside an auth inject template", () => {
    const result = bad((s) => s.replace("{{ input.text }}", "{{ secret }}"));

    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/secret/);
  });

  it("an inject template with no {{ secret }}, and one that names both header and query", () => {
    expect(bad((s) => s.replace('"Bearer {{ secret }}"', '"Bearer abc"')).success).toBe(false);
    expect(
      bad((s) => s.replace("{ header: Authorization,", "{ header: Authorization, query: k,"))
        .success,
    ).toBe(false);
  });

  it("a ${ENV} placeholder inside a request: manifests take secrets through slots only", () => {
    const result = bad((s) => s.replace("{{ input.channel }}", "${SLACK_BOT_TOKEN}"));

    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/slot/i);
  });

  it("a literal credential header in a request", () => {
    const result = bad((s) =>
      s.replace("      body:", "      headers: { Authorization: literal }\n      body:"),
    );

    expect(result.success).toBe(false);
  });

  it("failure_when on a non-json response, and a bad output schema type", () => {
    expect(
      bad((s) => s.replace("response: { mode: json }", "response: { mode: text }")).success,
    ).toBe(false);
    expect(bad((s) => s.replace("{ ts: { type: string }", "{ ts: { type: date }")).success).toBe(
      false,
    );
  });

  it("an input schema keyword outside the supported subset", () => {
    const result = bad((s) => s.replace("format: multiline", "oneOf: []"));

    expect(result.success).toBe(false);
  });

  it("a required property that is not declared", () => {
    expect(
      bad((s) => s.replace("required: [channel, text]", "required: [channel, nope]")).success,
    ).toBe(false);
  });

  it("an egress entry that is a URL, a bare wildcard, or has a mid-host wildcard", () => {
    for (const entry of ["https://slack.com", "*", "sl*ck.com"]) {
      expect(bad((s) => s.replace("egress: [slack.com]", `egress: ["${entry}"]`)).success).toBe(
        false,
      );
    }
  });

  it("a rest component with no permissions block", () => {
    const result = bad((s) => s.replace("permissions:\n  egress: [slack.com]\n", ""));

    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/permissions\.egress/);
  });

  it("an empty op set", () => {
    expect(parseComponentManifest("kind: rest\nid: a/b\nversion: 0.1.0\nops: {}\n").success).toBe(
      false,
    );
  });
});

describe("parseComponentManifest -- module rules", () => {
  const bad = (edit: (s: string) => string) => parseComponentManifest(edit(MODULE_MANIFEST));

  it("rejects a dependency that is a range, a tag, a URL or a path", () => {
    for (const spec of ['"^1.0.0"', '"latest"', '"github:a/b"', '"file:../x"', '"~1.2.3"']) {
      expect(bad((s) => s.replace('imapflow: "1.0.0"', `imapflow: ${spec}`)).success).toBe(false);
    }
  });

  it("rejects an entry that escapes the component directory or is absolute", () => {
    expect(bad((s) => s.replace("./index.ts", "../evil.ts")).success).toBe(false);
    expect(bad((s) => s.replace("./index.ts", "/etc/passwd")).success).toBe(false);
  });

  it("rejects a module op that carries a request description", () => {
    expect(
      bad((s) =>
        s.replace(
          "    effect: read",
          "    request: { method: GET, url: https://x.test }\n    effect: read",
        ),
      ).success,
    ).toBe(false);
  });
});

describe("parseComponentManifest -- syntax errors", () => {
  it("reports a YAML syntax error with a line number instead of throwing", () => {
    const result = parseComponentManifest("kind: rest\nid: [unterminated\n");

    expect(result.success).toBe(false);
    expect(result.errors[0]?.line).toBeGreaterThan(0);
  });
});

// ---- Review findings on PR #90 ---------------------------------------------------------------------

describe("parseComponentManifest -- review findings", () => {
  const bad = (edit: (s: string) => string) => parseComponentManifest(edit(SLACK_MANIFEST));
  const ok = (edit: (s: string) => string) => parseComponentManifest(edit(SLACK_MANIFEST));

  it("rejects a wildcard over a bare public suffix, but accepts a real domain wildcard", () => {
    const wide = (host: string) => (s: string) =>
      s
        .replace("egress: [slack.com]", `egress: ["${host}"]`)
        .replace("hosts: [slack.com]", `hosts: ["${host}"]`);

    expect(bad(wide("*.com")).success).toBe(false);
    expect(
      ok((s) => wide("*.slack.com")(s).replace("https://slack.com/", "https://api.slack.com/"))
        .errors,
    ).toEqual([]);
  });

  it("rejects an inject slot whose host is not covered by permissions.egress", () => {
    const result = bad((s) => s.replace("hosts: [slack.com]", "hosts: [files.slack.com]"));

    expect(result.success).toBe(false);
    expect(messages(result)).toMatch(/not covered by permissions\.egress/);
  });

  it("rejects two slots that inject the same header, and a request header an injected slot would overwrite", () => {
    const twoSlots = (s: string) =>
      s.replace(
        "ops:",
        '    other:\n      env: OTHER\n      hosts: [slack.com]\n      inject: { header: authorization, template: "{{ secret }}" }\nops:',
      );
    expect(bad(twoSlots).success).toBe(false);
    expect(messages(bad(twoSlots))).toMatch(/both inject header authorization/);

    const clash = bad((s) =>
      s.replace("      body:", '      headers: { AUTHORIZATION: "{{ input.text }}" }\n      body:'),
    );
    expect(clash.success).toBe(false);
  });

  it("lets an op name the slots it uses, and rejects an unknown or non-injecting one", () => {
    const two = (s: string) =>
      s.replace(
        "ops:",
        '    other:\n      env: OTHER\n      hosts: [slack.com]\n      inject: { header: X-Other, template: "{{ secret }}" }\nops:',
      );
    expect(
      parseComponentManifest(
        two(SLACK_MANIFEST).replace("    effect: write", "    slots: [token]\n    effect: write"),
      ).errors,
    ).toEqual([]);
    expect(
      bad((s) => s.replace("    effect: write", "    slots: [nope]\n    effect: write")).success,
    ).toBe(false);
  });

  it("enforces one reference grammar: malformed, nested, filtered, unbalanced and misplaced references", () => {
    const withText = (text: string) => (s: string) => s.replace("{{ input.text }}", text);

    for (const text of [
      "{{ input.a.b }}",
      "{{input.text | upper}}",
      "{{ input.text",
      "{{ foo }}",
      "{{ }}",
    ]) {
      expect(bad(withText(text)).success, text).toBe(false);
    }
    expect(ok(withText("{{input.text}}")).errors).toEqual([]);
  });

  it("allows only {{ secret }} in an inject template (not config or input), with or without spaces", () => {
    expect(ok((s) => s.replace('"Bearer {{ secret }}"', '"Bearer {{secret}}"')).errors).toEqual([]);
    expect(
      bad((s) => s.replace('"Bearer {{ secret }}"', '"Bearer {{ secret }} {{ input.text }}"'))
        .success,
    ).toBe(false);
  });

  it("rejects references in header names and JSON keys, which are never rendered", () => {
    expect(
      bad((s) =>
        s.replace("        json: { channel:", '        json: { "{{ input.text }}": 1, channel:'),
      ).success,
    ).toBe(false);
    expect(
      bad((s) =>
        s.replace("      body:", '      headers: { "X-{{ input.text }}": a }\n      body:'),
      ).success,
    ).toBe(false);
  });

  it("validates a config pattern as a regex, and that a default satisfies it", () => {
    const cfg = (param: string) =>
      `kind: rest
id: a/b
version: 0.1.0
permissions: { egress: ["{{ config.p }}.test"] }
config:
  p: ${param}
ops:
  o: { effect: read, request: { method: GET, url: "https://{{ config.p }}.test/x" } }
`;

    expect(parseComponentManifest(cfg('{ type: string, pattern: "(" }')).success).toBe(false);
    expect(
      parseComponentManifest(cfg('{ type: string, pattern: "[a-z]+", default: "A1" }')).success,
    ).toBe(false);
    expect(
      parseComponentManifest(cfg('{ type: string, pattern: "[a-z]+", default: "abc" }')).errors,
    ).toEqual([]);
  });

  it("rejects a schema default or enum value that does not fit its declared type", () => {
    const input = (prop: string) =>
      SLACK_MANIFEST.replace(
        "text: { type: string, title: Message, format: multiline }",
        `text: ${prop}`,
      );

    expect(parseComponentManifest(input("{ type: number, default: ten }")).success).toBe(false);
    expect(parseComponentManifest(input("{ type: integer, default: 1.5 }")).success).toBe(false);
    expect(parseComponentManifest(input("{ type: string, enum: [a, 2] }")).success).toBe(false);
    expect(parseComponentManifest(input("{ type: number, default: 10 }")).errors).toEqual([]);
  });

  it("validates dependency names as plain npm names, and accepts exact prerelease pins", () => {
    const mod = (deps: string) =>
      `kind: module
id: a/m
version: 0.1.0
entry: ./index.ts
deps: ${deps}
ops: { o: { effect: read } }
`;

    expect(parseComponentManifest(mod('{ "../../evil": "1.0.0" }')).success).toBe(false);
    expect(parseComponentManifest(mod('{ "npm:other@1": "1.0.0" }')).success).toBe(false);
    expect(parseComponentManifest(mod('{ "@scope/pkg": "2.0.0-rc.1" }')).errors).toEqual([]);
  });
});
