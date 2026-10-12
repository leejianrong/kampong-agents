import { z } from "zod";
import { buildSchedule, parseEvery } from "./schedule.js";
import { requestOptionalFields } from "./request.js";
import { schemaNodeSchema, type SchemaNode } from "./schema-node.js";

// Trimmed single-agent AgentSpec (ADR-0001: no multi-agent/sub_agents field
// in v1, but the shape below leaves room to add one later without breaking
// existing specs). Field shape follows the example already sketched in
// ideation.md §4.2.

// The version of the published JSON Schema *file* (`agent-spec.v1.0.schema.json`). It stays "1.0" because
// the file name is what existing specs' `yaml-language-server` pragma points at; it describes every
// spec version below.
export const SCHEMA_VERSION = "1.0";

// The spec `version` gates the syntax (KAN-1840, ADR-0027). "1.0" keeps the original reference syntax:
// `{step.field}` / `{{ step.field }}` placeholders and the `step.field <op> literal` condition grammar.
// "1.1" makes everything that computes a value a JSONata expression (a condition's `if` is one, and
// `{{ … }}` holds one) and enables the top-level `vars` block.
export const SPEC_VERSIONS = ["1.0", "1.1"] as const;
export type SpecVersion = (typeof SPEC_VERSIONS)[number];

// `mode: inject` (KAM-107) puts the source's text in the system prompt of every action step, capped in size,
// so the model answers with it in front of it. A source with no mode is only declared: nothing reads it, and
// the spec says so in a warning. Retrieval (`mode: retrieve`) is a later stage.
export const knowledgeItemSchema = z.object({
  type: z.enum(["pdf", "url", "text"]),
  source: z.string().min(1),
  mode: z.enum(["inject"]).optional(),
});

export const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// BYOK / connector secrets (SLICES.md V2 KAN-1106, V9 KAN-1430, Q14): a secret
// is never a literal in the spec -- only a `${ENV_VAR}` placeholder resolved
// from the environment at run time (packages/engine). This regex is the
// schema-level guarantee that a spec can never carry a real key/token value.
export const envVarPlaceholderSchema = z
  .string()
  .regex(
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/,
    "must reference an environment variable as ${ENV_VAR}, never a literal secret",
  );

// `id@version` as a spec writes it in `use:`.
export const componentRefSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[-.][a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    'must be an exact "namespace/name@1.2.3" (no range or tag)',
  );

// KAN-1430 (ADR-0021): tools are a discriminated union on `action`. `http_request`
// is the original generic HTTP tool; `slack_post_message` and `gmail_send` are
// turnkey connectors whose credential is an `${ENV}` token resolved at call
// time (never a literal). Every connector field supports `{{ step.field }}` /
// `{placeholder}` data references (resolved by the engine at run time).
export const toolSchema = z.discriminatedUnion("action", [
  z
    .object({
      name: z.string().min(1),
      action: z.literal("http_request"),
      method: httpMethodSchema,
      url: z.string().min(1),
      // KAN-1845 (ADR-0029): headers, query, body and response mode, shared with connector manifests.
      ...requestOptionalFields,
      requires_approval: z.boolean().optional(),
      extract: z.string().optional(),
    })
    .superRefine((tool, ctx) => {
      // Caught here, at author time, instead of mid-run after earlier steps have had side effects.
      if (tool.body !== undefined && tool.method === "GET") {
        ctx.addIssue({
          code: "custom",
          message: "a GET request cannot send a body",
          path: ["body"],
        });
      }
      if (tool.failure_when !== undefined && (tool.response?.mode ?? "json") !== "json") {
        ctx.addIssue({
          code: "custom",
          message: `failure_when only applies to a json response (response mode is "${tool.response?.mode}")`,
          path: ["failure_when"],
        });
      }
      if (tool.extract !== undefined && (tool.response?.mode ?? "json") !== "json") {
        ctx.addIssue({
          code: "custom",
          message: `extract only applies to a json response (response mode is "${tool.response?.mode}")`,
          path: ["extract"],
        });
      }
    }),
  // KAN-1884 (ADR-0029): a call to a component operation. `use` is an exact id@version (the digest is
  // pinned in kampong.lock); `with` is the op input, `config` its non-secret per-use values, and
  // `secrets` remaps a declared auth slot to an environment variable.
  z
    .object({
      name: z.string().min(1),
      action: z.literal("component"),
      use: componentRefSchema,
      op: z.string().min(1),
      with: z.record(z.string(), z.unknown()).optional(),
      config: z.record(z.string(), z.string()).optional(),
      secrets: z.record(z.string(), envVarPlaceholderSchema).optional(),
      requires_approval: z.boolean().optional(),
      extract: z.string().optional(),
    })
    .strict(),
  z.object({
    name: z.string().min(1),
    action: z.literal("slack_post_message"),
    token: envVarPlaceholderSchema,
    channel: z.string().min(1),
    text: z.string().min(1),
    requires_approval: z.boolean().optional(),
    extract: z.string().optional(),
  }),
  z.object({
    name: z.string().min(1),
    action: z.literal("gmail_send"),
    token: envVarPlaceholderSchema,
    to: z.string().min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
    requires_approval: z.boolean().optional(),
    extract: z.string().optional(),
  }),
]);

// Constrained to what packages/engine actually implements (checked directly
// -- workflow.ts only branches on this literal) rather than an open string,
// so an unsupported value is a spec-validation error, not a runtime failure
// mid-run.
export const fallbackActionSchema = z.enum(["escalate_to_human"]);

export const guardrailsSchema = z.object({
  confidence_threshold: z.number().min(0).max(1).optional(),
  fallback_action: fallbackActionSchema.optional(),
});

// Kept to provider + model name (ADR-0004): generic enough that a future
// gateway (roadmap V5) slots in behind resolution, not into the spec shape.
// V2 shipped anthropic/openai; "ollama" (V3, SLICES.md KAN-1112) is the local
// adapter -- it needs no cloud API key and typically runs on
// http://localhost:11434, which is why `api_key` below is optional at the
// schema level rather than gaining an ollama-shaped exception to the regex.
// "openrouter" (follow-up to V3) is a cloud aggregator like anthropic/openai
// -- it needs a real BYOK `api_key` (its `model.name` also conventionally
// carries a vendor prefix, e.g. "anthropic/claude-3.5-haiku", but that's
// already just a free-form string here, no schema change needed for it).
export const modelProviderSchema = z.enum(["anthropic", "openai", "ollama", "openrouter"]);

export const modelSchema = z
  .object({
    provider: modelProviderSchema,
    name: z.string().min(1),
    // Optional at the field level so a local-only ("ollama") spec never has
    // to invent a placeholder env var it doesn't need; the `.superRefine`
    // below is what actually enforces this as required for the cloud
    // providers ("anthropic"/"openai") so a spec missing it fails schema
    // validation (exit 1) rather than surfacing later as a raw `Error` out
    // of packages/engine's model-resolution path (exit 2).
    api_key: envVarPlaceholderSchema.optional(),
    // Only meaningful for "ollama" today (points at a non-default local
    // server, e.g. a remote/tunneled Ollama host); harmless no-op for the
    // cloud providers, which always call their own fixed API host.
    base_url: z.string().url().optional(),
    // KAN-1185 (R6, ADR-0004): how long a single model call may run before
    // the engine aborts it and fails visibly, rather than hanging forever
    // with zero progress output. Optional -- packages/engine's own
    // DEFAULT_MODEL_TIMEOUT_MS applies when omitted -- and overridable per
    // run from the CLI (`kampong run --timeout <ms>`), which takes
    // precedence over this spec-level value so a CI job can tune it without
    // editing the spec file.
    timeout_ms: z.number().int().positive().optional(),
  })
  .superRefine((model, ctx) => {
    if (model.provider !== "ollama" && model.api_key === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `api_key is required for provider "${model.provider}" (only "ollama" may omit it)`,
        path: ["api_key"],
      });
    }
  });

// KNOWN LIMITATION (finding #8, ADR-0008): `z.toJSONSchema` (Zod's native
// JSON Schema generator, see json-schema.ts) does not translate a
// `.superRefine` cross-field constraint into the emitted JSON Schema at all
// -- the published `agent-spec.v1.0.schema.json` artifact still shows
// `model.api_key` as unconditionally optional, so an external editor
// (Cursor, yaml-language-server, etc.) validating a cloud-provider spec
// missing `api_key` will NOT flag it, even though `parseSpec()` (this
// package's own Zod-backed validator, which every real `kampong` code path
// actually runs through) does. Only this file's `agentSpecSchema.safeParse`
// enforces the "api_key required unless ollama" rule; the JSON Schema is a
// (deliberately) looser approximation for editor tooling. Revisit if this
// gap proves costly enough to warrant a hand-authored `oneOf`/`if`/`then`
// addition to the generated artifact, or a switch to a JSON-Schema
// generator that supports refinements.

const baseWorkflowSteps = [
  z.object({
    step: z.string().min(1),
    type: z.literal("condition"),
    if: z.string().min(1),
    then: z.string().min(1),
    else: z.string().min(1),
  }),
  // KAN-1429 (ADR-0021): a tool step calls a tool as a normal, always-run
  // step -- before this, a tool could only fire from inside a condition
  // step's then/else via `execute_tool(name)`. `tool` names an entry in
  // `agent.tools`; the engine resolves the tool's URL placeholders from prior
  // step outputs and the run input exactly as the condition-branch path does.
  z.object({
    step: z.string().min(1),
    type: z.literal("tool"),
    tool: z.string().min(1),
  }),
  // KAN-1429 (ADR-0021): a first-class human-approval step -- before this,
  // human approval was only reachable as a condition branch
  // (`request_human_approval`) or a tool's `requires_approval`. Reject stops
  // the run (`rejected`), matching the existing approval semantics.
  z.object({
    step: z.string().min(1),
    type: z.literal("approval"),
    // Shown to the approver; `{{ step.field }}` / `{{ input }}` references are
    // resolved from prior step outputs at run time.
    message: z.string().optional(),
  }),
  // KAN-1860 (ADR-0041): data steps, version 1.1 only. Each computes with JSONata expressions over the same
  // data an `if` reads. `transform` makes an object of named values; `validate` stops a bad record
  // (`fail` ends the run, `skip` ends it quietly; `branch` waits on conditional branching, KAN-1859);
  // `dedupe` runs the rest of the workflow once per key within `ttl`, remembered in the state store.
  z.object({
    step: z.string().min(1),
    type: z.literal("transform"),
    set: z.record(z.string(), z.string().min(1)),
  }),
  z.object({
    step: z.string().min(1),
    type: z.literal("validate"),
    assert: z.string().min(1),
    // `branch` is accepted by the shape only so the cross-field check can say it is not supported yet.
    on_fail: z.enum(["fail", "skip", "branch"]).optional(),
    message: z.string().min(1).optional(),
  }),
  z.object({
    step: z.string().min(1),
    type: z.literal("dedupe"),
    once: z.object({ key: z.string().min(1), ttl: z.string().min(1) }),
  }),
  z.object({
    step: z.string().min(1),
    action: z.string().min(1),
    inputs: z.array(z.string()).optional(),
    query: z.string().optional(),
    // Marks this step as one where the model's output confidence matters
    // (KAN-1105 -- see docs/adr/0009 for why this lives on the step rather
    // than being inferred automatically): the engine asks the model for a
    // structured { result, confidence } response and checks it against
    // `guardrails.confidence_threshold` after the step runs.
    confidence_gate: z.boolean().optional(),
    // KAN-1843 (ADR-0038): the shape of this step's output, a JSON Schema subset (the same one a
    // connector op declares). The engine asks the model for exactly this object, validates it, and
    // retries once on a failure; the validated object is the step's output, so a later condition or
    // template can rely on each field's presence and type. Version 1.1 only. With `confidence_gate`
    // the schema must declare a numeric `confidence` field, which the guardrail reads like any other.
    output_schema: schemaNodeSchema.optional(),
    // KAN-1842: per-step overrides of the agent-level model call. `instructions` replaces the
    // Role+Goal system prompt for this step only, `model` names a different model of the same provider
    // (same credentials), `temperature` sets the sampling temperature. Each is optional and an absent
    // one leaves the agent's own setting in force. Version 1.1 only.
    instructions: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
  }),
] as const;

// KAN-1858 (ADR-0043): `foreach` runs a nested list of steps once per item of a list, version 1.1 only.
// `on_error` says what a failing item does: `fail` (the default) ends the run, `continue` records the item in
// `errors` and moves on, `retry` re-runs the failed step with backoff and then applies `then`. `goto` is
// accepted by the shape only so the cross-field check can say it is not supported yet (it needs conditional
// branching, KAN-1859).
export const forEachRetrySchema = z
  .object({
    n: z.number().int().min(1).max(10),
    backoff: z.enum(["fixed", "exponential"]).optional(),
    base_ms: z.number().int().min(0).optional(),
    max_delay_ms: z.number().int().min(0).optional(),
    then: z.enum(["fail", "continue"]).optional(),
  })
  .strict();

export const forEachOnErrorSchema = z.union([
  z.enum(["fail", "continue", "goto"]),
  z.object({ retry: forEachRetrySchema }).strict(),
  z.object({ goto: z.string().min(1) }).strict(),
]);

export const FOREACH_MAX_CONCURRENCY = 32;

// A step list nested in a foreach: any step but another foreach. A nested foreach is accepted by the shape only
// (as `{ step, foreach }`) so the cross-field check can say it is not supported yet, at its own line.
const nestedForEachShape = z.object({ step: z.string().min(1), foreach: z.unknown() });

export const bodyStepSchema = z.union([...baseWorkflowSteps, nestedForEachShape]);

export const forEachStepSchema = z.object({
  step: z.string().min(1),
  foreach: z
    .object({
      items: z.string().min(1),
      as: z.string().min(1),
      concurrency: z.number().int().min(1).max(FOREACH_MAX_CONCURRENCY).optional(),
      on_error: forEachOnErrorSchema.optional(),
      steps: z.array(bodyStepSchema).min(1),
    })
    .strict(),
});

export const workflowStepSchema = z.union([...baseWorkflowSteps, forEachStepSchema]);

// KAN-1431 (ADR-0021/ADR-0022): how a workflow starts. `webhook` is the only
// kind today (an HTTP POST starts a run, its body becomes the input, driven by
// `kampong serve` locally or a managed ingress when hosted). Modeled as an
// object with a `type` discriminant so `schedule` / other triggers slot in
// later without breaking existing specs. Optional -- a spec with no trigger is
// still runnable via `kampong run` / the canvas test-run.
//
// `respond` (KAM-109): `async` (the default) answers a webhook POST with a run id to poll. `sync` holds the
// request open and answers with the final output, for callers that want an answer (a Q&A endpoint).
// `timeout_ms` is how long it waits before falling back to the run id; the run carries on either way.
export const webhookTriggerSchema = z.object({
  type: z.literal("webhook"),
  respond: z.enum(["async", "sync"]).optional(),
  timeout_ms: z.number().int().min(1000).max(300000).optional(),
});

// KAN-1856: `schedule` starts a run on a clock while `kampong serve` is up. Exactly one of `cron` (five
// fields, read in `tz`, default UTC) or `every` (`30s`, `15m`, `6h`, `1d`) says when; the cross-field and
// content checks (XOR, cron syntax, IANA zone) run in the spec's superRefine so each error carries the
// line of the offending field. `overlap` says what to do when a tick comes due while the previous run is
// still going: `skip` (the default) drops it, `queue` keeps one and runs it as soon as the run ends.
// Version 1.1 only. The input of a scheduled run is empty.
export const scheduleTriggerSchema = z
  .object({
    type: z.literal("schedule"),
    cron: z.string().optional(),
    every: z.string().optional(),
    tz: z.string().optional(),
    overlap: z.enum(["skip", "queue"]).optional(),
  })
  .strict();

export const triggerSchema = z.discriminatedUnion("type", [
  webhookTriggerSchema,
  scheduleTriggerSchema,
]);

// KAN-1432 (ADR-0021 Slice D): where a *headless* deployment (`kampong
// serve` / the exported app) sends an Approve/Reject prompt when a run
// pauses with no canvas attached. `type` mirrors triggerSchema's
// discriminant shape, leaving room for other channels later without
// breaking existing specs. Optional -- a spec with no approval_notifier
// still runs headless, it just has no way to ping anyone about a pause; the
// run simply waits for a direct POST /runs/:id/approve.
export const approvalNotifierSchema = z.object({
  type: z.literal("slack"),
  token: envVarPlaceholderSchema,
  channel: z.string().min(1),
});

// A run-time parameter (KAN-1840): declared once, read in expressions as `vars.<name>`, so a deployed spec
// can be re-tuned without editing it. `default` is a literal of the declared type, or `${ENV_VAR}` to take
// the value from the environment (parsed by `resolveVars`: a number, a string, or a list given as a
// comma-separated string or a JSON array).
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export const varSchema = z
  .object({
    type: z.enum(["number", "string", "list"]),
    /** What a list holds. Defaults to strings. */
    items: z.enum(["string", "number"]).optional(),
    description: z.string().optional(),
    default: z
      .union([z.number(), z.string(), z.array(z.union([z.string(), z.number()]))])
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const bad = (message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path });
    if (v.items !== undefined && v.type !== "list") {
      bad('"items" only applies to a var of type list', ["items"]);
    }
    const d = v.default;
    if (d === undefined) return;
    if (typeof d === "string" && ENV_DEFAULT.test(d)) return; // taken from the environment
    if (v.type === "number" && typeof d !== "number") {
      bad("default must be a number, or ${ENV_VAR} to read it from the environment", ["default"]);
    } else if (v.type === "string" && typeof d !== "string") {
      bad("default must be a string, or ${ENV_VAR} to read it from the environment", ["default"]);
    } else if (v.type === "list") {
      const item = v.items ?? "string";
      if (!Array.isArray(d) || d.some((x) => typeof x !== item)) {
        bad(`default must be a list of ${item}s, or \${ENV_VAR} to read it from the environment`, [
          "default",
        ]);
      }
    }
  });

export const varsSchema = z.record(z.string(), varSchema);

export const agentSpecSchema = z
  .object({
    version: z.enum(SPEC_VERSIONS, {
      error: `unsupported spec version: this kampong reads ${SPEC_VERSIONS.map((v) => `"${v}"`).join(" and ")}`,
    }),
    vars: varsSchema.optional(),
    agent: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      role: z.string().min(1),
      goal: z.string().min(1),
      trigger: triggerSchema.optional(),
      approval_notifier: approvalNotifierSchema.optional(),
      // Optional so every V1 spec (authored before BYOK existed) keeps
      // validating unchanged; the execution engine (not the schema) is what
      // requires it to be present before a real run can start.
      model: modelSchema.optional(),
      knowledge_base: z.array(knowledgeItemSchema).optional(),
      tools: z.array(toolSchema).optional(),
      guardrails: guardrailsSchema.optional(),
      workflow: z.array(workflowStepSchema).min(1),
    }),
  })
  .superRefine((spec, ctx) => {
    for (const name of Object.keys(spec.vars ?? {})) {
      if (!VAR_NAME.test(name) || name === "__proto__") {
        ctx.addIssue({
          code: "custom",
          message: `"${name}" is not a valid var name: use letters, digits and underscores, not starting with a digit`,
          path: ["vars", name],
        });
      }
    }
    // KAN-1844: a component's config may read `${ENV}`, but config is not secret (it lands in the request
    // and in fixtures as written), so a variable named like a credential is sent to an auth slot instead.
    (spec.agent.tools ?? []).forEach((tool, i) => {
      if (tool.action !== "component") return;
      for (const [key, value] of Object.entries(tool.config ?? {})) {
        const name = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
        if (name !== undefined && /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE/i.test(name)) {
          ctx.addIssue({
            code: "custom",
            message: `config.${key} reads ${name}, which looks like a secret; config is not secret, so bind it to an auth slot under secrets instead`,
            path: ["agent", "tools", i, "config", key],
          });
        }
      }
    });
    const toolNeedsApproval = (name: string) =>
      (spec.agent.tools ?? []).some((t) => t.name === name && t.requires_approval === true);
    const checkForEach = (
      step: Extract<WorkflowStep, { foreach: unknown }>,
      at: (string | number)[],
    ): void => {
      const loop = step.foreach;
      const bad = (message: string, path: (string | number)[]) =>
        ctx.addIssue({ code: "custom", message, path });
      if (spec.version !== "1.1") bad('foreach needs version "1.1"', [...at, "foreach"]);
      const policy = loop.on_error;
      if (policy === "goto" || (typeof policy === "object" && "goto" in policy)) {
        bad(
          "on_error: goto is not yet supported (it needs conditional branching, KAN-1859): use fail, continue or retry",
          [...at, "foreach", "on_error"],
        );
      }
      if (!VAR_NAME.test(loop.as) || loop.as === "__proto__") {
        bad(
          `"${loop.as}" is not a valid name for the loop variable: use letters, digits and underscores, not starting with a digit`,
          [...at, "foreach", "as"],
        );
      } else if (
        ["trigger", "input", "vars"].includes(loop.as) ||
        spec.agent.workflow.some((s) => s.step === loop.as)
      ) {
        bad(
          `"${loop.as}" cannot be used as the loop variable: it is a reserved name or the name of a workflow step, and would hide it`,
          [...at, "foreach", "as"],
        );
      }
      const seen = new Set<string>();
      loop.steps.forEach((inner, j) => {
        const innerAt = [...at, "foreach", "steps", j];
        if (seen.has(inner.step)) {
          bad(`duplicate step name "${inner.step}" in this foreach`, [...innerAt, "step"]);
        }
        seen.add(inner.step);
        if (
          inner.step === loop.as ||
          ["trigger", "input", "vars"].includes(inner.step) ||
          spec.agent.workflow.some((s) => s.step === inner.step)
        ) {
          bad(
            `"${inner.step}" cannot be used as a step name inside a foreach: it is the loop variable, a reserved name or a step of the workflow`,
            [...innerAt, "step"],
          );
        }
        if ("foreach" in inner) {
          bad("a foreach inside a foreach is not supported yet", [...innerAt, "foreach"]);
          return;
        }
        if ("type" in inner && inner.type === "approval") {
          bad(
            "an approval step is not supported inside a foreach body yet (a loop cannot pause for a person; ADR-0043)",
            [...innerAt, "type"],
          );
        } else if ("type" in inner && inner.type === "tool" && toolNeedsApproval(inner.tool)) {
          bad(
            `tool "${inner.tool}" requires approval, which is not supported inside a foreach body yet (ADR-0043)`,
            [...innerAt, "tool"],
          );
        } else if ("type" in inner && inner.type === "condition") {
          for (const field of ["then", "else"] as const) {
            const branch = inner[field];
            const tool = /^execute_tool\(([A-Za-z0-9_]+)\)$/.exec(branch)?.[1];
            if (branch === "request_human_approval") {
              bad(
                "approval (request_human_approval) is not supported inside a foreach body yet (ADR-0043)",
                [...innerAt, field],
              );
            } else if (tool !== undefined && toolNeedsApproval(tool)) {
              bad(
                `tool "${tool}" requires approval, which is not supported inside a foreach body yet (ADR-0043)`,
                [...innerAt, field],
              );
            }
          }
        } else if (
          "confidence_gate" in inner &&
          inner.confidence_gate &&
          spec.agent.guardrails?.confidence_threshold !== undefined
        ) {
          bad(
            "a confidence_gate step is not supported inside a foreach body while guardrails.confidence_threshold is set (a breach pauses for a person; ADR-0043)",
            [...innerAt, "confidence_gate"],
          );
        }
        checkStep(inner, innerAt);
      });
    };
    const checkStep = (step: BodyStep, stepAt: (string | number)[]): void => {
      if ("foreach" in step) return;
      if (
        "type" in step &&
        (step.type === "transform" || step.type === "validate" || step.type === "dedupe")
      ) {
        const at = stepAt;
        if (spec.version !== "1.1") {
          ctx.addIssue({
            code: "custom",
            message: `${step.type} needs version "1.1"`,
            path: [...at, "type"],
          });
        }
        if (step.type === "transform") {
          if (Object.keys(step.set).length === 0) {
            ctx.addIssue({
              code: "custom",
              message: "set needs at least one name: expression",
              path: [...at, "set"],
            });
          }
          for (const name of Object.keys(step.set)) {
            if (!VAR_NAME.test(name) || name === "__proto__") {
              ctx.addIssue({
                code: "custom",
                message: `"${name}" is not a valid name for a transform value: use letters, digits and underscores, not starting with a digit`,
                path: [...at, "set", name],
              });
            }
          }
        } else if (step.type === "validate") {
          if (step.on_fail === "branch") {
            ctx.addIssue({
              code: "custom",
              message:
                "on_fail: branch is not yet supported (it needs conditional branching, KAN-1859): use fail or skip",
              path: [...at, "on_fail"],
            });
          }
        } else {
          const ttl = parseEvery(step.once.ttl);
          if (!ttl.ok) {
            ctx.addIssue({
              code: "custom",
              message: `ttl: ${ttl.error}`,
              path: [...at, "once", "ttl"],
            });
          }
        }
      }
      for (const field of ["instructions", "model", "temperature"] as const) {
        if (
          field in step &&
          (step as Record<string, unknown>)[field] !== undefined &&
          spec.version !== "1.1"
        ) {
          ctx.addIssue({
            code: "custom",
            message: `${field} needs version "1.1"`,
            path: [...stepAt, field],
          });
        }
      }
      if (!("output_schema" in step) || step.output_schema === undefined) return;
      const at = [...stepAt, "output_schema"];
      if (spec.version !== "1.1") {
        ctx.addIssue({ code: "custom", message: 'output_schema needs version "1.1"', path: at });
      }
      if (step.output_schema.type !== "object") {
        ctx.addIssue({
          code: "custom",
          message: 'output_schema must describe an object (type: "object")',
          path: [...at, "type"],
        });
        return;
      }
      // A provider that enforces structured output (OpenAI's strict mode) needs every object's properties and
      // every array's items spelled out; an open object would be closed to `{}` and an untyped list refused.
      const openEnds = (node: SchemaNode, path: (string | number)[]): void => {
        if (node.type === "object" && Object.keys(node.properties ?? {}).length === 0) {
          ctx.addIssue({
            code: "custom",
            message:
              "an object in output_schema must list its properties (open objects are not supported)",
            path,
          });
        }
        if (node.type === "array" && !node.items) {
          ctx.addIssue({
            code: "custom",
            message: "an array in output_schema must declare its items",
            path,
          });
        }
        for (const [name, child] of Object.entries(node.properties ?? {})) {
          openEnds(child, [...path, "properties", name]);
        }
        if (node.items) openEnds(node.items, [...path, "items"]);
      };
      openEnds(step.output_schema, at);
      if (step.confidence_gate) {
        const confidence = step.output_schema.properties?.confidence;
        if (
          (confidence?.type !== "number" && confidence?.type !== "integer") ||
          !step.output_schema.required?.includes("confidence") ||
          confidence.default !== undefined
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              'a confidence_gate step with an output_schema must declare a numeric "confidence" property (0 to 1) that is required and has no default',
            path: [...at, "properties"],
          });
        }
      }
    };
    spec.agent.workflow.forEach((step, i) => {
      const at = ["agent", "workflow", i];
      if (!("foreach" in step)) {
        checkStep(step, at);
        return;
      }
      checkForEach(step, at);
    });
    (spec.agent.knowledge_base ?? []).forEach((item, i) => {
      if (item.mode === undefined) return;
      const at = ["agent", "knowledge_base", i];
      if (spec.version !== "1.1") {
        ctx.addIssue({
          code: "custom",
          message: 'mode needs version "1.1"',
          path: [...at, "mode"],
        });
      }
      if (item.type === "pdf") {
        ctx.addIssue({
          code: "custom",
          message:
            'a pdf source cannot be injected yet: use type "text" or "url" with mode "inject"',
          path: [...at, "type"],
        });
      }
    });
    const trigger = spec.agent.trigger;
    if (trigger?.type === "schedule") {
      const at = ["agent", "trigger"];
      if (spec.version !== "1.1") {
        ctx.addIssue({
          code: "custom",
          message: 'a schedule trigger needs version "1.1"',
          path: [...at, "type"],
        });
      }
      if ((trigger.cron === undefined) === (trigger.every === undefined)) {
        ctx.addIssue({
          code: "custom",
          message: "a schedule trigger needs exactly one of cron or every",
          path: [...at, trigger.cron === undefined ? "type" : "every"],
        });
      } else if (trigger.every !== undefined && trigger.tz !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "tz only applies to a cron schedule",
          path: [...at, "tz"],
        });
      } else {
        const built = buildSchedule(trigger);
        if (!built.ok) {
          const field = /time zone/.test(built.error)
            ? "tz"
            : trigger.cron !== undefined
              ? "cron"
              : "every";
          ctx.addIssue({ code: "custom", message: built.error, path: [...at, field] });
        }
      }
    }
    if (trigger?.type === "webhook") {
      for (const field of ["respond", "timeout_ms"] as const) {
        if (trigger[field] !== undefined && spec.version !== "1.1") {
          ctx.addIssue({
            code: "custom",
            message: `${field} needs version "1.1"`,
            path: ["agent", "trigger", field],
          });
        }
      }
      if (trigger.timeout_ms !== undefined && trigger.respond !== "sync") {
        ctx.addIssue({
          code: "custom",
          message: 'timeout_ms only applies with respond: "sync"',
          path: ["agent", "trigger", "timeout_ms"],
        });
      }
    }
    if (spec.vars !== undefined && spec.version !== "1.1") {
      ctx.addIssue({
        code: "custom",
        message: 'vars needs version "1.1"',
        path: ["vars"],
      });
    }
  });

export type SpecVars = z.infer<typeof varsSchema>;
export type SpecVar = z.infer<typeof varSchema>;
export type AgentSpec = z.infer<typeof agentSpecSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type WebhookTrigger = z.infer<typeof webhookTriggerSchema>;
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;
export type ApprovalNotifier = z.infer<typeof approvalNotifierSchema>;
export type Tool = z.infer<typeof toolSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type BodyStep = z.infer<typeof bodyStepSchema>;
export type ForEachStep = Extract<WorkflowStep, { foreach: unknown }>;
export type ForEachOnError = z.infer<typeof forEachOnErrorSchema>;
export type Guardrails = z.infer<typeof guardrailsSchema>;
export type FallbackAction = z.infer<typeof fallbackActionSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
