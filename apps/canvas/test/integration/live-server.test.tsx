/** @vitest-environment jsdom */
import { createDevServer } from "@kampong/cli";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSpec } from "@kampong/spec";
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
    // Requests the canvas left in flight keep Fastify's 72s keep-alive connections open; drop them.
    app.server.closeAllConnections();
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
      "Save tool",
    );
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("check_status");
    });

    fireEvent.click(screen.getByText("Add Workflow Step"));
    await fillAndSubmit(
      "Add Workflow Step",
      { "Step ID": "evaluate_policy", Action: "check_knowledge" },
      "Save step",
    );
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("evaluate_policy");
    });

    fireEvent.click(screen.getByText("Set Guardrails"));
    await fillAndSubmit(
      "Set Guardrails",
      { "Confidence threshold": "0.9", "Fallback action": "escalate_to_human" },
      "Save guardrails",
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

  it("builds a component tool from a generated form against the real server (KAN-1885)", async () => {
    mkdirSync(join(dir, "components/acme/tickets/1.0.0"), { recursive: true });
    writeFileSync(
      join(dir, "components/acme/tickets/1.0.0/component.yaml"),
      `kind: rest
id: acme/tickets
version: 1.0.0
permissions: { egress: [tickets.example.test] }
ops:
  create:
    effect: write
    input:
      type: object
      required: [title]
      properties:
        title: { type: string }
        priority: { type: integer }
    request:
      method: POST
      url: https://tickets.example.test/tickets
      body: { json: { title: "{{ input.title }}", priority: "{{ input.priority }}" } }
`,
    );
    await startServer(MINIMAL_SPEC);
    render(<App apiBaseUrl={baseUrl} />);
    await waitFor(() => screen.getByText(/Trigger: Refund Agent/));

    fireEvent.click(screen.getByText("Add Tool"));
    fireEvent.click(await screen.findByRole("button", { name: "Component" }));
    const form = screen.getByRole("form", { name: "Add Tool" });
    fireEvent.change(within(form).getByLabelText("Component"), {
      target: { value: "acme/tickets@1.0.0" },
    });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "make_ticket" } });
    fireEvent.change(within(form).getByLabelText(/^title/), { target: { value: "Broken login" } });
    fireEvent.change(within(form).getByLabelText("priority"), { target: { value: "2" } });
    fireEvent.click(within(form).getByText("Save tool"));

    await waitFor(() => expect(readFileSync(specPath, "utf8")).toContain("make_ticket"));
    const parsed = parseSpec(readFileSync(specPath, "utf8"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.spec?.agent.tools).toEqual([
      {
        name: "make_ticket",
        action: "component",
        use: "acme/tickets@1.0.0",
        op: "create",
        with: { title: "Broken login", priority: 2 },
      },
    ]);
    await waitFor(() => expect(screen.getByText(/Tool: make_ticket/)).toBeTruthy());
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
    fireEvent.click(within(form).getByText("Save step"));
    await waitFor(() => {
      expect(readFileSync(specPath, "utf8")).toContain("confidence_gate: true");
    });

    fireEvent.click(screen.getByText("Add Workflow Step"));
    form = screen.getByRole("form", { name: "Add Workflow Step" });
    fireEvent.click(within(form).getByText("Condition"));
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
    fireEvent.click(within(form).getByText("Save step"));
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
      "Save tool",
    );

    await waitFor(() => {
      const onDisk = readFileSync(specPath, "utf8");
      expect(onDisk).toContain("check_status");
    });
    const onDisk = readFileSync(specPath, "utf8");
    expect(onDisk).toContain("# Written entirely outside the app");
  });

  // KAN-1216: the exact repro from the ticket -- delete the spec file out
  // from under a running server while its tab is still open, then try to
  // save a mutation in that tab. Before the fix: the dialog closed as if
  // the save had succeeded, and the canvas went completely blank with no
  // error anywhere (GET/PUT /api/spec 500'd with a raw ENOENT leaking the
  // server filesystem path; api.ts never checked res.ok so the malformed
  // body was cast straight to a success-shaped DTO). Now: PUT /api/spec
  // returns a clean 404, api.ts throws, and the dialog must stay open with
  // a visible error instead of silently no-opping.
  it("shows a real error and keeps the dialog open when saving after the spec file was deleted (KAN-1216)", async () => {
    await startServer(MINIMAL_SPEC);
    render(<App apiBaseUrl={baseUrl} />);
    await waitFor(() => screen.getByText(/Trigger: Refund Agent/));

    unlinkSync(specPath);

    fireEvent.click(screen.getByText("Add Workflow Step"));
    await fillAndSubmit(
      "Add Workflow Step",
      { "Step ID": "evaluate_policy", Action: "check_knowledge" },
      "Save step",
    );

    await waitFor(() => {
      expect(screen.getByTestId("spec-error-banner")).toBeTruthy();
    });
    expect(screen.getByTestId("spec-error-banner").textContent).not.toContain("ENOENT");
    expect(screen.getByTestId("spec-error-banner").textContent).not.toContain(dir);
    // The dialog must still be open -- the save did not actually succeed.
    expect(screen.getByRole("form", { name: "Add Workflow Step" })).toBeTruthy();
    // The canvas itself (toolbar + the trigger node) must still be showing,
    // not blanked out.
    expect(screen.getByText(/Trigger: Refund Agent/)).toBeTruthy();
  });

  // KAM-171 (ADR-0055): delete a step or tool from the Edit Steps list, against the real server.
  describe("deleting from the Edit Steps list", () => {
    const WITH_READER = `version: "1.1"
agent:
  id: refund-agent
  name: "Refund Agent"
  role: "Support"
  goal: "Handle refunds."
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://api.example.com/x"
  workflow:
    - step: parse_request
      action: extract_entities
    - step: reply
      action: "answer using {{ parse_request.text }}"
    - step: call
      type: tool
      tool: lookup
`;

    async function openSteps() {
      render(<App apiBaseUrl={baseUrl} />);
      await waitFor(() => screen.getByText(/Trigger: Refund Agent/));
      fireEvent.click(screen.getByRole("button", { name: "Edit Steps" }));
      await waitFor(() => screen.getByTestId("steps-list"));
    }

    it("deletes a step nothing reads, after a confirm, and the file and list follow", async () => {
      await startServer(WITH_READER);
      await openSteps();

      fireEvent.click(screen.getByRole("button", { name: "Delete step reply" }));
      const confirm = screen.getByRole("group", { name: "Delete step reply?" });
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete step" }));

      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Delete step reply" })).toBeNull(),
      );
      const written = readFileSync(specPath, "utf8");
      expect(written).not.toContain("step: reply");
      expect(parseSpec(written).errors).toEqual([]);
    });

    it("shows what reads a step first and keeps it; a tool a step uses is blocked the same way", async () => {
      await startServer(WITH_READER);
      await openSteps();
      const before = readFileSync(specPath, "utf8");

      fireEvent.click(screen.getByRole("button", { name: "Delete step parse_request" }));
      fireEvent.click(
        within(screen.getByRole("group", { name: "Delete step parse_request?" })).getByRole(
          "button",
          { name: "Delete step" },
        ),
      );
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain('1 place uses step "parse_request"');
      expect(alert.textContent).toContain('step "reply"');
      expect(readFileSync(specPath, "utf8")).toBe(before);
      fireEvent.click(within(alert).getByRole("button", { name: "OK" }));

      fireEvent.click(screen.getByRole("button", { name: "Delete tool lookup" }));
      fireEvent.click(
        within(screen.getByRole("group", { name: "Delete tool lookup?" })).getByRole("button", {
          name: "Delete tool",
        }),
      );
      const blocked = await screen.findByRole("alert");
      expect(blocked.textContent).toContain('1 place uses tool "lookup"');
      expect(blocked.textContent).toContain('step "call"');
      expect(readFileSync(specPath, "utf8")).toBe(before);
    });
  });

  // KAM-172 (ADR-0055): rename from the Edit Steps list, against the real server.
  describe("renaming from the Edit Steps list", () => {
    const SOURCE = `version: "1.1"
agent:
  id: refund-agent
  name: "Refund Agent"
  role: "Support"
  goal: "Handle refunds."
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://api.example.com/{parse_request.id}"
  workflow:
    - step: parse_request
      action: extract_entities
    - step: reply
      action: "answer using {{ parse_request.text }}"
    - step: call
      type: tool
      tool: lookup
`;

    async function openSteps() {
      render(<App apiBaseUrl={baseUrl} />);
      await waitFor(() => screen.getByText(/Trigger: Refund Agent/));
      fireEvent.click(screen.getByRole("button", { name: "Edit Steps" }));
      await waitFor(() => screen.getByTestId("steps-list"));
    }
    const rename = (button: string, to: string, submit: string) => {
      fireEvent.click(screen.getByRole("button", { name: button }));
      fireEvent.change(screen.getByLabelText("New name"), { target: { value: to } });
      fireEvent.click(screen.getByRole("button", { name: submit }));
    };

    it("rewrites every use in one save and keeps the node where it was", async () => {
      await startServer(SOURCE);
      await openSteps();
      const layoutBefore = JSON.parse(readFileSync(layoutPath, "utf8"));
      const at = layoutBefore["workflow:parse_request"];
      expect(at).toBeDefined();

      rename("Rename step parse_request", "read_order", "Rename step");

      await waitFor(() => screen.getByRole("button", { name: "Rename step read_order" }));
      const written = readFileSync(specPath, "utf8");
      expect(written).toBe(SOURCE.replaceAll("parse_request", "read_order"));
      expect(parseSpec(written).errors).toEqual([]);
      const layoutAfter = JSON.parse(readFileSync(layoutPath, "utf8"));
      expect(layoutAfter["workflow:read_order"]).toEqual(at);
      expect(layoutAfter["workflow:parse_request"]).toBeUndefined();
    });

    it("renames a tool a step uses, and refuses a name that is taken, keeping the input", async () => {
      await startServer(SOURCE);
      await openSteps();

      rename("Rename tool lookup", "find_order", "Rename tool");
      await waitFor(() => screen.getByRole("button", { name: "Rename tool find_order" }));
      expect(readFileSync(specPath, "utf8")).toBe(SOURCE.replaceAll("lookup", "find_order"));

      const before = readFileSync(specPath, "utf8");
      rename("Rename step reply", "call", "Rename step");
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain('The name "call" is already used by another step');
      expect((screen.getByLabelText("New name") as HTMLInputElement).value).toBe("call");
      expect(readFileSync(specPath, "utf8")).toBe(before);
    });
  });
});
