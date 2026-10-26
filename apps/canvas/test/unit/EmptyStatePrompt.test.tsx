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

  it("says what to set up, and takes no description, when there is no endpoint", () => {
    const { onBuild } = setup({ configured: false, error: "Set OPENROUTER_API_KEY." });
    expect(screen.getByTestId("empty-state-setup").textContent).toContain("OPENROUTER_API_KEY");
    expect(
      (screen.getByLabelText("Or describe what you want to build") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect((screen.getByTestId("build-from-prompt") as HTMLButtonElement).disabled).toBe(true);
    expect(onBuild).not.toHaveBeenCalled();
  });

  it("keeps Start blank, as a quieter choice", () => {
    const { onStartBlank } = setup(READY);
    const blank = screen.getByTestId("start-blank");
    expect(blank.className).toContain("md3-button-tonal");
    fireEvent.click(blank);
    expect(onStartBlank).toHaveBeenCalled();
  });
});
