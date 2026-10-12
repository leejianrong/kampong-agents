import { describe, expect, it } from "vitest";
import {
  buildActionStepEdit,
  buildOutputSchemaFromFields,
  buildTriggerFromForm,
  buildToolFromForm,
  buildVarFromForm,
  checkExpression,
  completeExpression,
  expressionScopeFor,
  failureRuleLines,
  outputFieldsFromSchema,
  parseFailureRuleLines,
  parseSpec,
  removeVarOps,
  renameVarOps,
  setVarOps,
  triggerFormFromSpec,
  triggerOps,
  type AgentSpec,
} from "../../src/index.js";
import { VALID_FIXTURE_CANVAS_FORMS } from "../fixtures-canvas-forms.js";
import { VALID_FIXTURE } from "../fixtures.js";

function load(source: string): AgentSpec {
  const result = parseSpec(source);
  if (!result.spec) throw new Error(JSON.stringify(result.errors));
  return result.spec;
}

describe("checkExpression (the validator's own check, KAN-1850)", () => {
  const spec = load(VALID_FIXTURE_CANVAS_FORMS);
  const scope = expressionScopeFor(spec);

  it("accepts a good expression and an empty one", () => {
    expect(checkExpression("vars.max_alerts > 3 and triage.severe", scope)).toEqual([]);
    expect(checkExpression("   ", scope)).toEqual([]);
  });

  it("locates a syntax error", () => {
    const [d] = checkExpression("trigger.body.alerts[", scope);
    expect(d?.position).toBeTypeOf("number");
    expect(d?.line).toBe(1);
    expect(d?.column).toBeTypeOf("number");
  });

  it("refuses an undeclared var, an unknown root and a denied function", () => {
    expect(checkExpression("vars.threshhold", scope)[0]?.message).toMatch(
      /vars\.threshhold is not declared in vars \(declared: max_alerts, region\)/,
    );
    expect(checkExpression("nothing.here", scope)[0]?.message).toMatch(
      /"nothing" is not something/,
    );
    expect(checkExpression("$now()", scope)[0]?.message).toMatch(/\$now is not available/);
  });

  it("gives the same message the spec validator gives for the same expression", () => {
    const bad = VALID_FIXTURE_CANVAS_FORMS.replace('if: "triage.severe"', 'if: "vars.nope > 1"');
    const result = parseSpec(bad);
    expect(result.success).toBe(false);
    const message = checkExpression("vars.nope > 1", scope)[0]!.message;
    expect(result.errors[0]!.message).toContain(message);
  });

  it("an ingress expression may read only trigger", () => {
    const ingress = expressionScopeFor(spec, { ingress: true });
    expect(checkExpression("trigger.body.status = 'firing'", ingress)).toEqual([]);
    expect(checkExpression("vars.region", ingress)[0]?.message).toMatch(
      /not available when a request arrives/,
    );
  });

  it("a loop variable is readable when the scope names it", () => {
    expect(checkExpression("item.price", scope)).not.toEqual([]);
    expect(checkExpression("item.price", expressionScopeFor(spec, { local: ["item"] }))).toEqual(
      [],
    );
  });
});

describe("completeExpression", () => {
  const spec = load(VALID_FIXTURE_CANVAS_FORMS);
  const scope = expressionScopeFor(spec);
  const inserts = (text: string, scopeUsed = scope) =>
    completeExpression(text, text.length, scopeUsed).items.map((i) => i.insert);

  it("offers the roots at the start of a path: trigger, vars, earlier steps and the loop variable", () => {
    expect(inserts("")).toEqual(["trigger", "vars", "triage", "notify"]);
    expect(inserts("t")).toEqual(["trigger", "triage"]);
    expect(inserts("", expressionScopeFor(spec, { local: ["item"] }))).toContain("item");
  });

  it("only suggests the steps that run before the one being edited", () => {
    expect(inserts("", expressionScopeFor(spec, { stepIndex: 0 }))).toEqual(["trigger", "vars"]);
  });

  it("offers declared var names after vars.", () => {
    expect(inserts("vars.")).toEqual(["vars.max_alerts", "vars.region"]);
    expect(inserts("vars.re")).toEqual(["vars.region"]);
  });

  it("offers trigger fields, including the webhook's mapped names", () => {
    expect(inserts("trigger.")).toEqual(["trigger.headers", "trigger.body", "trigger.alerts"]);
  });

  it("offers an earlier step's output_schema fields", () => {
    expect(inserts("triage.")).toEqual(["triage.summary", "triage.severe"]);
  });

  it("reports the range to replace, mid-expression", () => {
    const text = "a and vars.re";
    const result = completeExpression(text, text.length, scope);
    expect([result.from, result.to]).toEqual([6, 13]);
  });

  it("offers nothing inside a $function name, and only trigger on arrival", () => {
    expect(inserts("$cou")).toEqual([]);
    expect(inserts("", expressionScopeFor(spec, { ingress: true }))).toEqual(["trigger"]);
  });

  it("offers no vars root when the spec has no vars block", () => {
    const plain = expressionScopeFor(load(VALID_FIXTURE));
    expect(inserts("", plain)).not.toContain("vars");
  });
});

describe("vars", () => {
  it("builds typed vars from form text", () => {
    expect(buildVarFromForm({ name: "limit", type: "number", default: "20" }).var).toEqual({
      type: "number",
      default: 20,
    });
    expect(
      buildVarFromForm({ name: "ids", type: "list", items: "number", default: "1, 2,3" }).var,
    ).toEqual({ type: "list", items: "number", default: [1, 2, 3] });
    expect(buildVarFromForm({ name: "label", type: "string", description: "Shown" }).var).toEqual({
      type: "string",
      description: "Shown",
    });
  });

  it("rejects a bad name, a bad number and a non-number list item", () => {
    expect(buildVarFromForm({ name: "1x", type: "string" }).errors?.[0]).toMatch(
      /not a valid var name/,
    );
    expect(buildVarFromForm({ name: "n", type: "number", default: "abc" }).errors).toEqual([
      "the default must be a number",
    ]);
    expect(
      buildVarFromForm({ name: "l", type: "list", items: "number", default: "1,x" }).success,
    ).toBe(false);
  });

  it("never writes a literal secret: a credential-named var must read the environment", () => {
    const literal = buildVarFromForm({ name: "api_key", type: "string", default: "sk-live-12345" });
    expect(literal.success).toBe(false);
    expect(JSON.stringify(literal.errors)).not.toContain("sk-live-12345");
    const fromEnv = buildVarFromForm({ name: "api_key", type: "string", fromEnv: "MY_API_KEY" });
    expect(fromEnv.var).toEqual({ type: "string", default: "${MY_API_KEY}" });
    expect(buildVarFromForm({ name: "k", type: "string", fromEnv: "not a name" }).success).toBe(
      false,
    );
  });

  it("raises a 1.0 spec to 1.1 and creates the vars block when adding the first var", () => {
    const spec = load(VALID_FIXTURE);
    expect(setVarOps(spec, "limit", { type: "number", default: 1 })).toEqual([
      { op: "set", path: ["version"], value: "1.1" },
      { op: "set", path: ["vars"], value: { limit: { type: "number", default: 1 } } },
    ]);
  });

  it("refuses to remove a var an expression reads, and removes the block with the last var", () => {
    const spec = load(VALID_FIXTURE_CANVAS_FORMS);
    const refused = removeVarOps(spec, "region");
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/vars\.region is read in 1 place/);
    expect(removeVarOps(spec, "max_alerts").ops).toEqual([
      { op: "remove", path: ["vars", "max_alerts"] },
    ]);
    const single = load(
      'version: "1.1"\nvars:\n  a:\n    type: number\nagent:\n  id: x\n  name: x\n  role: r\n  goal: g\n  workflow:\n    - step: s\n      action: a\n',
    );
    expect(removeVarOps(single, "a").ops).toEqual([{ op: "remove", path: ["vars"] }]);
  });

  it("renames a var and rewrites each place that reads it", () => {
    const spec = load(VALID_FIXTURE_CANVAS_FORMS);
    const renamed = renameVarOps(spec, "region", "zone");
    expect(renamed.ok).toBe(true);
    expect(renamed.ops).toContainEqual({
      op: "set",
      path: ["agent", "tools", 0, "query", "region"],
      value: "{{ vars.zone }}",
    });
    expect(renameVarOps(spec, "region", "max_alerts").error).toMatch(/already a var/);
    expect(renameVarOps(spec, "region", "9").error).toMatch(/not a valid var name/);
  });
});

describe("output_schema fields", () => {
  it("builds an object schema with required fields, and none for an empty list", () => {
    expect(buildOutputSchemaFromFields([])).toEqual({ success: true });
    const built = buildOutputSchemaFromFields([
      { name: "summary", type: "string", required: true, description: "One line" },
      { name: "tags", type: "string[]", required: false },
    ]);
    expect(built.schema).toEqual({
      type: "object",
      properties: {
        summary: { type: "string", description: "One line" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["summary"],
    });
  });

  it("rejects duplicate and invalid names", () => {
    expect(
      buildOutputSchemaFromFields([
        { name: "a", type: "string", required: false },
        { name: "a", type: "number", required: false },
      ]).errors,
    ).toEqual(['field "a" appears twice']);
    expect(
      buildOutputSchemaFromFields([{ name: "a b", type: "string", required: false }]).success,
    ).toBe(false);
  });

  it("a confidence-gated step must declare a required numeric confidence", () => {
    expect(
      buildOutputSchemaFromFields([{ name: "answer", type: "string", required: true }], {
        confidenceGate: true,
      }).success,
    ).toBe(false);
    expect(
      buildOutputSchemaFromFields(
        [
          { name: "answer", type: "string", required: true },
          { name: "confidence", type: "number", required: true },
        ],
        { confidenceGate: true },
      ).success,
    ).toBe(true);
  });

  it("round-trips a schema through fields, and reports what fields cannot show", () => {
    const spec = load(VALID_FIXTURE_CANVAS_FORMS);
    const step = spec.agent.workflow[0] as { output_schema?: never };
    const { fields, unsupported } = outputFieldsFromSchema(step.output_schema);
    expect(unsupported).toEqual([]);
    expect(buildOutputSchemaFromFields(fields).schema).toEqual(step.output_schema);
    const nested = outputFieldsFromSchema({
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "string" } } } },
    });
    expect(nested.unsupported).toEqual(["a"]);
  });
});

describe("buildActionStepEdit", () => {
  it("patches only the changed keys, keeps keys the form does not own, and raises the version", () => {
    const before = { step: "s", action: "a", query: "q", confidence_gate: true };
    const edit = buildActionStepEdit({ version: "1.0" }, 2, before, {
      action: "a",
      confidenceGate: true,
      model: "small",
      temperature: 0.5,
    });
    expect(edit.success).toBe(true);
    expect(edit.ops).toEqual([
      { op: "set", path: ["version"], value: "1.1" },
      { op: "set", path: ["agent", "workflow", 2, "model"], value: "small" },
      { op: "set", path: ["agent", "workflow", 2, "temperature"], value: 0.5 },
    ]);
    expect(edit.step).toMatchObject({ query: "q" });
  });

  it("removes a key the form cleared", () => {
    const edit = buildActionStepEdit(
      { version: "1.1" },
      0,
      { step: "s", action: "a", instructions: "Be brief." },
      { action: "a" },
    );
    expect(edit.ops).toEqual([{ op: "remove", path: ["agent", "workflow", 0, "instructions"] }]);
  });

  it("reports a step the schema refuses", () => {
    expect(
      buildActionStepEdit({ version: "1.1" }, 0, { step: "s", action: "a" }, { action: "" })
        .success,
    ).toBe(false);
  });
});

describe("trigger form", () => {
  it("builds a webhook with a preset, auth secret name, when and map", () => {
    const built = buildTriggerFromForm({
      kind: "webhook",
      preset: "github",
      secretEnv: "GH_SECRET",
      when: "trigger.headers.`x-github-event` = 'push'",
      map: "repo: trigger.body.repository.name",
    });
    expect(built.trigger).toEqual({
      type: "webhook",
      preset: "github",
      auth: { secret_env: "GH_SECRET" },
      when: "trigger.headers.`x-github-event` = 'push'",
      map: { repo: "trigger.body.repository.name" },
    });
  });

  it("refuses a literal secret without repeating it, auth none with a preset, and a mapped body", () => {
    const literal = buildTriggerFromForm({
      kind: "webhook",
      authType: "bearer",
      secretEnv: "hunter2-is-my-token",
    });
    expect(literal.success).toBe(false);
    expect(JSON.stringify(literal.errors)).not.toContain("hunter2");
    expect(
      buildTriggerFromForm({ kind: "webhook", preset: "slack", authType: "none" }).success,
    ).toBe(false);
    expect(
      buildTriggerFromForm({ kind: "webhook", map: "body: trigger.body" }).errors?.[0],
    ).toMatch(/map cannot set "body"/);
  });

  it("builds an hmac webhook and auth: none", () => {
    expect(
      buildTriggerFromForm({
        kind: "webhook",
        authType: "hmac",
        secretEnv: "SIGN",
        header: "X-Sig",
        prefix: "sha256=",
      }).trigger,
    ).toMatchObject({
      auth: { type: "hmac", secret_env: "SIGN", header: "X-Sig", prefix: "sha256=" },
    });
    expect(buildTriggerFromForm({ kind: "webhook", authType: "none" }).trigger).toMatchObject({
      auth: "none",
    });
  });

  it("builds a cron or an every schedule and says what is wrong with a bad one", () => {
    expect(
      buildTriggerFromForm({
        kind: "schedule",
        mode: "cron",
        cron: "0 9 * * 1-5",
        tz: "Asia/Singapore",
        overlap: "queue",
      }).trigger,
    ).toEqual({ type: "schedule", cron: "0 9 * * 1-5", tz: "Asia/Singapore", overlap: "queue" });
    expect(
      buildTriggerFromForm({ kind: "schedule", mode: "every", every: "15m", tz: "UTC" }).trigger,
    ).toEqual({
      type: "schedule",
      every: "15m",
    });
    expect(
      buildTriggerFromForm({ kind: "schedule", mode: "cron", cron: "61 * * * *" }).success,
    ).toBe(false);
    expect(
      buildTriggerFromForm({ kind: "schedule", mode: "cron", cron: "0 9 * * *", tz: "Mars/Base" })
        .errors?.[0],
    ).toMatch(/time zone/);
    expect(buildTriggerFromForm({ kind: "schedule", mode: "every", every: "" }).success).toBe(
      false,
    );
  });

  it("fills the form from an existing trigger and back to the same trigger", () => {
    const spec = load(VALID_FIXTURE_CANVAS_FORMS);
    const form = triggerFormFromSpec(spec.agent.trigger);
    expect(buildTriggerFromForm(form).trigger).toEqual(spec.agent.trigger);
  });

  it("patches the same trigger type key by key, replaces another, and raises a 1.0 spec", () => {
    const spec = load(VALID_FIXTURE_CANVAS_FORMS);
    const schedule = buildTriggerFromForm({
      kind: "schedule",
      mode: "every",
      every: "1h",
    }).trigger!;
    expect(triggerOps(spec, schedule)).toEqual([
      { op: "set", path: ["agent", "trigger"], value: schedule },
    ]);
    const edited = buildTriggerFromForm({
      ...triggerFormFromSpec(spec.agent.trigger),
      kind: "webhook",
      when: "true",
    }).trigger!;
    expect(triggerOps(spec, edited)).toEqual([
      { op: "set", path: ["agent", "trigger", "when"], value: "true" },
    ]);
    expect(triggerOps(load(VALID_FIXTURE), schedule)[0]).toEqual({
      op: "set",
      path: ["version"],
      value: "1.1",
    });
  });
});

describe("http_request failure rules, pace and retry", () => {
  it("parses rule lines and prints them back", () => {
    const { rules, errors } = parseFailureRuleLines(
      'Note exists\nok equals false\nstatus equals "error" message=detail retryable\ncode matches ^E\nx exists false',
    );
    expect(errors).toEqual([]);
    expect(rules).toEqual([
      { path: "Note", exists: true },
      { path: "ok", equals: false },
      { path: "status", equals: "error", message_path: "detail", retryable: true },
      { path: "code", matches: "^E" },
      { path: "x", exists: false },
    ]);
    expect(parseFailureRuleLines(failureRuleLines(rules)).rules).toEqual(rules);
  });

  it("reports unreadable lines with their number", () => {
    expect(parseFailureRuleLines("ok\nok equals").errors).toEqual([
      'failure rule, line 1: expected "<path> exists", "<path> equals <value>" or "<path> matches <regex>"',
      "failure rule, line 2: equals needs a value",
    ]);
  });

  it("builds a tool with failure_when, pace and retry, and the schema checks them", () => {
    const base = { name: "t", method: "GET", url: "https://x.example.com" };
    const built = buildToolFromForm({
      ...base,
      failureWhen: [{ path: "Note", exists: true }],
      pace: { rps: 2 },
      retry: { max: 3, backoff: "exponential" },
    });
    expect(built.tool).toMatchObject({
      failure_when: [{ path: "Note", exists: true }],
      pace: { rps: 2 },
      retry: { max: 3, backoff: "exponential" },
    });
    expect(buildToolFromForm({ ...base, pace: { rps: 0 } }).success).toBe(false);
    expect(
      buildToolFromForm({
        ...base,
        response: { mode: "text" },
        failureWhen: [{ path: "a", exists: true }],
      }).success,
    ).toBe(false);
  });
});
