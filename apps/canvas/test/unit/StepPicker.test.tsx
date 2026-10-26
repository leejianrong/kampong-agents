import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseSpec } from "@kampong/spec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodePalette } from "../../src/NodePalette.js";
import { spotBeforeStep } from "../../src/insertSpot.js";
import { StepPicker } from "../../src/StepPicker.js";
import { BUILT_IN_CONNECTORS, connectorOptions } from "../../src/stepKinds.js";

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
    // KAM-244: a tile is its name; what it does is the tooltip (and the accessible description).
    const foreach = screen.getByRole("option", { name: "Foreach" });
    expect(foreach.getAttribute("title")).toMatch(/Repeat the steps inside/);
    expect(foreach.textContent).toBe("Foreach");
  });

  it("offers a Connectors group in the palette, whose tiles open Add Tool, and a chip for where a step goes", () => {
    const onChooseConnector = vi.fn();
    render(
      <StepPicker
        version="1.1"
        label="Search steps"
        where="Goes at the end"
        connectors={BUILT_IN_CONNECTORS}
        onChooseConnector={onChooseConnector}
        onChoose={() => {}}
      />,
    );
    expect(screen.getByTestId("picker-where").textContent).toBe("Goes at the end");
    const heads = [...document.querySelectorAll(".md3-picker__group")].map((g) => g.textContent);
    expect(heads).toEqual(["Do work", "Work with data", "Control the flow", "Connectors"]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "email" } });
    const tile = screen.getByRole("option", { name: "Gmail" });
    expect(tile.querySelector(".kg-card__letter")?.textContent).toBe("G");
    fireEvent.click(tile);
    expect(onChooseConnector).toHaveBeenCalledWith({ kind: "gmail_send" });
  });

  it("gives a component one tile, its newest version, and lets it replace the built-in of the same name", () => {
    const component = (id: string, version: string) => ({
      id,
      version,
      permissionsSummary: "may call Slack",
    });
    const options = connectorOptions([
      component("kampong/slack", "1.0.0"),
      component("kampong/slack", "1.10.0"),
      component("kampong/slack", "1.9.0"),
    ]);
    expect(options.map((o) => o.id)).toEqual(["gmail", "http", "kampong/slack@1.10.0"]);
    expect(options[2]!.start).toEqual({ kind: "component", use: "kampong/slack@1.10.0" });
    expect(options[2]!.brand).toEqual({ label: "S" });
  });

  it("has no Connectors group on a line's +, which only places steps", () => {
    render(<StepPicker version="1.1" label="Search steps" onChoose={() => {}} />);
    expect(document.body.textContent).not.toContain("Connectors");
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
