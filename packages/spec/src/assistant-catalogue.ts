// What the assistant is told about this product (KAM-249, ADR-0060): the step and tool kinds with one example each,
// and the rules a model gets wrong without being told. The examples are real values, and a test loads every one into a
// spec, so this text cannot drift from the schema: change a kind and the test fails until the example follows.

/** One example per step kind, as the object that goes in `agent.workflow` (version 1.1). */
export const STEP_EXAMPLES: Record<string, { about: string; step: Record<string, unknown> }> = {
  tool: {
    about:
      "Calls a tool declared in agent.tools. The tool's inputs are written on the tool, not the step.",
    step: { step: "fetch", type: "tool", tool: "fetch_prices" },
  },
  action: {
    about:
      "Asks the model to do something. `action` is a short name for the job; `query` is the instruction, and may read earlier steps with {{ step.field }}. `output_schema` makes the answer a checked object.",
    step: {
      step: "summarize",
      action: "summarize_findings",
      query: "Summarize {{ fetch.title }} in two sentences.",
      output_schema: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
    },
  },
  transform: {
    about: "Computes named values from earlier results with JSONata, no model call.",
    step: { step: "shape", type: "transform", set: { total: "$sum(fetch.items.price)" } },
  },
  validate: {
    about:
      "Stops (on_fail: fail) or quietly ends the run (on_fail: skip) when a JSONata check is false.",
    step: {
      step: "check",
      type: "validate",
      assert: "$count(fetch.items) > 0",
      on_fail: "skip",
      message: "Nothing to process",
    },
  },
  dedupe: {
    about: "Runs the rest of the workflow once per key within a time window.",
    step: { step: "once_per_id", type: "dedupe", once: { key: "trigger.id", ttl: "24h" } },
  },
  approval: {
    about: "Pauses until a person approves or rejects. Rejecting ends the run.",
    step: { step: "ok_to_send", type: "approval", message: "Send this reply?" },
  },
  foreach: {
    about:
      "Runs its steps once per item of a list. The item is named by `as` and read by that name inside. Loops do not nest. Later steps read `<loop step>.results` and `<loop step>.errors`.",
    step: {
      step: "each_item",
      foreach: {
        items: "trigger.items",
        as: "item",
        on_error: "continue",
        steps: [{ step: "handle", type: "transform", set: { id: "item.id" } }],
      },
    },
  },
  branch: {
    about:
      "Runs one of several lists of steps. `if` with then/else, or `switch` with cases and default. The condition is JSONata.",
    step: {
      step: "route",
      branch: {
        if: "fetch.total > 100",
        then: [{ step: "flag", type: "transform", set: { big: "true" } }],
      },
    },
  },
  stop: {
    about: "Ends the run early. Usually the last step of a branch arm.",
    step: { step: "done", stop: { reason: "Nothing to do", status: "skipped" } },
  },
};

/** One example per tool kind, as the object that goes in `agent.tools`. */
export const TOOL_EXAMPLES: Record<string, { about: string; tool: Record<string, unknown> }> = {
  http_request: {
    about:
      "A web request. {{ ... }} in the url, headers and body reads earlier steps, vars and the trigger. A secret is only ever ${ENV_NAME}, never its value.",
    tool: {
      name: "fetch_prices",
      action: "http_request",
      method: "GET",
      url: "https://api.example.com/prices?symbol={{ vars.symbol }}",
      headers: { Authorization: "Bearer ${EXAMPLE_API_KEY}" },
    },
  },
  component: {
    about:
      "A connector from the installed components (listed below by id@version and op). `with` holds the op's inputs.",
    tool: {
      name: "post_alert",
      action: "component",
      use: "kampong/slack@1.0.0",
      op: "post_message",
      with: { channel: "#alerts", text: "{{ summarize.summary }}" },
    },
  },
  slack_post_message: {
    about: "Older built-in Slack tool; prefer the kampong/slack component.",
    tool: {
      name: "notify",
      action: "slack_post_message",
      token: "${SLACK_BOT_TOKEN}",
      channel: "#alerts",
      text: "Done",
    },
  },
  gmail_send: {
    about: "Older built-in Gmail tool.",
    tool: {
      name: "send_mail",
      action: "gmail_send",
      token: "${GMAIL_TOKEN}",
      to: "someone@example.com",
      subject: "Hello",
      body: "Hi",
    },
  },
};

/** Triggers, as `agent.trigger`. */
export const TRIGGER_EXAMPLES: Record<string, { about: string; trigger: Record<string, unknown> }> =
  {
    schedule: {
      about: "Runs on a timetable: a cron expression, or `every: 6h`.",
      trigger: { type: "schedule", cron: "0 9 * * 1-5" },
    },
    webhook: {
      about: "Runs when something posts to it; the body is `trigger`.",
      trigger: { type: "webhook" },
    },
  };

const json = (v: unknown) => JSON.stringify(v);

/** The catalogue as text for the model. `components` are the installed ones, `id@version` with their ops. */
export function assistantCatalogue(components: { use: string; ops: string[] }[] = []): string {
  const lines: string[] = [];
  lines.push(
    "STEP KINDS (each is an object in a list of steps; every step needs a unique `step` name):",
  );
  for (const [kind, { about, step }] of Object.entries(STEP_EXAMPLES)) {
    lines.push(`- ${kind}: ${about}\n  example: ${json(step)}`);
  }
  lines.push("", "TOOL KINDS (objects in agent.tools; every tool needs a unique `name`):");
  for (const [kind, { about, tool }] of Object.entries(TOOL_EXAMPLES)) {
    lines.push(`- ${kind}: ${about}\n  example: ${json(tool)}`);
  }
  lines.push("", "TRIGGERS (agent.trigger; optional, a workflow with none is started by hand):");
  for (const [kind, { about, trigger }] of Object.entries(TRIGGER_EXAMPLES)) {
    lines.push(`- ${kind}: ${about}\n  example: ${json(trigger)}`);
  }
  lines.push("", "INSTALLED COMPONENTS:");
  if (components.length === 0) lines.push("- none");
  for (const c of components) lines.push(`- ${c.use}: ops ${c.ops.join(", ")}`);
  return lines.join("\n");
}
