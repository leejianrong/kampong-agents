import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyLayoutMoves, applyOpsToSource, type OpError, type SpecOp } from "../../src/ops.js";
import { applyPatchToSource } from "../../src/repository.js";
import {
  CONDITION_REFERENCE_SOURCE,
  EXECUTE_TOOL_SOURCE,
  TEMPLATE_REFERENCE_SOURCE,
  findReferences,
} from "../../src/references.js";
import { parseSpec } from "../../src/parse.js";

// KAM-170 (ADR-0055): step and tool operations, addressed by name, that keep references valid.

const HEAD = (version: string) => `version: "${version}"
agent:
  id: a
  name: A
  role: R
  goal: G
`;

const TOOLS = `  tools:
    - name: notify
      action: http_request
      method: GET
      url: "https://x.example/{fetch.symbol}"
    - name: risky
      action: http_request
      method: POST
      url: "https://x.example/"
      requires_approval: true
`;

const WORKFLOW_11 = `  workflow:
    - step: fetch
      action: get the price of {{ trigger.symbol }}
    - step: gate
      type: validate
      assert: fetch.price > 0 and $exists(fetch.price)
      message: "No price for {{ fetch.symbol }}"
    - step: report
      action: write it up
      query: "{{ \`fetch\`.price }} and the word fetch.py"
    - step: each_alert
      foreach:
        items: trigger.alerts
        as: alert
        steps:
          # look the symbol up
          - step: lookup
            action: fetch the latest price for {{ alert.symbol }}
    - step: send
      type: tool
      tool: notify
`;

const F11 = HEAD("1.1") + TOOLS + WORKFLOW_11;

const BRANCHED = `${HEAD("1.1")}${TOOLS}  workflow:
    - step: classify
      action: classify the ticket
    - step: pick
      branch:
        if: classify.urgent = true
        then:
          - step: page
            type: tool
            tool: notify
    - step: after
      type: transform
      set:
        urgent: classify.urgent
`;

const F10 = `${HEAD("1.0")}${TOOLS}  workflow:
    - step: fetch
      action: get the price of {symbol}
    - step: decide
      type: condition
      if: fetch.price > 10
      then: execute_tool(notify)
      else: request_human_approval
    - step: say
      action: "the price is {{ fetch.price }} and {fetch.symbol}"
`;

function ok(source: string, ops: SpecOp[]) {
  const result = applyOpsToSource(source, ops);
  if (!result.success) throw new Error(JSON.stringify(result.errors, null, 1));
  expect(parseSpec(result.source).errors).toEqual([]);
  return result;
}

function refused(source: string, ops: SpecOp[]): OpError[] {
  const result = applyOpsToSource(source, ops);
  expect(result.success).toBe(false);
  return result.success ? [] : result.errors;
}

const codes = (source: string, ops: SpecOp[]) => refused(source, ops).map((e) => e.code);

describe("step.insert", () => {
  it("inserts into a foreach body, keeping the comment and every other byte", () => {
    const result = ok(F11, [
      {
        op: "step.insert",
        place: { in: { step: "each_alert", slot: "steps" }, index: 1 },
        step: { step: "check", type: "validate", assert: "lookup.price > 0" },
      },
    ]);
    expect(result.source).toBe(
      F11.replace(
        "{{ alert.symbol }}\n",
        "{{ alert.symbol }}\n          - step: check\n            type: validate\n            assert: lookup.price > 0\n",
      ),
    );
  });

  it("appends by default and inserts at index 0 at the top level", () => {
    const step = { step: "tail", type: "transform", set: { x: "fetch.price" } };
    const appended = ok(F11, [{ op: "step.insert", place: { in: "workflow" }, step }]);
    expect(appended.source).toBe(
      F11 + "    - step: tail\n      type: transform\n      set:\n        x: fetch.price\n",
    );
    const first = ok(F11, [
      {
        op: "step.insert",
        place: { in: "workflow", index: 0 },
        step: { step: "head", action: "hi" },
      },
    ]);
    expect(first.source).toContain(
      "  workflow:\n    - step: head\n      action: hi\n    - step: fetch\n",
    );
  });

  it("inserts into a branch arm, and creates an else that is not there yet", () => {
    const into = ok(BRANCHED, [
      {
        op: "step.insert",
        place: { in: { step: "pick", slot: "then" } },
        step: { step: "log", type: "transform", set: { y: "classify.urgent" } },
      },
    ]);
    expect(into.source).toContain(
      "            tool: notify\n          - step: log\n            type: transform\n            set:\n              y: classify.urgent\n",
    );
    const created = ok(BRANCHED, [
      {
        op: "step.insert",
        place: { in: { step: "pick", slot: "else" } },
        step: { step: "calm", type: "tool", tool: "notify" },
      },
    ]);
    expect(created.source).toContain(
      "        then:\n          - step: page\n            type: tool\n            tool: notify\n        else:\n          - step: calm\n",
    );
  });

  it("inserts into a switch case and default", () => {
    const sw = `${HEAD("1.1")}${TOOLS}  workflow:
    - step: classify
      action: classify
    - step: route
      branch:
        switch: classify.kind
        cases:
          one:
            - step: a
              type: tool
              tool: notify
`;
    const result = ok(sw, [
      {
        op: "step.insert",
        place: { in: { step: "route", slot: "cases", key: "one" }, index: 0 },
        step: { step: "b", type: "tool", tool: "notify" },
      },
      {
        op: "step.insert",
        place: { in: { step: "route", slot: "default" } },
        step: { step: "c", type: "tool", tool: "notify" },
      },
    ]);
    const spec = result.spec as {
      agent: {
        workflow: { branch: { cases: { one: { step: string }[] }; default: { step: string }[] } }[];
      };
    };
    expect(spec.agent.workflow[1]!.branch.cases.one.map((s) => s.step)).toEqual(["b", "a"]);
    expect(spec.agent.workflow[1]!.branch.default.map((s) => s.step)).toEqual(["c"]);
  });

  it("refuses an approval, an approval tool, an approval condition and a nested foreach in a foreach body", () => {
    const body = { in: { step: "each_alert", slot: "steps" as const } };
    const insert = (step: Record<string, unknown>): SpecOp => ({
      op: "step.insert",
      place: body,
      step,
    });
    const errors = refused(F11, [insert({ step: "ask", type: "approval" })]);
    expect(errors[0]).toMatchObject({ code: "approval_in_foreach", opIndex: 0 });
    expect(errors[0]!.message).toContain('"ask"');
    expect(codes(F11, [insert({ step: "r", type: "tool", tool: "risky" })])).toEqual([
      "approval_in_foreach",
    ]);
    expect(
      codes(F11, [
        insert({
          step: "c",
          type: "condition",
          if: "lookup.ok == true",
          then: "request_human_approval",
          else: "execute_tool(notify)",
        }),
      ]),
    ).toEqual(["approval_in_foreach"]);
    expect(
      codes(F11, [
        insert({
          step: "inner",
          foreach: { items: "trigger.x", as: "x", steps: [{ step: "z", action: "a" }] },
        }),
      ]),
    ).toEqual(["nested_foreach"]);
    // An approval inside a branch that sits in the body is just as bad.
    expect(
      codes(F11, [
        insert({
          step: "br",
          branch: { if: "lookup.ok = true", then: [{ step: "ask2", type: "approval" }] },
        }),
      ]),
    ).toEqual(["approval_in_foreach"]);
    // The same step is fine at the top level.
    ok(F11, [
      { op: "step.insert", place: { in: "workflow" }, step: { step: "ask", type: "approval" } },
    ]);
  });

  it("reports the other refusals with a code and the op index", () => {
    const place = { in: "workflow" } as const;
    expect(
      codes(F11, [{ op: "step.insert", place, step: { step: "fetch", action: "x" } }]),
    ).toEqual(["name_taken"]);
    expect(
      codes(F11, [{ op: "step.insert", place, step: { step: "lookup", action: "x" } }]),
    ).toEqual(["name_taken"]);
    expect(
      codes(F11, [{ op: "step.insert", place, step: { step: "trigger", action: "x" } }]),
    ).toEqual(["invalid_name"]);
    expect(
      codes(F11, [{ op: "step.insert", place, step: { step: "alert", action: "x" } }]),
    ).toEqual(["invalid_name"]);
    expect(codes(F11, [{ op: "step.insert", place, step: { step: " ", action: "x" } }])).toEqual([
      "invalid_name",
    ]);
    expect(codes(F11, [{ op: "step.insert", place, step: { notstep: 1 } as never }])).toEqual([
      "invalid_step",
    ]);
    expect(
      codes(F11, [
        {
          op: "step.insert",
          place: { in: "workflow", index: 99 },
          step: { step: "n", action: "x" },
        },
      ]),
    ).toEqual(["bad_index"]);
    expect(
      codes(F11, [
        {
          op: "step.insert",
          place: { in: { step: "nope", slot: "steps" } },
          step: { step: "n", action: "x" },
        },
      ]),
    ).toEqual(["step_not_found"]);
    expect(
      codes(F11, [
        {
          op: "step.insert",
          place: { in: { step: "fetch", slot: "steps" } },
          step: { step: "n", action: "x" },
        },
      ]),
    ).toEqual(["slot_not_found"]);
    expect(
      codes(BRANCHED, [
        {
          op: "step.insert",
          place: { in: { step: "pick", slot: "cases", key: "k" } },
          step: { step: "n", action: "x" },
        },
      ]),
    ).toEqual(["slot_not_found"]);
    const second = refused(F11, [
      { op: "step.insert", place, step: { step: "fine", action: "x" } },
      { op: "step.insert", place, step: { step: "fetch", action: "x" } },
    ]);
    expect(second[0]!.opIndex).toBe(1);
  });

  it("refuses a 1.1 step kind in a 1.0 spec", () => {
    expect(
      codes(F10, [
        {
          op: "step.insert",
          place: { in: "workflow" },
          step: { step: "v", type: "validate", assert: "true" },
        },
      ]),
    ).toEqual(["needs_version_1_1"]);
  });

  it("returns the validator's errors, with lines, when the inserted step is not valid", () => {
    const errors = refused(F11, [
      { op: "step.insert", place: { in: "workflow" }, step: { step: "bad", type: "tool" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.line).toBeDefined();
  });
});

describe("step.remove", () => {
  it("removes a step nothing reads, with its layout key", () => {
    const result = ok(F11, [{ op: "step.remove", step: "send" }]);
    expect(result.source).toBe(
      F11.replace("    - step: send\n      type: tool\n      tool: notify\n", ""),
    );
    expect(result.changes.removed).toEqual([{ kind: "step", name: "send" }]);
    expect(result.layoutMoves).toEqual([{ from: "workflow:send", to: null }]);
  });

  it("removes a step inside a foreach body", () => {
    const withTwo = ok(F11, [
      {
        op: "step.insert",
        place: { in: { step: "each_alert", slot: "steps" } },
        step: { step: "check", type: "validate", assert: "lookup.price > 0" },
      },
    ]).source;
    const result = ok(withTwo, [{ op: "step.remove", step: "check" }]);
    expect(result.source).toBe(F11);
  });

  it("refuses to remove a step that is still read, listing every read with its line in the file as it is", () => {
    const errors = refused(F11, [{ op: "step.remove", step: "fetch" }]);
    expect(errors).toHaveLength(1);
    const error = errors[0]!;
    expect(error.code).toBe("has_references");
    expect(error.opIndex).toBe(0);
    expect(error.references!.map((r) => r.kind)).toEqual([
      "expression",
      "template",
      "template",
      "tool_template",
    ]);
    const lines = F11.split("\n");
    for (const ref of error.references!) {
      expect(lines[ref.line! - 1]).toContain("fetch");
    }
    expect(error.references![0]!.text).toBe("fetch.price > 0 and $exists(fetch.price)");
    expect(error.message).toContain("4 places");
  });

  it("allows a removal when every reader is removed in the same request", () => {
    const result = ok(F11, [
      { op: "set", path: ["agent", "tools", 0, "url"], value: "https://x.example/" },
      { op: "step.remove", step: "fetch" },
      { op: "step.remove", step: "gate" },
      { op: "step.remove", step: "report" },
    ]);
    expect(result.changes.removed.map((r) => r.name)).toEqual(["fetch", "gate", "report"]);
  });

  it("a foreach is removed with its body, and a read of a body step from outside blocks it", () => {
    const readsBody =
      F11 + "    - step: tally\n      type: transform\n      set:\n        n: lookup.price\n";
    expect(codes(readsBody, [{ op: "step.remove", step: "each_alert" }])).toEqual([
      "has_references",
    ]);
    ok(F11, [{ op: "step.remove", step: "each_alert" }]);
  });

  it("reports an unknown step", () => {
    expect(codes(F11, [{ op: "step.remove", step: "ghost" }])).toEqual(["step_not_found"]);
  });
});

describe("step.rename", () => {
  it("rewrites every read, keeps literal text, and drops backticks the new name does not need", () => {
    const result = ok(F11, [{ op: "step.rename", step: "fetch", to: "get_price" }]);
    expect(result.source).toBe(
      F11.replace("- step: fetch\n", "- step: get_price\n")
        .replace(
          "assert: fetch.price > 0 and $exists(fetch.price)",
          "assert: get_price.price > 0 and $exists(get_price.price)",
        )
        .replace("{{ fetch.symbol }}", "{{ get_price.symbol }}")
        .replace(
          '"{{ `fetch`.price }} and the word fetch.py"',
          '"{{ get_price.price }} and the word fetch.py"',
        )
        .replace("{fetch.symbol}", "{get_price.symbol}"),
    );
    expect(result.changes).toEqual({
      renamed: [{ kind: "step", from: "fetch", to: "get_price" }],
      removed: [],
      rewrote: 5,
    });
    expect(result.layoutMoves).toEqual([{ from: "workflow:fetch", to: "workflow:get_price" }]);
  });

  it("writes a name that is not a plain identifier in backticks in a 1.1 expression", () => {
    const result = ok(F11, [
      { op: "set", path: ["agent", "tools", 0, "url"], value: "https://x.example/" },
      { op: "step.rename", step: "fetch", to: "get price" },
    ]);
    expect(result.source).toContain(
      'assert: "`get price`.price > 0 and $exists(`get price`.price)"',
    );
    expect(result.source).toContain("- step: get price\n");
  });

  it("does not touch a name inside a string literal, a field of another object or a filter", () => {
    const tricky = F11.replace(
      "assert: fetch.price > 0 and $exists(fetch.price)",
      `assert: '"fetch" = "fetch" and trigger.fetch > 0 and trigger.items[fetch = 1] and fetch.price > 0'`,
    );
    const result = ok(tricky, [{ op: "step.rename", step: "fetch", to: "q" }]);
    expect(result.source).toContain(
      `assert: '"fetch" = "fetch" and trigger.fetch > 0 and trigger.items[fetch = 1] and q.price > 0'`,
    );
  });

  it("renames a step inside a foreach body and one that a body reads", () => {
    const result = ok(F11, [{ op: "step.rename", step: "lookup", to: "find" }]);
    expect(result.source).toContain("- step: find\n");
  });

  it("rewrites a 1.0 spec: templates, the condition grammar, and the {step.field} form", () => {
    const result = ok(F10, [{ op: "step.rename", step: "fetch", to: "quote" }]);
    expect(result.source).toContain("if: quote.price > 10");
    expect(result.source).toContain('action: "the price is {{ quote.price }} and {quote.symbol}"');
    expect(result.source).toContain('url: "https://x.example/{quote.symbol}"');
    expect(result.changes.rewrote).toBe(4);
  });

  it("refuses a taken, reserved, loop-variable or (1.0) unspellable name, and leaves a no-op alone", () => {
    expect(codes(F11, [{ op: "step.rename", step: "fetch", to: "gate" }])).toEqual(["name_taken"]);
    expect(codes(F11, [{ op: "step.rename", step: "fetch", to: "lookup" }])).toEqual([
      "name_taken",
    ]);
    expect(codes(F11, [{ op: "step.rename", step: "fetch", to: "vars" }])).toEqual([
      "invalid_name",
    ]);
    expect(codes(F11, [{ op: "step.rename", step: "fetch", to: "alert" }])).toEqual([
      "invalid_name",
    ]);
    expect(codes(F11, [{ op: "step.rename", step: "fetch", to: "a`b" }])).toEqual(["invalid_name"]);
    expect(codes(F10, [{ op: "step.rename", step: "fetch", to: "get price" }])).toEqual([
      "invalid_name",
    ]);
    expect(codes(F11, [{ op: "step.rename", step: "ghost", to: "x" }])).toEqual(["step_not_found"]);
    const same = ok(F11, [{ op: "step.rename", step: "fetch", to: "fetch" }]);
    expect(same.source).toBe(F11);
  });
});

describe("step.move", () => {
  it("reorders in a list and moves into a foreach body and out of it", () => {
    const up = ok(F11, [{ op: "step.move", step: "send", to: { in: "workflow", index: 0 } }]);
    expect(up.source.indexOf("- step: send")).toBeLessThan(up.source.indexOf("- step: fetch"));
    expect(up.changes.renamed).toEqual([]);

    const into = ok(F11, [
      {
        op: "step.move",
        step: "send",
        to: { in: { step: "each_alert", slot: "steps" }, index: 1 },
      },
    ]);
    expect(into.source).toContain(
      "{{ alert.symbol }}\n          - step: send\n            type: tool\n            tool: notify\n",
    );
    const out = ok(into.source, [{ op: "step.move", step: "send", to: { in: "workflow" } }]);
    expect(out.source).toBe(F11);
  });

  it("keeps a moved step's comment", () => {
    const commented = F11.replace("    - step: send\n", "    # tell people\n    - step: send\n");
    const result = ok(commented, [
      { op: "step.move", step: "send", to: { in: "workflow", index: 0 } },
    ]);
    expect(result.source).toContain("  workflow:\n    # tell people\n    - step: send\n");
  });

  it("moves a step into a branch arm", () => {
    const result = ok(BRANCHED, [
      { op: "step.move", step: "after", to: { in: { step: "pick", slot: "then" }, index: 0 } },
    ]);
    expect(result.source).toContain("        then:\n          - step: after\n");
  });

  it("refuses a move that would put a reader before the step it reads, listing the reads", () => {
    const errors = refused(F11, [
      { op: "step.move", step: "fetch", to: { in: "workflow", index: 4 } },
    ]);
    expect(errors[0]).toMatchObject({ code: "breaks_references", opIndex: 0 });
    expect(errors[0]!.references!.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("gate reads fetch");
    // Moving the reader and the step together is fine.
    ok(F11, [
      { op: "step.move", step: "fetch", to: { in: "workflow", index: 4 } },
      { op: "step.move", step: "gate", to: { in: "workflow", index: 4 } },
      { op: "step.move", step: "report", to: { in: "workflow", index: 4 } },
    ]);
  });

  it("refuses a move into the step's own body, a nested foreach, and an approval into a body", () => {
    expect(
      codes(F11, [
        { op: "step.move", step: "each_alert", to: { in: { step: "each_alert", slot: "steps" } } },
      ]),
    ).toEqual(["move_into_self"]);
    const two = ok(F11, [
      {
        op: "step.insert",
        place: { in: "workflow" },
        step: {
          step: "loop2",
          foreach: { items: "trigger.b", as: "b", steps: [{ step: "z", action: "a" }] },
        },
      },
    ]).source;
    expect(
      codes(two, [
        { op: "step.move", step: "loop2", to: { in: { step: "each_alert", slot: "steps" } } },
      ]),
    ).toEqual(["nested_foreach"]);
    const approving = ok(F11, [
      { op: "step.insert", place: { in: "workflow" }, step: { step: "ask", type: "approval" } },
    ]).source;
    expect(
      codes(approving, [
        { op: "step.move", step: "ask", to: { in: { step: "each_alert", slot: "steps" } } },
      ]),
    ).toEqual(["approval_in_foreach"]);
  });

  it("refuses to move a step out of the arm that can see its reader's data", () => {
    const sibling = `${HEAD("1.1")}${TOOLS}  workflow:
    - step: classify
      action: classify
    - step: pick
      branch:
        if: classify.urgent = true
        then:
          - step: a
            action: first
          - step: b
            type: transform
            set:
              x: a.out
        else:
          - step: c
            action: other
`;
    const errors = refused(sibling, [
      { op: "step.move", step: "b", to: { in: { step: "pick", slot: "else" } } },
    ]);
    expect(errors[0]!.code).toBe("breaks_references");
  });

  it("reports a bad index and a missing target", () => {
    expect(
      codes(F11, [{ op: "step.move", step: "send", to: { in: "workflow", index: 9 } }]),
    ).toEqual(["bad_index"]);
    expect(
      codes(F11, [{ op: "step.move", step: "send", to: { in: { step: "zzz", slot: "steps" } } }]),
    ).toEqual(["step_not_found"]);
  });
});

describe("tool.rename and tool.remove", () => {
  it("renames a tool and rewrites the tool: field and execute_tool(...)", () => {
    const result = ok(F11, [{ op: "tool.rename", tool: "notify", to: "ping" }]);
    expect(result.source).toBe(
      F11.replace("- name: notify\n", "- name: ping\n").replace("tool: notify\n", "tool: ping\n"),
    );
    expect(result.layoutMoves).toEqual([{ from: "tool:notify", to: "tool:ping" }]);
    const old = ok(F10, [{ op: "tool.rename", tool: "notify", to: "ping" }]);
    expect(old.source).toContain("then: execute_tool(ping)");
    expect(old.changes.rewrote).toBe(1);
  });

  it("refuses a taken name, a name execute_tool cannot spell, and an unknown tool", () => {
    expect(codes(F11, [{ op: "tool.rename", tool: "notify", to: "risky" }])).toEqual([
      "name_taken",
    ]);
    expect(codes(F10, [{ op: "tool.rename", tool: "notify", to: "my tool" }])).toEqual([
      "invalid_name",
    ]);
    expect(codes(F11, [{ op: "tool.rename", tool: "ghost", to: "x" }])).toEqual(["tool_not_found"]);
    expect(codes(F11, [{ op: "tool.remove", tool: "ghost" }])).toEqual(["tool_not_found"]);
  });

  it("removes a tool nothing uses, refuses one that is used, and drops an empty tools list", () => {
    const result = ok(F11, [{ op: "tool.remove", tool: "risky" }]);
    expect(result.source).toBe(
      F11.replace(
        '    - name: risky\n      action: http_request\n      method: POST\n      url: "https://x.example/"\n      requires_approval: true\n',
        "",
      ),
    );
    const errors = refused(F11, [{ op: "tool.remove", tool: "notify" }]);
    expect(errors[0]).toMatchObject({ code: "has_references", opIndex: 0 });
    expect(errors[0]!.references![0]!.kind).toBe("tool");
    expect(codes(F10, [{ op: "tool.remove", tool: "notify" }])).toEqual(["has_references"]);
    const both = ok(F11, [
      { op: "tool.remove", tool: "risky" },
      { op: "step.remove", step: "send" },
      { op: "tool.remove", tool: "notify" },
    ]);
    expect(both.source).not.toContain("tools:");
  });
});

describe("1.0 duplicate names", () => {
  it("answers ambiguous_step instead of guessing", () => {
    const dup = `${HEAD("1.0")}  workflow:
    - step: same
      action: one
    - step: same
      action: two
`;
    expect(codes(dup, [{ op: "step.remove", step: "same" }])).toEqual(["ambiguous_step"]);
    expect(codes(dup, [{ op: "step.rename", step: "same", to: "other" }])).toEqual([
      "ambiguous_step",
    ]);
  });
});

describe("requests", () => {
  it("applies raw patch ops and semantic ops in one request, validating once", () => {
    const result = ok(F11, [
      { op: "set", path: ["agent", "goal"], value: "Goal two" },
      { op: "step.rename", step: "fetch", to: "get_price" },
      { op: "set", path: ["agent", "workflow", 0, "action"], value: "get it" },
    ]);
    expect(result.source).toContain("goal: Goal two");
    expect(result.source).toContain("action: get it");
  });

  it("writes nothing when a later op fails", () => {
    const errors = refused(F11, [
      { op: "step.rename", step: "fetch", to: "get_price" },
      { op: "step.remove", step: "ghost" },
    ]);
    expect(errors[0]!.opIndex).toBe(1);
  });

  it("a top-level move asks for the nodes to swap their vertical slots; a move into a body does not", () => {
    const up = ok(F11, [{ op: "step.move", step: "send", to: { in: "workflow", index: 0 } }]);
    expect(up.layoutMoves).toEqual([
      // KAM-186: the moved step is released from any pin (ADR-0061).
      { unpin: "workflow:send" },
      {
        reorder: {
          before: [
            "workflow:fetch",
            "workflow:gate",
            "workflow:report",
            "workflow:each_alert",
            "workflow:send",
          ],
          after: [
            "workflow:send",
            "workflow:fetch",
            "workflow:gate",
            "workflow:report",
            "workflow:each_alert",
          ],
        },
      },
    ]);
    const layout = {
      "workflow:fetch": { x: 5, y: 0 },
      "workflow:gate": { x: 5, y: 120 },
      "workflow:report": { x: 5, y: 240 },
      "workflow:each_alert": { x: 5, y: 360 },
      "workflow:send": { x: 5, y: 480 },
    };
    expect(applyLayoutMoves(layout, up.layoutMoves)).toEqual({
      "workflow:send": { x: 5, y: 0 },
      "workflow:fetch": { x: 5, y: 120 },
      "workflow:gate": { x: 5, y: 240 },
      "workflow:report": { x: 5, y: 360 },
      "workflow:each_alert": { x: 5, y: 480 },
    });
    const into = ok(F11, [
      { op: "step.move", step: "send", to: { in: { step: "each_alert", slot: "steps" } } },
    ]);
    expect(into.layoutMoves).toEqual([{ unpin: "workflow:send" }]);
    // A layout that does not hold every node is left alone.
    expect(applyLayoutMoves({ "workflow:fetch": { x: 1, y: 1 } }, up.layoutMoves)).toEqual({
      "workflow:fetch": { x: 1, y: 1 },
    });
  });

  it("an unpin keeps the position but drops the pin, and a pinned column is not reordered (KAM-186)", () => {
    const pinned = {
      "workflow:a": { x: 1, y: 2, pinned: true as const },
      "workflow:b": { x: 3, y: 4 },
    };
    expect(applyLayoutMoves(pinned, [{ unpin: "workflow:a" }])).toEqual({
      "workflow:a": { x: 1, y: 2 },
      "workflow:b": { x: 3, y: 4 },
    });
    expect(
      applyLayoutMoves(pinned, [
        { reorder: { before: ["workflow:a", "workflow:b"], after: ["workflow:b", "workflow:a"] } },
      ]),
    ).toEqual(pinned);
  });

  it("applies layout renames and drops to a layout, leaving other nodes", () => {
    const layout = {
      "workflow:fetch": { x: 1, y: 2 },
      "workflow:gate": { x: 3, y: 4 },
      "tool:notify": { x: 5, y: 6 },
    };
    expect(
      applyLayoutMoves(layout, [
        { from: "workflow:fetch", to: "workflow:q" },
        { from: "tool:notify", to: null },
        { from: "workflow:missing", to: "workflow:other" },
      ]),
    ).toEqual({ "workflow:q": { x: 1, y: 2 }, "workflow:gate": { x: 3, y: 4 } });
  });

  it("an unparseable source is reported, not thrown", () => {
    expect(refused("agent: [", [{ op: "step.remove", step: "x" }]).length).toBeGreaterThan(0);
    // Regression: a patch to a file that does not parse used to throw out of the save path.
    expect(
      refused("agent: [", [{ op: "set", path: ["agent", "goal"], value: "x" }]).length,
    ).toBeGreaterThan(0);
  });
});

describe("findReferences", () => {
  it("lists the reads of a step and of a tool with lines", () => {
    const refs = findReferences(F11, { step: "fetch" });
    expect(refs).toHaveLength(5);
    expect(refs.every((r) => r.line !== undefined)).toBe(true);
    expect(findReferences(F11, { tool: "notify" }).map((r) => r.kind)).toEqual(["tool"]);
    expect(findReferences(F11, { step: "nope" })).toEqual([]);
  });

  it("does not read ${ENV} as a placeholder, and does not read a step's output_schema or inputs", () => {
    const src = `${HEAD("1.0")}  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.example/"
      headers:
        Authorization: "Bearer \${fetch}"
  workflow:
    - step: fetch
      action: get
      inputs: [fetch]
`;
    expect(findReferences(src, { step: "fetch" })).toEqual([]);
  });
});

// Regression (KAM-170): the save path used `doc.toString` and refolded a long scalar at 80 columns,
// which ADR-0052 had already fixed for `toYamlString`; a canvas save now goes through the same serialiser.
describe("serialisation", () => {
  it("a patch does not refold a long expression elsewhere in the file", () => {
    const long =
      "fetch.price > 0 and fetch.price < 1000000 and $exists(fetch.symbol) and fetch.symbol != 'none'";
    const source = F11.replace(
      "assert: fetch.price > 0 and $exists(fetch.price)",
      `assert: "${long}"`,
    );
    const result = applyPatchToSource(source, [
      { op: "set", path: ["agent", "goal"], value: "G2" },
    ]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.source).toBe(source.replace("goal: G\n", "goal: G2\n"));
  });
});

// The engine keeps its own copies of these patterns because those files are vendored into exported
// projects (ADR-0010); the rewriter must read exactly what the engine reads.
describe("patterns shared with the engine", () => {
  const engine = (file: string) =>
    readFileSync(new URL(`../../../engine/src/${file}`, import.meta.url), "utf8");
  const slashed = (source: string) => `/${source}/`;
  it("matches the engine's placeholder, condition and execute_tool patterns", () => {
    expect(engine("http-tool.ts")).toContain(slashed(TEMPLATE_REFERENCE_SOURCE));
    expect(engine("condition.ts")).toContain(slashed(CONDITION_REFERENCE_SOURCE));
    expect(engine("workflow.ts")).toContain(slashed(EXECUTE_TOOL_SOURCE));
  });
});
