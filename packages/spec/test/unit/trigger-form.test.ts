import { describe, expect, it } from "vitest";
import { parseSpec, toYamlString } from "../../src/parse.js";
import { applyPatch } from "../../src/mutate.js";
import {
  buildTriggerFromForm,
  removeTriggerPatch,
  setTriggerPatch,
  triggerToFormInput,
  type TriggerFormInput,
} from "../../src/trigger-form.js";
import { completeExpression, diagnoseExpression } from "../../src/expression-assist.js";

// KAM-161: the trigger panel's form logic.

const build = (input: TriggerFormInput, version = "1.1") => buildTriggerFromForm(input, version);
const errors = (input: TriggerFormInput, version = "1.1") => {
  const r = build(input, version);
  return r.success ? [] : r.errors;
};

const SPEC = (version: string, trigger?: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
${trigger ?? ""}  workflow:
    - step: s
      action: write
`;
/** The built trigger, written into a whole spec and loaded: what the loader says about it. */
function loaderErrors(value: unknown, version = "1.1"): string[] {
  const { doc } = parseSpec(SPEC(version));
  applyPatch(doc, setTriggerPatch(value as never));
  return parseSpec(toYamlString(doc)).errors.map((e) => e.message);
}

const POLL: TriggerFormInput = {
  type: "poll",
  every: "15m",
  use: "kampong/github@1.0.0",
  op: "list_issues",
  with: '{"repo": "a/b"}',
  secrets: "token: ${GITHUB_TOKEN}",
  items: "issues",
  id: "number",
  dedupe: "unique",
};

describe("buildTriggerFromForm: webhook", () => {
  it("builds a bare webhook on either version", () => {
    for (const version of ["1.0", "1.1"]) {
      expect(build({ type: "webhook" }, version)).toEqual({
        success: true,
        value: { type: "webhook" },
      });
    }
  });

  it("builds a preset with its secret, when and map", () => {
    const r = build({
      type: "webhook",
      preset: "github",
      secret_env: "GITHUB_WEBHOOK_SECRET",
      when: 'trigger.headers.`x-github-event` = "pull_request"',
      map: "repo: trigger.repository.full_name\nnumber: trigger.number",
    });
    expect(r).toEqual({
      success: true,
      value: {
        type: "webhook",
        preset: "github",
        auth: { secret_env: "GITHUB_WEBHOOK_SECRET" },
        when: 'trigger.headers.`x-github-event` = "pull_request"',
        map: { repo: "trigger.repository.full_name", number: "trigger.number" },
      },
    });
  });

  it("builds bearer, hmac and none auth", () => {
    expect(build({ type: "webhook", auth: "bearer", secret_env: "TOKEN" })).toMatchObject({
      value: { auth: { type: "bearer", secret_env: "TOKEN" } },
    });
    expect(
      build({
        type: "webhook",
        auth: "hmac",
        secret_env: "${SIGN}",
        header: "X-Sig",
        algo: "sha1",
        encoding: "base64",
        prefix: "v1=",
        timestamp_header: "X-Ts",
        window_s: "120",
        payload: "{timestamp}.{body}",
      }),
    ).toMatchObject({
      value: {
        auth: {
          type: "hmac",
          secret_env: "${SIGN}",
          header: "X-Sig",
          algo: "sha1",
          encoding: "base64",
          prefix: "v1=",
          timestamp_header: "X-Ts",
          window_s: 120,
          payload: "{timestamp}.{body}",
        },
      },
    });
    expect(build({ type: "webhook", auth: "none" })).toMatchObject({ value: { auth: "none" } });
  });

  it("builds a sync response with a timeout, and refuses a timeout without sync", () => {
    expect(build({ type: "webhook", respond: "sync", timeout_ms: "5000" })).toMatchObject({
      value: { respond: "sync", timeout_ms: 5000 },
    });
    expect(errors({ type: "webhook", respond: "async", timeout_ms: "5000" })).toEqual([
      'timeout_ms only applies with respond: "sync"',
    ]);
    expect(errors({ type: "webhook", respond: "sync", timeout_ms: "10" })[0]).toMatch(/1000/);
    expect(errors({ type: "webhook", respond: "sync", timeout_ms: "soon" })).toEqual([
      'timeout_ms "soon" is not a whole number',
    ]);
  });

  it("uses the loader's auth rules and never repeats a literal secret", () => {
    const literal = "sk-live-abc123";
    const found = errors({ type: "webhook", auth: "bearer", secret_env: literal });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/NAME of an environment variable/);
    expect(JSON.stringify(found)).not.toContain(literal);
    expect(errors({ type: "webhook", auth: "bearer" })[0]).toMatch(/secret_env/);
    expect(errors({ type: "webhook", auth: "hmac", secret_env: "S" })[0]).toMatch(/header/);
    expect(errors({ type: "webhook", preset: "github", auth: "none" })[0]).toMatch(/preset/);
    expect(
      errors({ type: "webhook", auth: "hmac", secret_env: "S", header: "h", window_s: "60" })[0],
    ).toMatch(/timestamp_header/);
  });

  it("checks when and map as the loader does", () => {
    expect(errors({ type: "webhook", when: "trigger.a =" })[0]).toMatch(/^when: /);
    expect(errors({ type: "webhook", map: "x: (" })[0]).toMatch(/^map\.x: /);
    expect(errors({ type: "webhook", map: "body: trigger.x" })).toEqual([
      'map cannot set "body": trigger.body is always the request\'s own',
    ]);
    expect(errors({ type: "webhook", map: "no colon" })).toEqual([
      "map line 1 needs the form name: value",
    ]);
    expect(errors({ type: "webhook", map: "a: x\na: y" })).toEqual([
      'map names "a" more than once',
    ]);
  });

  it("refuses 1.1 fields on a 1.0 spec, naming each", () => {
    expect(
      errors(
        { type: "webhook", preset: "github", secret_env: "S", when: "true", respond: "sync" },
        "1.0",
      ),
    ).toEqual([
      'respond needs version "1.1"',
      'preset needs version "1.1"',
      'auth needs version "1.1"',
      'when needs version "1.1"',
    ]);
  });
});

describe("buildTriggerFromForm: schedule", () => {
  it("builds cron with a zone and overlap, or every", () => {
    expect(
      build({
        type: "schedule",
        schedule: "cron",
        cron: "0 9 * * 1-5",
        tz: "Asia/Singapore",
        overlap: "queue",
      }),
    ).toEqual({
      success: true,
      value: { type: "schedule", cron: "0 9 * * 1-5", tz: "Asia/Singapore", overlap: "queue" },
    });
    expect(build({ type: "schedule", schedule: "every", every: "6h" })).toEqual({
      success: true,
      value: { type: "schedule", every: "6h" },
    });
  });

  it("ignores the field of the mode not chosen", () => {
    expect(
      build({
        type: "schedule",
        schedule: "every",
        every: "1d",
        cron: "nonsense",
        tz: "Mars/Base",
      }),
    ).toEqual({ success: true, value: { type: "schedule", every: "1d" } });
  });

  it("says what is wrong", () => {
    expect(errors({ type: "schedule", schedule: "cron" })).toEqual([
      "A schedule needs a cron expression",
    ]);
    expect(errors({ type: "schedule", schedule: "every" })).toEqual([
      "A schedule needs an interval",
    ]);
    expect(errors({ type: "schedule", schedule: "cron", cron: "61 * * * *" })).toHaveLength(1);
    expect(errors({ type: "schedule", schedule: "every", every: "often" })).toHaveLength(1);
    expect(
      errors({ type: "schedule", schedule: "cron", cron: "* * * * *", tz: "Mars/Base" })[0],
    ).toMatch(/time zone/);
    expect(errors({ type: "schedule", schedule: "every", every: "1h" }, "1.0")).toEqual([
      'a schedule trigger needs version "1.1"',
    ]);
  });
});

describe("buildTriggerFromForm: poll", () => {
  it("builds the whole shape", () => {
    expect(build(POLL)).toEqual({
      success: true,
      value: {
        type: "poll",
        every: "15m",
        use: "kampong/github@1.0.0",
        op: "list_issues",
        with: { repo: "a/b" },
        secrets: { token: "${GITHUB_TOKEN}" },
        items: "issues",
        id: "number",
        dedupe: "unique",
      },
    });
    expect(
      build({
        ...POLL,
        dedupe: "time_window",
        window: "24h",
        one_run_per_item: false,
        config: "base: https://x.test",
      }),
    ).toMatchObject({
      value: {
        dedupe: "time_window",
        window: "24h",
        one_run_per_item: false,
        config: { base: "https://x.test" },
      },
    });
  });

  it("requires the fields a poll needs", () => {
    expect(errors({ type: "poll" })).toEqual([
      "A poll needs an interval (30s, 15m, 6h, 1d)",
      "A poll needs a component, like kampong/github@1.0.0",
      "A poll needs the component's op to call",
      "A poll needs an id expression: what makes an item new",
      "A poll needs a dedupe rule",
    ]);
  });

  it("checks the window against the dedupe rule", () => {
    expect(errors({ ...POLL, dedupe: "time_window" })).toEqual([
      "dedupe time_window needs a window (e.g. 24h)",
    ]);
    expect(errors({ ...POLL, window: "24h" })).toEqual([
      "window only applies to dedupe time_window",
    ]);
    expect(errors({ ...POLL, dedupe: "time_window", window: "soon" })).toHaveLength(1);
  });

  it("checks the ref, the arguments and the expressions", () => {
    expect(errors({ ...POLL, use: "github" })[0]).toMatch(/namespace\/name@1\.2\.3/);
    expect(errors({ ...POLL, with: "[1]" })).toEqual([
      'with must be a JSON object, like {"repo": "owner/name"}',
    ]);
    expect(errors({ ...POLL, with: "{oops" })).toHaveLength(1);
    expect(errors({ ...POLL, items: "a +" })[0]).toMatch(/^items: /);
    expect(errors({ ...POLL, id: "(" })[0]).toMatch(/^id: /);
  });

  it("keeps secrets as ${ENV} placeholders and never repeats a literal", () => {
    const literal = "ghp_realtoken123";
    const found = errors({ ...POLL, secrets: `token: ${literal}` });
    expect(found).toEqual(["secrets.token must reference an environment variable as ${ENV_VAR}"]);
    expect(JSON.stringify(found)).not.toContain(literal);
  });
});

describe("agreement with the spec loader", () => {
  const shapes: [string, TriggerFormInput][] = [
    ["bare webhook", { type: "webhook" }],
    ["slack preset", { type: "webhook", preset: "slack", secret_env: "SLACK_SECRET" }],
    ["bearer", { type: "webhook", auth: "bearer", secret_env: "TOKEN", when: "trigger.ok" }],
    ["sync", { type: "webhook", respond: "sync", timeout_ms: "9000", map: "q: trigger.body.q" }],
    ["cron", { type: "schedule", schedule: "cron", cron: "*/5 * * * *", tz: "UTC" }],
    ["every", { type: "schedule", schedule: "every", every: "30s", overlap: "skip" }],
    ["poll", POLL],
    ["poll window", { ...POLL, dedupe: "time_window", window: "1d" }],
  ];

  it.each(shapes)("%s: a built trigger loads clean", (_name, input) => {
    const r = build(input);
    expect(r.success).toBe(true);
    if (r.success) expect(loaderErrors(r.value)).toEqual([]);
  });

  it("agrees on a few refusals too", () => {
    for (const input of [
      { type: "schedule", schedule: "cron", cron: "61 * * * *" },
      { type: "webhook", auth: "bearer", secret_env: "lower-case" },
      { ...POLL, dedupe: "time_window" },
    ] as TriggerFormInput[]) {
      expect(build(input).success).toBe(false);
    }
  });
});

describe("triggerToFormInput", () => {
  it("round-trips every shape through the builder", () => {
    const inputs: TriggerFormInput[] = [
      { type: "webhook", preset: "github", secret_env: "S", when: "true", map: "a: trigger.b" },
      {
        type: "webhook",
        auth: "hmac",
        secret_env: "S",
        header: "x-sig",
        prefix: "v1=",
        window_s: "60",
        timestamp_header: "x-ts",
      },
      { type: "webhook", respond: "sync", timeout_ms: "3000" },
      { type: "schedule", schedule: "cron", cron: "0 * * * *", tz: "Asia/Tokyo" },
      { type: "schedule", schedule: "every", every: "2h", overlap: "queue" },
      POLL,
    ];
    for (const input of inputs) {
      const first = build(input);
      expect(first.success).toBe(true);
      if (!first.success) continue;
      const again = build(triggerToFormInput(first.value));
      expect(again).toEqual(first);
    }
  });
});

describe("patches", () => {
  const source = `# my agent
version: "1.1"
agent:
  id: a
  name: A
  role: R
  goal: G
  # how it starts
  trigger:
    type: webhook
  workflow:
    - step: s
      action: write
`;
  const apply = (text: string, ops: Parameters<typeof applyPatch>[1]) => {
    const { doc } = parseSpec(text);
    applyPatch(doc, ops);
    return toYamlString(doc);
  };

  it("sets and removes the trigger, leaving the rest of the file alone", () => {
    const set = apply(source, setTriggerPatch({ type: "schedule", every: "1h" }));
    expect(parseSpec(set).errors).toEqual([]);
    expect(set).toContain("# my agent\n");
    expect(set).toContain("every: 1h");
    const removed = apply(source, removeTriggerPatch());
    expect(removed).not.toContain("trigger:");
    expect(parseSpec(removed).errors).toEqual([]);
  });

  it("adds a first trigger to a spec that has none", () => {
    const out = apply(SPEC("1.1"), setTriggerPatch({ type: "schedule", every: "1h" }));
    expect(parseSpec(out).errors).toEqual([]);
    expect(out).toContain("trigger:");
  });
});

describe("expression scopes for trigger fields", () => {
  const ingress = { vars: [], steps: [], trigger: [], kind: "ingress" as const };
  const item = { vars: [], steps: [], trigger: [], kind: "item" as const };

  it("an ingress expression reads only trigger", () => {
    expect(diagnoseExpression("trigger.body.a = 1", ingress)).toEqual([]);
    expect(diagnoseExpression("vars.x + review.y", ingress).map((d) => d.message)).toEqual([
      'this expression: "vars" is not available when a request arrives: it can read only trigger (trigger.headers, trigger.body, and the body\'s fields)',
      'this expression: "review" is not available when a request arrives: it can read only trigger (trigger.headers, trigger.body, and the body\'s fields)',
    ]);
    expect(completeExpression("tr", 2, ingress).options.map((o) => o.label)).toEqual(["trigger"]);
    expect(completeExpression("trigger.", 8, ingress).options.map((o) => o.label)).toEqual([
      "headers",
      "body",
    ]);
  });

  it("an item expression checks syntax only and offers nothing", () => {
    expect(diagnoseExpression("anything.at.all", item)).toEqual([]);
    expect(diagnoseExpression("a +", item)).toHaveLength(1);
    expect(completeExpression("va", 2, item, { explicit: true }).options).toEqual([]);
  });
});
