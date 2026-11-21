import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssistantSetupNote,
  explainFailure,
  explainUnavailable,
  unavailableReason,
} from "../../src/assistantStatus.js";
import { EmptyState } from "../../src/EmptyState.js";
import { NodePalette } from "../../src/NodePalette.js";

// KAM-282: one status for the whole screen, said in plain words. The technical text (env names, a host) is behind
// a toggle, the buttons that need the assistant are off with a reason, and a failed prompt says what to do.

afterEach(cleanup);

const OFF = {
  configured: false as const,
  code: "not_configured",
  error: "Set OPENROUTER_API_KEY, or KAMPONG_ASSISTANT_BASE_URL with a key and model.",
};
const DOWN = {
  configured: false as const,
  code: "unreachable",
  error:
    "Could not reach localhost:11434. Start the local model there, or set up another endpoint.",
};

describe("explainUnavailable", () => {
  it("says each reason in words that name no variable", () => {
    for (const code of ["not_configured", "incomplete", "unsupported", "unreachable", undefined]) {
      const plain = explainUnavailable({ configured: false, ...(code && { code }), error: "x" });
      expect(`${plain.headline} ${plain.hint ?? ""}`).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    }
    expect(explainUnavailable(DOWN).headline).toContain("local model");
  });

  it("gives the buttons a short reason, and none when the assistant is available", () => {
    expect(unavailableReason(OFF)).toBe("The assistant isn't set up yet.");
    expect(unavailableReason(undefined)).toBeUndefined();
    expect(
      unavailableReason({ configured: true, host: "h", model: "m", from: "f" }),
    ).toBeUndefined();
  });
});

describe("explainFailure", () => {
  it("turns an unreachable endpoint into what to do, not a host and 'fetch failed'", () => {
    const plain = explainFailure(
      "Could not reach the assistant endpoint localhost:11434: fetch failed",
    );
    expect(plain.headline).toBe("The assistant could not be reached.");
    expect(plain.hint).toContain("running");
  });

  it("names a refused key and a limit, and leaves an unknown message as it is", () => {
    expect(explainFailure("The assistant endpoint x answered 401: nope").headline).toContain("key");
    expect(explainFailure("The assistant endpoint x answered 429.").headline).toContain("limit");
    expect(explainFailure("The plan did not apply.")).toEqual({
      headline: "The plan did not apply.",
    });
  });
});

describe("the same status reads the same everywhere", () => {
  it("shows the plain headline in the main text and keeps the variable names behind the toggle", () => {
    render(<AssistantSetupNote status={OFF} testId="note" />);
    const note = screen.getByTestId("note");
    const main = note.querySelector("p")!.textContent ?? "";
    expect(main).toContain("The assistant isn't set up yet.");
    expect(main).not.toContain("OPENROUTER_API_KEY");
    expect(within(note).getByText("How to set it up")).toBeTruthy();
    expect(note.textContent).toContain("OPENROUTER_API_KEY");
  });

  it("agrees between the empty state and the step rail's buttons", () => {
    render(
      <EmptyState
        kind="new"
        onStartBlank={() => {}}
        onAddStep={() => {}}
        assistant={OFF}
        onBuildFromPrompt={() => {}}
        templates={[]}
      />,
    );
    expect(screen.getByTestId("empty-state-setup").querySelector("p")!.textContent).toContain(
      "The assistant isn't set up yet.",
    );
    cleanup();
    render(
      <NodePalette
        version="1.1"
        onChoose={() => {}}
        onOpenAssistant={() => {}}
        startOpen
        assistantOff={unavailableReason(OFF)!}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Build with the assistant",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("The assistant isn't set up yet.");
    expect(screen.getByTestId("assistant-off").textContent).toContain("isn't set up yet");
  });

  it("leaves the button on when the assistant is available", () => {
    render(<NodePalette version="1.1" onChoose={() => {}} onOpenAssistant={() => {}} startOpen />);
    expect(
      (screen.getByRole("button", { name: "Build with the assistant" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByTestId("assistant-off")).toBeNull();
  });
});
