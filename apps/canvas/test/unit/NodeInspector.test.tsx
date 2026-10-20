import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listSteps, parseSpec, specToGraph, type AgentSpec } from "@kampong/spec";
import { Canvas } from "../../src/Canvas.js";
import { NodeInspector, type NodeInspectorProps } from "../../src/NodeInspector.js";
import { duplicateStep, duplicateTool, uniqueName } from "../../src/duplicate.js";

// KAM-211: clicking a node opens its form in the docked panel; Esc, Delete and Ctrl/Cmd+D act on it.

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const ETL = readFileSync(
  resolve(process.cwd(), "packages/cli/templates/market-etl/agent.yaml"),
  "utf8",
);

const KINDS = `version: "1.1"
agent:
  id: kinds
  name: Kinds
  role: R
  goal: G
  trigger:
    type: schedule
    every: 1h
  guardrails:
    confidence_threshold: 0.6
    fallback_action: escalate_to_human
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://api.example.com/orders"
  workflow:
    - step: parse
      action: extract the order
    - step: call
      type: tool
      tool: lookup
    - step: shape
      type: transform
      set:
        n: "1"
    - step: check
      type: validate
      assert: "true"
    - step: once
      type: dedupe
      once:
        key: "trigger.id"
        ttl: 24h
    - step: loop
      foreach:
        items: trigger.items
        as: item
        steps:
          - step: inner
            type: transform
            set:
              m: item.id
    - step: route
      branch:
        if: "true"
        then:
          - step: yes_arm
            stop:
              reason: done
        else:
          - step: no_arm
            type: transform
            set:
              k: "2"
    - step: ask
      type: approval
      message: ok?
`;

function parse(source: string): AgentSpec {
  const { spec, errors } = parseSpec(source);
  expect(errors).toEqual([]);
  return spec!;
}

function props(spec: AgentSpec, nodeId: string, over: Partial<NodeInspectorProps> = {}) {
  const node = specToGraph(spec).nodes.find((n) => n.id === nodeId)!;
  return {
    spec,
    node,
    catalogReady: true,
    catalog: undefined,
    references: [],
    onPatchSteps: vi.fn(async () => true),
    onSaveTool: vi.fn(async () => true),
    onSaveTrigger: vi.fn(async () => true),
    onRemoveTrigger: vi.fn(async () => true),
    onSaveGuardrails: vi.fn(async () => true),
    onRemove: vi.fn(async () => ({ success: true }) as const),
    onDuplicate: vi.fn(async () => undefined),
    onClose: vi.fn(),
    onRequestClose: vi.fn(),
    ...over,
  } satisfies NodeInspectorProps;
}

describe("NodeInspector opens the matching form", () => {
  afterEach(cleanup);

  const spec = parse(KINDS);
  const stepForms: Record<string, RegExp> = {
    parse: /Query/,
    call: /Tool/,
    shape: /Values/,
    check: /Assert/,
    once: /Key \(expression\)/,
    loop: /Items \(expression/,
    inner: /Values/,
    route: /If \(expression/,
    yes_arm: /Reason/,
    no_arm: /Values/,
    ask: /Message/,
  };
  for (const [name, expected] of Object.entries(stepForms)) {
    it(`step ${name}`, () => {
      render(<NodeInspector {...props(spec, `workflow:${name}`)} />);
      expect(screen.getByRole("form", { name: `Edit ${name}` })).toBeTruthy();
      expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
      expect(screen.getByRole("region", { name: `Step ${name}` })).toBeTruthy();
    });
  }

  it("a tool node opens the tool form", () => {
    render(<NodeInspector {...props(spec, "tool:lookup")} />);
    expect(screen.getByRole("region", { name: "Tool lookup" })).toBeTruthy();
    expect((screen.getByDisplayValue("lookup") as HTMLInputElement).tagName).toBe("INPUT");
  });

  it("the trigger node opens the trigger panel", () => {
    render(<NodeInspector {...props(spec, "agent:kinds")} />);
    expect(screen.getByRole("region", { name: "Trigger settings" })).toBeTruthy();
    expect(screen.getByTestId("node-inspector")).toBeTruthy();
  });

  it("the guardrails node opens the form filled with the current values", () => {
    render(<NodeInspector {...props(spec, "guardrails:kinds")} />);
    expect((screen.getByLabelText("Confidence threshold") as HTMLInputElement).value).toBe("0.6");
  });

  it("opens a form for every step in the market-etl template", () => {
    const etl = parse(ETL);
    for (const ref of listSteps(etl)) {
      render(<NodeInspector {...props(etl, `workflow:${ref.name}`)} />);
      expect(screen.getByRole("region", { name: `Step ${ref.name}` })).toBeTruthy();
      cleanup();
    }
  });

  it("a 1.0 action step opens no form but says so and still offers Delete", () => {
    const v1 = parse(`version: "1.0"
agent:
  id: old
  name: Old
  role: R
  goal: G
  workflow:
    - step: first
      action: do it
`);
    render(<NodeInspector {...props(v1, "workflow:first")} />);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete step first" })).toBeTruthy();
  });
});

describe("NodeInspector keys", () => {
  afterEach(cleanup);
  const spec = parse(KINDS);

  it("Esc asks the app to close it", () => {
    const p = props(spec, "workflow:parse");
    render(<NodeInspector {...p} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onRequestClose).toHaveBeenCalledTimes(1);
  });

  it("Delete shows the confirm, and confirming removes the step by name", async () => {
    const p = props(spec, "workflow:loop");
    render(<NodeInspector {...p} />);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.getByText(/Delete step "loop" and the 1 step inside it\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete step" }));
    await vi.waitFor(() =>
      expect(p.onRemove).toHaveBeenCalledWith({ op: "step.remove", step: "loop" }),
    );
  });

  it("Delete is ignored while typing in a field", () => {
    render(<NodeInspector {...props(spec, "workflow:parse")} />);
    const field = screen.getByLabelText("Model");
    fireEvent.keyDown(field, { key: "Delete" });
    expect(screen.queryByText(/This changes the spec/)).toBeNull();
  });

  it("Delete on a tool removes the tool, and a refusal lists what uses it", async () => {
    const p = props(spec, "tool:lookup", {
      onRemove: vi.fn(async () => ({
        success: false as const,
        blocked: true,
        references: [{ path: ["agent", "workflow", 1, "tool"], kind: "tool", text: "lookup" }],
        messages: [],
      })),
    });
    render(<NodeInspector {...p} />);
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.click(screen.getByRole("button", { name: "Delete tool" }));
    await screen.findByText(/cannot be deleted yet/);
    expect(p.onRemove).toHaveBeenCalledWith({ op: "tool.remove", tool: "lookup" });
  });

  it("Esc closes the delete confirm first", () => {
    const p = props(spec, "workflow:parse");
    render(<NodeInspector {...p} />);
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(/This changes the spec/)).toBeNull();
    expect(p.onRequestClose).not.toHaveBeenCalled();
  });

  it("Ctrl+D and Cmd+D duplicate, and the refusal is shown", async () => {
    const p = props(spec, "workflow:parse", { onDuplicate: vi.fn(async () => ["name taken"]) });
    render(<NodeInspector {...p} />);
    fireEvent.keyDown(window, { code: "KeyD", key: "d", ctrlKey: true });
    await screen.findByText("name taken");
    fireEvent.keyDown(window, { code: "KeyD", key: "d", metaKey: true });
    await vi.waitFor(() => expect(p.onDuplicate).toHaveBeenCalledTimes(2));
  });

  it("Delete and Ctrl+D do nothing on the trigger node", () => {
    const p = props(spec, "agent:kinds");
    render(<NodeInspector {...p} />);
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { code: "KeyD", key: "d", ctrlKey: true });
    expect(p.onDuplicate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("focus moves to the panel when it opens", () => {
    render(<NodeInspector {...props(spec, "workflow:parse")} />);
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Step parse" }));
  });
});

describe("duplicate", () => {
  const spec = parse(KINDS);

  it("names a copy after the original and counts up", () => {
    const taken = new Set(["a", "a_copy"]);
    expect(uniqueName("a", taken)).toBe("a_copy2");
    expect(uniqueName("a", taken)).toBe("a_copy3");
  });

  it("puts a top-level copy right after the original", () => {
    const copy = duplicateStep(spec, "shape")!;
    expect(copy.place).toEqual({ in: "workflow", index: 3 });
    expect(copy.step.step).toBe("shape_copy");
  });

  it("puts a loop body copy in the same loop", () => {
    const copy = duplicateStep(spec, "inner")!;
    expect(copy.place).toEqual({ in: { step: "loop", slot: "steps" }, index: 1 });
  });

  it("puts a branch arm copy in the same arm", () => {
    const copy = duplicateStep(spec, "no_arm")!;
    expect(copy.place).toEqual({ in: { step: "route", slot: "else" }, index: 1 });
  });

  it("renames every step inside a copied loop or branch", () => {
    const loop = duplicateStep(spec, "loop")!.step as unknown as {
      foreach: { steps: { step: string }[] };
    };
    expect(loop.foreach.steps.map((s) => s.step)).toEqual(["inner_copy"]);
    const branch = duplicateStep(spec, "route")!.step as unknown as {
      branch: { then: { step: string }[]; else: { step: string }[] };
    };
    expect(branch.branch.then.map((s) => s.step)).toEqual(["yes_arm_copy"]);
    expect(branch.branch.else.map((s) => s.step)).toEqual(["no_arm_copy"]);
  });

  it("copies a tool under a new name", () => {
    expect(duplicateTool(spec, "lookup")?.name).toBe("lookup_copy");
    expect(duplicateTool(spec, "missing")).toBeNull();
  });
});

describe("Canvas selection", () => {
  afterEach(cleanup);
  const spec = parse(KINDS);
  const graph = specToGraph(spec);
  const layout = Object.fromEntries(
    graph.nodes.map((n, i) => [n.id, { x: n.column * 260, y: i * 120 }]),
  );

  it("names each node for assistive technology and marks the selected one", () => {
    render(<Canvas graph={graph} layout={layout} selectedId="workflow:parse" />);
    const node = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`)!;
    expect(node("workflow:parse").getAttribute("aria-label")).toBe("Workflow step parse");
    expect(node("workflow:inner").getAttribute("aria-label")).toBe("Transform step inner, in loop");
    expect(node("workflow:no_arm").getAttribute("aria-label")).toBe(
      "Transform step no_arm, in route, else",
    );
    expect(node("tool:lookup").getAttribute("aria-label")).toBe("Tool lookup");
    expect(node("workflow:parse").classList.contains("selected")).toBe(true);
    expect(node("workflow:shape").classList.contains("selected")).toBe(false);
    expect(node("workflow:parse").getAttribute("tabindex")).toBe("0");
  });

  it("reports a click on a node", () => {
    const onSelect = vi.fn();
    render(<Canvas graph={graph} layout={layout} onSelect={onSelect} />);
    fireEvent.click(document.querySelector('.react-flow__node[data-id="workflow:loop"]')!);
    expect(onSelect).toHaveBeenCalledWith("workflow:loop");
  });
});
