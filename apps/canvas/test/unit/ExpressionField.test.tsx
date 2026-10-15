import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { expressionScopeFor, parseSpec } from "@kampong/spec";
import { ExpressionField } from "../../src/ExpressionField.js";

// KAM-160: the expression field. What it says and offers comes from packages/spec (tested there, including
// agreement with the spec loader); this covers what it adds: when it speaks, the keyboard and mouse, and the
// per-line mode.

const SPEC = parseSpec(`version: "1.1"
vars:
  threshold:
    type: number
    default: 5
  symbols:
    type: list
    default: [AAPL]
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: classify
      action: classify
      output_schema:
        type: object
        properties:
          category: { type: string }
          confidence: { type: number }
`).spec!;
const scope = expressionScopeFor(SPEC);

function Harness({
  initial = "",
  lines = false,
  withScope = true,
}: {
  initial?: string;
  lines?: boolean;
  withScope?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ExpressionField
        label="Condition"
        value={value}
        onChange={setValue}
        {...(withScope && { scope })}
        lines={lines}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}
const field = () => screen.getByLabelText("Condition") as HTMLInputElement;
const typeInto = (value: string) => fireEvent.change(field(), { target: { value } });
const options = () =>
  screen.queryAllByRole("option").map((o) => o.querySelector("span")!.textContent);
const value = () => screen.getByTestId("value").textContent;

describe("ExpressionField", () => {
  afterEach(cleanup);

  it("says nothing about an empty field, and nothing about a good expression", () => {
    render(<Harness />);
    expect(screen.queryByText(/Problem:/)).toBeNull();
    typeInto("vars.threshold > classify.confidence");
    expect(screen.queryByText(/Problem:/)).toBeNull();
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("explains a problem as you type, in words, and marks the field invalid", () => {
    render(<Harness />);
    typeInto("vars.thresh > 1");
    expect(
      screen.getByText(
        /Problem: vars.thresh is not declared in vars \(declared: threshold, symbols\)/,
      ),
    ).toBeTruthy();
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBeTruthy();
    typeInto("vars.threshold >");
    expect(screen.getByText(/Problem: .*\(character \d+\)/)).toBeTruthy();
  });

  it("offers completions while a path is typed, and a mouse click accepts one", () => {
    render(<Harness />);
    typeInto("vars.");
    expect(options()).toEqual(["threshold", "symbols"]);
    expect(field().getAttribute("aria-expanded")).toBe("true");
    fireEvent.mouseDown(screen.getByRole("option", { name: /symbols/ }));
    expect(value()).toBe("vars.symbols");
    expect(options()).toEqual([]);
  });

  it("the keyboard moves through the list and Enter or Tab accepts", () => {
    render(<Harness />);
    typeInto("vars.");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /symbols/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(field().getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: /symbols/ }).id,
    );
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(value()).toBe("vars.symbols");

    typeInto("classify.con");
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(value()).toBe("classify.confidence");
  });

  it("Escape closes the list, and typing opens it again", () => {
    render(<Harness />);
    typeInto("vars.");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(options()).toEqual([]);
    typeInto("vars.t");
    expect(options()).toEqual(["threshold"]);
  });

  it("Ctrl+Space lists the roots when nothing is typed", () => {
    render(<Harness />);
    expect(options()).toEqual([]);
    fireEvent.keyDown(field(), { key: " ", ctrlKey: true });
    expect(options()).toEqual(["trigger", "input", "vars", "classify"]);
  });

  it("is a plain text field without a scope: no checks, no list", () => {
    render(<Harness withScope={false} />);
    typeInto("vars.nope >");
    expect(screen.queryByText(/Problem:/)).toBeNull();
    expect(field().getAttribute("role")).toBeNull();
    expect(options()).toEqual([]);
  });

  describe("lines mode (a transform's name: expression list)", () => {
    const area = () => screen.getByLabelText("Condition") as HTMLTextAreaElement;
    const typeLines = (text: string) => fireEvent.change(area(), { target: { value: text } });

    it("checks each line's expression and names the line", () => {
      render(<Harness lines />);
      typeLines("total: 1 + 1\nbad: vars.nope\nalso_bad: classify.confidence >");
      const problems = screen.getAllByText(/Problem:/).map((p) => p.textContent);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toContain("Line 2: vars.nope is not declared in vars");
      expect(problems[1]).toContain("Line 3:");
    });

    it("asks for the colon on a line without one", () => {
      render(<Harness lines />);
      typeLines("total 1 + 1");
      expect(screen.getByText("Problem: Line 1: write name: expression")).toBeTruthy();
    });

    it("completes inside the expression after the colon, not in the name", () => {
      render(<Harness lines />);
      typeLines("total: vars.th");
      expect(options()).toEqual(["threshold"]);
      fireEvent.keyDown(area(), { key: "Enter" });
      expect(value()).toBe("total: vars.threshold");

      typeLines("vars.th");
      expect(options()).toEqual([]);
    });

    it("completes on the line the cursor is on", () => {
      render(<Harness lines />);
      typeLines("a: 1\nb: vars.sy");
      expect(options()).toEqual(["symbols"]);
      fireEvent.keyDown(area(), { key: "Enter" });
      expect(value()).toBe("a: 1\nb: vars.symbols");
    });
  });
});
