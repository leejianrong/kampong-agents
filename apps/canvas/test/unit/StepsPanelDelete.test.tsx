import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@kampong/spec";
import { StepsPanel } from "../../src/StepsPanel.js";
import { describeReference, type RemoveOutcome } from "../../src/DeleteControl.js";

// KAM-171: Delete on the step and tool rows of the Edit Steps panel.

const spec = {
  version: "1.1",
  agent: {
    id: "a",
    name: "A",
    role: "R",
    goal: "G",
    tools: [{ name: "lookup", action: "http_request", method: "GET", url: "https://x.example/" }],
    workflow: [
      { step: "fetch", action: "get" },
      {
        step: "each",
        foreach: {
          items: "trigger.items",
          as: "item",
          steps: [{ step: "inner", type: "tool", tool: "lookup" }],
        },
      },
      {
        step: "pick",
        branch: { if: "fetch.ok = true", then: [{ step: "arm", action: "x" }] },
      },
    ],
  },
} as unknown as AgentSpec;

const okOutcome: RemoveOutcome = { success: true };

function setup(onRemove = vi.fn(async (_op: unknown): Promise<RemoveOutcome> => okOutcome)) {
  render(
    <StepsPanel
      spec={spec}
      onPatch={vi.fn(async () => true)}
      onEditTool={vi.fn()}
      onRemove={onRemove}
    />,
  );
  return { onRemove };
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("StepsPanel delete", () => {
  afterEach(cleanup);

  it("asks for a confirm, then removes the step by name, including one in a foreach body and a branch arm", async () => {
    const { onRemove } = setup();
    for (const name of ["inner", "arm"]) {
      click(`Delete step ${name}`);
      expect(onRemove).not.toHaveBeenCalledWith({ op: "step.remove", step: name });
      const group = screen.getByRole("group", { name: `Delete step ${name}?` });
      fireEvent.click(within(group).getByRole("button", { name: "Delete step" }));
      await waitFor(() => expect(onRemove).toHaveBeenCalledWith({ op: "step.remove", step: name }));
    }
  });

  it("says what else goes when a loop or branch is deleted", () => {
    setup();
    click("Delete step each");
    expect(screen.getByRole("group", { name: "Delete step each?" }).textContent).toContain(
      "and the 1 step inside it",
    );
  });

  it("Cancel closes the confirm without deleting", () => {
    const { onRemove } = setup();
    click("Delete step fetch");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Delete step fetch?" })).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("lists what uses a step, in words, and says what to do; nothing offers to force it", async () => {
    const references = [
      {
        path: ["agent", "workflow", 2, "branch", "if"],
        kind: "expression",
        text: "fetch.ok = true",
        line: 12,
      },
      {
        path: ["agent", "workflow", 1, "foreach", "steps", 0, "x"],
        kind: "template",
        text: "{{ fetch.a }}",
      },
    ];
    setup(
      vi.fn(async () => ({
        success: false as const,
        blocked: true,
        messages: ["step fetch is read in 2 places"],
        references,
      })),
    );
    click("Delete step fetch");
    fireEvent.click(screen.getByRole("button", { name: "Delete step" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('2 places use step "fetch", so it cannot be deleted yet');
    expect(alert.textContent).toContain('step "pick", branch if: fetch.ok = true (line 12)');
    expect(alert.textContent).toContain('step "inner", x: {{ fetch.a }}');
    expect(alert.textContent).toContain("Change those places");
    expect(alert.textContent).not.toMatch(/has_references|force/i);
    expect(within(alert).queryByRole("button", { name: /delete/i })).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "OK" }));
    expect(screen.getByRole("button", { name: "Delete step fetch" })).toBeTruthy();
  });

  it("blocks a tool a step uses with its own wording", async () => {
    const { onRemove } = setup(
      vi.fn(async () => ({
        success: false as const,
        blocked: true,
        messages: [],
        references: [
          {
            path: ["agent", "workflow", 1, "foreach", "steps", 0, "tool"],
            kind: "tool",
            text: "lookup",
          },
        ],
      })),
    );
    click("Delete tool lookup");
    fireEvent.click(screen.getByRole("button", { name: "Delete tool" }));
    const alert = await screen.findByRole("alert");
    expect(onRemove).toHaveBeenCalledWith({ op: "tool.remove", tool: "lookup" });
    expect(alert.textContent).toContain('1 place uses tool "lookup"');
    expect(alert.textContent).toContain("Pick another tool");
  });

  it("shows any other refusal as its message", async () => {
    setup(
      vi.fn(async () => ({
        success: false as const,
        blocked: false,
        messages: ["the spec changed since it was loaded"],
        references: [],
      })),
    );
    click("Delete step fetch");
    fireEvent.click(screen.getByRole("button", { name: "Delete step" }));
    expect((await screen.findByRole("alert")).textContent).toContain("the spec changed");
  });

  it("has no Delete buttons when the host does not offer deleting", () => {
    render(<StepsPanel spec={spec} onPatch={vi.fn(async () => true)} onEditTool={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("describes a reference by the step or tool that holds it", () => {
    expect(
      describeReference(spec, {
        path: ["agent", "tools", 0, "url"],
        kind: "tool_template",
        text: "{fetch.x}",
      }),
    ).toBe('tool "lookup", url: {fetch.x}');
  });
});
