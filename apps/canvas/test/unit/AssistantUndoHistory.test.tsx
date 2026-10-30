import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "../../src/AssistantPanel.js";
import type { AssistantAnswer } from "../../src/api.js";
import type { RestoreResult } from "../../src/editHistory.js";

// KAM-183: the assistant's Undo goes through the canvas's history (so it does not become a new edit and restores
// the pins), and keeps its own guard on the revision Apply produced.

const PLAN: AssistantAnswer = {
  success: true,
  mode: "build",
  summary: "Adds a step.",
  ops: [],
  diff: { added: [{ kind: "step", name: "s" }], changed: [], removed: [] },
  revision: "rev1",
  source: "PROPOSED",
};

function setup(onUndoApply: (revision: string | undefined) => Promise<RestoreResult>) {
  const api = {
    assistantStatus: vi.fn(async () => ({
      configured: true as const,
      host: "h",
      model: "m",
      from: "K",
    })),
    askAssistant: vi.fn(async () => PLAN),
    applyOps: vi.fn(async () => ({ success: true, revision: "rev2" })),
    replaceSource: vi.fn(),
  };
  render(
    <AssistantPanel
      api={api}
      source="ORIGINAL"
      onChanged={async () => undefined}
      onMarkNew={() => undefined}
      onClose={() => undefined}
      onUndoApply={onUndoApply}
    />,
  );
  return api;
}

async function applyIt() {
  const box = await screen.findByRole("textbox");
  fireEvent.change(box, { target: { value: "add a step" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.click(await screen.findByRole("button", { name: "Apply to canvas" }));
  await screen.findByText(/Applied/);
}

describe("assistant Undo through the history", () => {
  afterEach(cleanup);

  it("asks the history to undo with the revision Apply produced, and does not write itself", async () => {
    const onUndoApply = vi.fn(async (_revision: string | undefined): Promise<RestoreResult> => ({
      ok: true,
    }));
    const api = setup(onUndoApply);
    await applyIt();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText(/Undone/);
    expect(onUndoApply).toHaveBeenCalledWith("rev2");
    expect(api.replaceSource).not.toHaveBeenCalled();
  });

  it("says so when the history refuses because the workflow changed since", async () => {
    const onUndoApply = vi.fn(async (_revision: string | undefined): Promise<RestoreResult> => ({
      ok: false,
      stale: true,
      messages: [],
    }));
    setup(onUndoApply);
    await applyIt();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("changed after this was applied"),
    );
  });
});
