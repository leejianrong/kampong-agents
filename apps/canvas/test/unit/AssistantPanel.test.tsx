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
  mode: "build",
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
  source: "PROPOSED",
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
  const onPreview = vi.fn();
  const utils = render(
    <AssistantPanel
      api={api}
      source="ORIGINAL"
      onChanged={onChanged}
      onMarkNew={onMarkNew}
      onClose={onClose}
      onPreview={onPreview}
    />,
  );
  const ask = async (text = "do it") => {
    const box = await screen.findByLabelText("Describe a change");
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByLabelText("Proposed plan");
  };
  return { api, onChanged, onMarkNew, onClose, onPreview, ask, ...utils };
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
    expect(api.askAssistant).toHaveBeenCalledWith("add a summary", "build");
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
    expect(api.askAssistant).toHaveBeenCalledWith("hello", "build");
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

  it("hands the waiting plan to the canvas to preview, and takes it back when it is decided", async () => {
    const { ask, onPreview } = setup();
    await ask();
    const plan = PLAN as { source: string; diff: unknown };
    expect(onPreview).toHaveBeenLastCalledWith({ source: plan.source, diff: plan.diff });
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }));
    await screen.findByText(/Applied/);
    expect(onPreview).toHaveBeenLastCalledWith(null);
  });

  it("takes the preview back on Discard, and when a new request replaces the plan", async () => {
    const { ask, onPreview } = setup();
    await ask();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onPreview).toHaveBeenLastCalledWith(null);

    const send = async (text: string, plans: number) => {
      fireEvent.change(screen.getByLabelText("Describe a change"), { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(screen.getAllByLabelText("Proposed plan")).toHaveLength(plans));
    };
    await send("again", 2);
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ source: "PROPOSED" }));
    // A new request sets the waiting plan aside: only the newest is on the canvas.
    await send("and another", 3);
    const plans = screen.getAllByLabelText("Proposed plan");
    expect(plans.map((p) => p.getAttribute("data-state"))).toEqual([
      "discarded",
      "discarded",
      "pending",
    ]);
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

  it("answers a question in Ask mode and changes nothing: no plan, no Apply, no preview", async () => {
    const { api, onPreview, onMarkNew } = setup({
      answer: {
        success: true,
        mode: "ask",
        answer: "The get step fetches the page.\n\nIt reads nothing.",
      },
    });
    const box = await screen.findByLabelText("Describe a change");
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("button", { name: "Ask" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Ask about this workflow"), {
      target: { value: "what does get do?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const answer = await screen.findByLabelText("Answer");
    expect(answer.textContent).toContain("The get step fetches the page.");
    expect(answer.querySelectorAll("p")).toHaveLength(2);
    expect(api.askAssistant).toHaveBeenCalledWith("what does get do?", "ask");
    expect(screen.queryByLabelText("Proposed plan")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply to canvas" })).toBeNull();
    expect(api.applyOps).not.toHaveBeenCalled();
    expect(api.replaceSource).not.toHaveBeenCalled();
    expect(onPreview).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.anything() }),
    );
    expect(onMarkNew).not.toHaveBeenCalledWith(expect.arrayContaining(["workflow:summarize"]));
  });

  it("asks in Build mode by default, and switches back", async () => {
    const { api, ask } = setup();
    await ask("build it");
    expect(api.askAssistant).toHaveBeenCalledWith("build it", "build");
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(screen.getByRole("button", { name: "Build" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("goes back to the step list", async () => {
    const { onClose } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Steps" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("AssistantPanel: a description handed over by the empty state (KAM-205)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  const make = (status: AssistantStatus) => {
    const api = {
      assistantStatus: vi.fn(async () => status),
      askAssistant: vi.fn(async () => PLAN),
      applyOps: vi.fn(async () => OK),
      replaceSource: vi.fn(async () => OK),
    };
    const props = {
      api,
      source: "",
      onChanged: async () => undefined,
      onMarkNew: () => undefined,
      onClose: () => undefined,
    };
    return { api, props };
  };

  it("sends it once, as soon as the assistant is ready, and shows the plan", async () => {
    const { api, props } = make(READY);
    const { rerender } = render(
      <AssistantPanel {...props} initialPrompt={{ text: "build me a thing", nonce: 1 }} />,
    );
    await screen.findByLabelText("Proposed plan");
    expect(api.askAssistant).toHaveBeenCalledTimes(1);
    expect(api.askAssistant).toHaveBeenCalledWith("build me a thing", "build");
    // A re-render with the same hand-over does not send it again.
    rerender(<AssistantPanel {...props} initialPrompt={{ text: "build me a thing", nonce: 1 }} />);
    expect(api.askAssistant).toHaveBeenCalledTimes(1);
    // Nothing was applied: the person reviews the plan first.
    expect(api.applyOps).not.toHaveBeenCalled();
  });

  it("sends nothing when there is no endpoint", async () => {
    const { api, props } = make({ configured: false, error: "Set it up." });
    render(<AssistantPanel {...props} initialPrompt={{ text: "x", nonce: 1 }} />);
    await screen.findByTestId("assistant-setup");
    expect(api.askAssistant).not.toHaveBeenCalled();
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
