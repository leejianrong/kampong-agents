import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseSpec } from "@kampong/spec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePalette } from "../../src/NodePalette.js";
import { spotBeforeStep } from "../../src/insertSpot.js";
import { StepPicker } from "../../src/StepPicker.js";

// KAM-213: the searchable picker behind the palette and the "+" on a line, and where a "+" puts the step.

describe("StepPicker", () => {
  afterEach(cleanup);

  it("is a combobox that owns a listbox of options with one-line descriptions", () => {
    render(<StepPicker version="1.1" label="Search steps" onChoose={() => {}} />);
    const box = screen.getByRole("combobox", { name: "Search steps" });
    const list = screen.getByRole("listbox");
    expect(box.getAttribute("aria-controls")).toBe(list.id);
    const names = screen.getAllByRole("option").map((o) => o.getAttribute("data-kind"));
    // Condition is for 1.0 specs only.
    expect(names).toEqual([
      "action",
      "tool",
      "approval",
      "transform",
      "validate",
      "dedupe",
      "foreach",
      "branch",
      "stop",
    ]);
    expect(screen.getByRole("option", { name: /Foreach/ }).textContent).toMatch(
      /Repeat the steps inside/,
    );
  });

  it("filters by what a step does, and says so when nothing matches", () => {
    render(<StepPicker version="1.1" label="Search steps" onChoose={() => {}} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "person" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-kind"))).toEqual([
      "approval",
    ]);
    // Words people use for a kind find it too.
    fireEvent.change(box, { target: { value: "loop" } });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("data-kind"))).toEqual([
      "foreach",
    ]);
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/No step matches/);
  });

  it("moves with the arrow keys and chooses with Enter", () => {
    const onChoose = vi.fn();
    render(<StepPicker version="1.1" label="Search steps" onChoose={onChoose} />);
    const box = screen.getByRole("combobox");
    expect(box.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: /Action/ }).id,
    );
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Approval/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(box, { key: "End" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith("stop");
  });

  it("Escape clears the search first and only then closes", () => {
    const onEscape = vi.fn();
    render(
      <StepPicker version="1.1" label="Search steps" onChoose={() => {}} onEscape={onEscape} />,
    );
    const box = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "loop" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("");
    expect(onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe("NodePalette", () => {
  afterEach(cleanup);

  it("focuses the search on / and chooses a kind on click", () => {
    const onChoose = vi.fn();
    render(<NodePalette version="1.1" onChoose={onChoose} />);
    // jsdom is 1024 wide: the rail starts collapsed to a button.
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /Transform/ }));
    expect(onChoose).toHaveBeenCalledWith("transform");
  });

  it("leaves / alone while typing in a text field", () => {
    render(
      <>
        <input aria-label="Other" />
        <NodePalette version="1.1" onChoose={() => {}} />
      </>,
    );
    const other = screen.getByLabelText("Other");
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

const SOURCE = `version: "1.1"
agent:
  id: a
  name: A
  role: r
  goal: g
  tools:
    - name: t
      action: http_request
      method: GET
      url: "https://x.example"
  workflow:
    - step: first
      type: transform
      set:
        a: "1"
    - step: loop
      foreach:
        items: trigger.xs
        as: x
        steps:
          - step: one
            type: tool
            tool: t
          - step: two
            type: tool
            tool: t
    - step: route
      branch:
        if: trigger.ok
        then:
          - step: yes
            type: tool
            tool: t
`;

describe("spotBeforeStep", () => {
  const spec = parseSpec(SOURCE).spec!;

  it("names the workflow and the position before a top-level step", () => {
    expect(spotBeforeStep(spec, "loop")).toEqual({ targetId: "", position: "after:0" });
    expect(spotBeforeStep(spec, "first")).toEqual({ targetId: "", position: "start" });
  });

  it("names a loop's body and a branch arm", () => {
    expect(spotBeforeStep(spec, "two")).toEqual({ targetId: "loop/steps", position: "after:0" });
    expect(spotBeforeStep(spec, "one")).toEqual({ targetId: "loop/steps", position: "start" });
    expect(spotBeforeStep(spec, "yes")).toEqual({ targetId: "route/then", position: "start" });
  });

  it("is undefined for a step that is not there", () => {
    expect(spotBeforeStep(spec, "nope")).toBeUndefined();
  });
});
