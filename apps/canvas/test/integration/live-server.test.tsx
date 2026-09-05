/** @vitest-environment jsdom */
import { createDevServer } from "@kampong/cli";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";

// The real acceptance criterion (SLICES.md V1): build a two-step agent with
// a tool and a guardrail entirely on the canvas, and a spec written
// entirely outside the app renders with zero import step. This runs the
// real Fastify server from @kampong/cli (not mocked) over real HTTP against
// a real temp file, and renders the real React tree via testing-library --
// about as close to true end-to-end as this suite gets without browser
// automation (no Playwright in this repo yet; that gap is worth flagging,
// not papering over).

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}

const EXTERNALLY_WRITTEN_SPEC = `# Written entirely outside the app, no canvas involved
version: "1.0"
agent:
  id: external-agent
  name: "Externally Authored Agent"
  role: "Ops"
  goal: "Prove zero-import-step rendering."
  workflow:
    - step: do_thing
      action: run
`;

const MINIMAL_SPEC = `version: "1.0"
agent:
  id: refund-agent
  name: "Refund Agent"
  role: "Support"
  goal: "Handle refunds."
  workflow:
    - step: parse_request
      action: extract_entities
`;

async function fillAndSubmit(
  formLabel: string,
  fields: Record<string, string>,
  submitLabel: string,
) {
  const form = screen.getByRole("form", { name: formLabel });
  for (const [label, value] of Object.entries(fields)) {
    fireEvent.change(within(form).getByLabelText(label), { target: { value } });
  }
  fireEvent.click(within(form).getByText(submitLabel));
}

describe("canvas against a real local server (no mocks)", () => {
  let dir: string;
  let specPath: string;
  let layoutPath: string;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kampong-live-"));
    specPath = join(dir, "agent.yaml");
    layoutPath = join(dir, "layout.json");
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(source: string) {
    writeFileSync(specPath, source);
    app = createDevServer({ specPath, layoutPath });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  }

  it("renders a spec written entirely outside the app with zero import step", async () => {
    await startServer(EXTERNALLY_WRITTEN_SPEC);
    render(<App apiBaseUrl={baseUrl} />);

    await waitFor(() => {
      expect(screen.getByText(/Trigger: Externally Authored Agent/)).toBeTruthy();
    });
    expect(screen.getByTestId("yaml-preview").textContent).toContain(
      "Written entirely outside the app",
    );
  });

  it("builds a two-step agent with a tool and a guardrail entirely on the canvas", async () => {
    await startServer(MINIMAL_SPEC);
    render(<App apiBaseUrl={baseUrl} />);
    await waitFor(() => screen.getByText(/Trigger: Refund Agent/));

    fireEvent.click(screen.getByText("Add Tool"));
    await fillAndSubmit(
      "Add Tool",
      { Name: "check_status", URL: "https://api.example.com/status" },
      "Save Tool",
    );
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("check_status");
    });

    fireEvent.click(screen.getByText("Add Workflow Step"));
    await fillAndSubmit(
      "Add Workflow Step",
      { "Step ID": "evaluate_policy", Action: "check_knowledge" },
      "Save Step",
    );
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("evaluate_policy");
    });

    fireEvent.click(screen.getByText("Set Guardrails"));
    await fillAndSubmit(
      "Set Guardrails",
      { "Confidence threshold": "0.9", "Fallback action": "escalate_to_human" },
      "Save Guardrails",
    );
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("escalate_to_human");
    });

    const onDisk = readFileSync(specPath, "utf8");
    expect(onDisk).toContain("check_status");
    expect(onDisk).toContain("evaluate_policy");
    expect(onDisk).toContain("confidence_threshold: 0.9");

    // the canvas reflects all three additions, not just the file on disk
    await waitFor(() => {
      expect(screen.getByText(/Tool: check_status/)).toBeTruthy();
      expect(screen.getByText(/Workflow: evaluate_policy/)).toBeTruthy();
      expect(screen.getByText(/Guardrails:/)).toBeTruthy();
    });
  });

  it("builds a two-step agent with a confidence-gated action step and a conditional guardrail branch entirely on the canvas (KAN-1175)", async () => {
    // Before KAN-1175 there was no way to author a `type: "condition"` step
    // or set `confidence_gate` from the canvas at all -- this is the literal
    // SLICES.md V1 demo script ("one tool defined via the structured form,
    // one conditional guardrail branch"), now unblocked.
    await startServer(MINIMAL_SPEC);
    render(<App apiBaseUrl={baseUrl} />);
    await waitFor(() => screen.getByText(/Trigger: Refund Agent/));

    fireEvent.click(screen.getByText("Add Workflow Step"));
    let form = screen.getByRole("form", { name: "Add Workflow Step" });
    fireEvent.change(within(form).getByLabelText("Step ID"), {
      target: { value: "evaluate_policy" },
    });
    fireEvent.change(within(form).getByLabelText("Action"), {
      target: { value: "check_knowledge" },
    });
    fireEvent.click(within(form).getByLabelText("Requires confidence gate"));
    fireEvent.click(within(form).getByText("Save Step"));
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("confidence_gate: true");
    });

    fireEvent.click(screen.getByText("Add Workflow Step"));
    form = screen.getByRole("form", { name: "Add Workflow Step" });
    fireEvent.click(within(form).getByText("Conditional branch"));
    fireEvent.change(within(form).getByLabelText("Step ID"), {
      target: { value: "handle_approval" },
    });
    fireEvent.change(within(form).getByLabelText("If (condition)"), {
      target: { value: "evaluate_policy.eligible == true" },
    });
    fireEvent.change(within(form).getByLabelText("Then (target step id)"), {
      target: { value: "execute_tool(issue_refund)" },
    });
    fireEvent.change(within(form).getByLabelText("Else (target step id)"), {
      target: { value: "request_human_approval" },
    });
    fireEvent.click(within(form).getByText("Save Step"));
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("type: condition");
    });

    const onDisk = readFileSync(specPath, "utf8");
    expect(onDisk).toContain("confidence_gate: true");
    expect(onDisk).toContain("handle_approval");
    expect(onDisk).toContain("evaluate_policy.eligible == true");
    expect(onDisk).toContain("request_human_approval");

    // the canvas reflects both additions, not just the file on disk
    await waitFor(() => {
      expect(screen.getByText(/Workflow: evaluate_policy/)).toBeTruthy();
      expect(screen.getByText(/Workflow: handle_approval/)).toBeTruthy();
    });
  });

  it("adding a tool through the canvas really mutates the file on disk, preserving comments", async () => {
    await startServer(EXTERNALLY_WRITTEN_SPEC);
    render(<App apiBaseUrl={baseUrl} />);
    await waitFor(() => screen.getByText(/Trigger: Externally Authored Agent/));

    fireEvent.click(screen.getByText("Add Tool"));
    await fillAndSubmit(
      "Add Tool",
      { Name: "check_status", URL: "https://api.example.com/status" },
      "Save Tool",
    );

    await waitFor(() => {
      const onDisk = readFileSync(specPath, "utf8");
      expect(onDisk).toContain("check_status");
    });
    const onDisk = readFileSync(specPath, "utf8");
    expect(onDisk).toContain("# Written entirely outside the app");
  });
});
