import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel, newNodeIds } from "../../src/AssistantPanel.js";
import type { ApplyOpsResponse, AssistantAnswer, AssistantStatus } from "../../src/api.js";

// KAM-250: describe, read the plan, Apply; nothing changes before Apply, and one Undo puts it back.

const READY: AssistantStatus = {
  configured: true,
  host: "openrouter.ai",
  model: "vendor/model",
  from: "OPENROUTER_API_KEY",
};

const PLAN: AssistantAnswer = {
  success: true,
  summary: "Adds a summary step.",
  ops: [{ op: "step.insert", place: { in: "workflow" }, step: { step: "summarize", action: "x" } }],
  diff: {
    added: [
      { kind: "step", name: "summarize" },
      { kind: "tool", name: "notify" },
    ],
    changed: [{ kind: "agent", name: "agent" }],
    removed: [],
  },
  revision: "rev1",
};

const OK: ApplyOpsResponse = { success: true, revision: "rev2" };

function setup(
  options: {
    status?: AssistantStatus;
    answer?: AssistantAnswer;
    apply?: ApplyOpsResponse;
    replace?: ApplyOpsResponse;
  } = {},
) {
  const api = {
    assistantStatus: vi.fn(async () => options.status ?? READY),
    askAssistant: vi.fn(async () => options.answer ?? PLAN),
    applyOps: vi.fn(async () => options.apply ?? OK),
    replaceSource: vi.fn(async () => options.replace ?? { success: true, revision: "rev3" }),
  };
  const onChanged = vi.fn(async () => undefined);
  const onMarkNew = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <AssistantPanel
      api={api}
      source="ORIGINAL"
      onChanged={onChanged}
      onMarkNew={onMarkNew}
      onClose={onClose}
    />,
  );
  const ask = async (text = "do it") => {
    const box = await screen.findByLabelText("Describe a change");
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByLabelText("Proposed plan");
  };
  return { api, onChanged, onMarkNew, onClose, ask, ...utils };
}

describe("AssistantPanel", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("says what to set up when there is no endpoint, and takes no prompt", async () => {
    const { api } = setup({
      status: { configured: false, code: "not_configured", error: "Set OPENROUTER_API_KEY." },
    });
    expect((await screen.findByTestId("assistant-setup")).textContent).toContain(
      "OPENROUTER_API_KEY",
    );
    const box = screen.getByLabelText("Describe a change") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(api.askAssistant).not.toHaveBeenCalled();
  });

  it("tells the person, before their first request, where it goes", async () => {
    setup();
    const notice = await screen.findByTestId("assistant-notice");
    expect(notice.textContent).toContain("openrouter.ai");
    expect(notice.textContent).toContain("never your keys");
  });

  it("shows a plan for a prompt and changes nothing until Apply", async () => {
    const { api, ask, onMarkNew } = setup();
    await ask("add a summary");
    expect(api.askAssistant).toHaveBeenCalledWith("add a summary");
    expect(screen.getByText("Adds a summary step.")).toBeTruthy();
    const rows = screen.getByRole("list", { name: "What this changes" }).textContent;
    expect(rows).toContain("AddStepsummarize");
    expect(rows).toContain("AddToolnotify");
    expect(rows).toContain("ChangeWorkflow settings");
    expect(api.applyOps).not.toHaveBeenCalled();
    expect(api.replaceSource).not.toHaveBeenCalled();
    // The notice goes once they have used it.
    expect(screen.queryByTestId("assistant-notice")).toBeNull();
    // Marks from an earlier apply are cleared as a new request starts.
    expect(onMarkNew).toHaveBeenCalledWith([]);
  });

  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    const { api } = setup();
    const box = (await screen.findByLabelText("Describe a change")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(api.askAssistant).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByLabelText("Proposed plan");
    expect(api.askAssistant).toHaveBeenCalledWith("hello");
  });

  it("applies the plan's ops against the revision it was made for, marks what is new, and refreshes", async () => {
    const { api, ask, onChanged, onMarkNew } = setup();
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await screen.findByText(/Applied: 3 changes/);
    expect(api.applyOps).toHaveBeenCalledWith((PLAN as { ops: unknown }).ops, {
      baseRevision: "rev1",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onMarkNew).toHaveBeenLastCalledWith(["workflow:summarize", "tool:notify"]);
  });

  it("undoes the whole apply with one click: the file goes back as it was", async () => {
    const { api, ask, onChanged, onMarkNew } = setup();
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await screen.findByText(/Applied/);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText(/Undone/);
    expect(api.replaceSource).toHaveBeenCalledWith("ORIGINAL", { baseRevision: "rev2" });
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onMarkNew).toHaveBeenLastCalledWith([]);
  });

  it("will not undo over changes made since, and says so", async () => {
    const { ask } = setup({ replace: { success: false, stale: true } });
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await screen.findByText(/Applied/);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "changed after this was applied",
    );
  });

  it("refuses to apply a plan the file has moved on from", async () => {
    const { ask, onChanged } = setup({ apply: { success: false, stale: true } });
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "changed after I made this plan",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("discards a plan without writing anything", async () => {
    const { api, ask } = setup();
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("Not applied.")).toBeTruthy();
    expect(api.applyOps).not.toHaveBeenCalled();
  });

  it("shows why there is no plan: a refusal and the reasons, never a button to apply", async () => {
    const { api } = setup({
      answer: {
        success: false,
        code: "invalid",
        error: "The assistant's plan could not be applied, so nothing was changed.",
        errors: ['There is no step named "nope".'],
      },
    });
    const box = await screen.findByLabelText("Describe a change");
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nothing was changed");
    expect(alert.textContent).toContain('no step named "nope"');
    expect(screen.queryByRole("button", { name: "Apply to canvas" })).toBeNull();
    expect(api.applyOps).not.toHaveBeenCalled();
  });

  it("goes back to the step list", async () => {
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Steps" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("newNodeIds", () => {
  it("names the cards a plan adds, not a variable or the settings", () => {
    expect(
      newNodeIds({
        added: [
          { kind: "step", name: "a" },
          { kind: "tool", name: "t" },
          { kind: "var", name: "v" },
          { kind: "agent", name: "agent" },
        ],
        changed: [],
        removed: [],
      }),
    ).toEqual(["workflow:a", "tool:t"]);
  });
});
