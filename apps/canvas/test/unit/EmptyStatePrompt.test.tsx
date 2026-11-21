import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "../../src/EmptyState.js";
import type { AssistantStatus } from "../../src/api.js";

// KAM-205: the empty canvas offers "describe it" beside "start blank", and says what to set up when it cannot.

const READY: AssistantStatus = {
  configured: true,
  host: "openrouter.ai",
  model: "vendor/model",
  from: "OPENROUTER_API_KEY",
};

function setup(assistant?: AssistantStatus) {
  const onBuild = vi.fn();
  const onStartBlank = vi.fn();
  render(
    <EmptyState
      kind="new"
      onStartBlank={onStartBlank}
      onAddStep={() => undefined}
      {...(assistant && { assistant, onBuildFromPrompt: onBuild })}
    />,
  );
  return { onBuild, onStartBlank };
}

describe("EmptyState: build from a description", () => {
  afterEach(cleanup);

  it("has no box where the server has no assistant", () => {
    setup();
    expect(screen.queryByTestId("empty-state-prompt")).toBeNull();
    expect(screen.getByTestId("start-blank").className).toContain("md3-button-filled");
  });

  it("says where the description goes and sends it on the button or on Enter", () => {
    const { onBuild } = setup(READY);
    expect(screen.getByText("openrouter.ai").tagName).toBe("STRONG");
    const box = screen.getByLabelText("Or describe what you want to build");
    const button = screen.getByTestId("build-from-prompt") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "  every morning, tell me the weather  " } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onBuild).toHaveBeenCalledWith("every morning, tell me the weather");
    onBuild.mockClear();
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onBuild).not.toHaveBeenCalled();
  });

  it("is one plain line, with no box, when there is no endpoint (KAM-285)", () => {
    const { onBuild } = setup({
      configured: false,
      code: "not_configured",
      error: "Set OPENROUTER_API_KEY.",
    });
    const note = screen.getByTestId("empty-state-setup");
    expect(note.querySelector("p")!.textContent).toContain("The assistant isn't set up yet.");
    // The box and button are not drawn disabled: the templates keep the room.
    expect(screen.queryByLabelText("Or describe what you want to build")).toBeNull();
    expect(screen.queryByTestId("build-from-prompt")).toBeNull();
    expect(onBuild).not.toHaveBeenCalled();
  });

  it("leads with Start blank, and puts the description box after the templates (KAM-285)", () => {
    const { onStartBlank } = setup(READY);
    const blank = screen.getByTestId("start-blank");
    expect(blank.className).toContain("md3-button-filled");
    const form = screen.getByTestId("empty-state-prompt");
    expect(blank.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(blank);
    expect(onStartBlank).toHaveBeenCalled();
  });
});
