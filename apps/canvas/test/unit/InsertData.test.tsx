import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseExpression, expressionScopeFor, parseSpec } from "@kampong/spec";
import { ExpressionField } from "../../src/ExpressionField.js";
import { emptyTracker, type RunTracker } from "../../src/runStatus.js";
import { RunTrackerProvider, type RunTrackerApi } from "../../src/runTracker.js";
import { SampleDataContext } from "../../src/sampleData.js";

// KAM-218: the Insert data button on an expression field: what it lists, that a click puts the reference at the
// cursor, and that a field with no run yet offers a Replay run instead of values.

const SPEC = parseSpec(`version: "1.1"
vars:
  limit:
    type: number
    default: 5
agent:
  id: a
  name: A
  role: R
  goal: G
  workflow:
    - step: fetch
      action: fetch
      output_schema:
        type: object
        properties:
          price: { type: number }
    - step: report
      type: transform
      set:
        total: fetch.price
`).spec!;
const scope = expressionScopeFor(SPEC, { before: "report" });

const TRACKER: RunTracker = {
  ...emptyTracker,
  runId: "r1",
  entries: { fetch: { outcome: "completed", output: { price: 12.5, symbol: "MSFT" } } },
};
const api = (tracker: RunTracker) => ({ tracker }) as unknown as RunTrackerApi;

function Field({
  initial = "",
  tracker = TRACKER,
  replay,
}: {
  initial?: string;
  tracker?: RunTracker;
  replay?: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RunTrackerProvider value={api(tracker)}>
      <SampleDataContext.Provider value={{ input: "hello", replay }}>
        <ExpressionField label="Value" value={value} onChange={setValue} scope={scope} />
      </SampleDataContext.Provider>
    </RunTrackerProvider>
  );
}

const box = () => screen.getByRole("combobox") as HTMLInputElement;
const open = () => fireEvent.click(screen.getByRole("button", { name: "Insert data" }));

describe("Insert data", () => {
  afterEach(cleanup);

  it("lists the upstream step with the last run's values, and inserts a reference the check accepts", () => {
    render(<Field />);
    open();
    const panel = screen.getByTestId("insert-data");
    const price = within(panel)
      .getAllByTestId("insert-data-item")
      .find((b) => b.textContent?.startsWith("fetch.price"))!;
    expect(price.textContent).toContain("12.5");
    fireEvent.click(price);
    expect(box().value).toBe("fetch.price");
    expect(diagnoseExpression(box().value, scope!)).toEqual([]);
    expect(screen.queryByTestId("insert-data")).toBeNull();
  });

  it("puts the reference at the cursor, not at the end", () => {
    render(<Field initial="1 + 2" />);
    box().focus();
    box().setSelectionRange(4, 4);
    open();
    fireEvent.click(
      within(screen.getByTestId("insert-data"))
        .getAllByTestId("insert-data-item")
        .find((b) => b.textContent?.startsWith("vars.limit"))!,
    );
    expect(box().value).toBe("1 + vars.limit2");
  });

  it("filters by name or value, and Escape closes it and gives focus back to the button", () => {
    render(<Field />);
    open();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search data" }), {
      target: { value: "msft" },
    });
    const items = screen.getAllByTestId("insert-data-item").map((b) => b.textContent);
    expect(items).toHaveLength(1);
    expect(items[0]).toContain("fetch.symbol");
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(screen.queryByTestId("insert-data")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Insert data" }));
  });

  it("with no run yet, lists the known names and offers a Replay run", () => {
    const replay = vi.fn();
    render(<Field tracker={emptyTracker} replay={replay} />);
    open();
    expect(screen.getByTestId("insert-data-empty")).toBeTruthy();
    expect(screen.getAllByTestId("insert-data-item").map((b) => b.textContent)).toContain(
      "fetch.price",
    );
    fireEvent.click(screen.getByTestId("insert-data-replay"));
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("is absent from a field with no scope (a version 1.0 spec)", () => {
    render(<ExpressionField label="Value" value="" onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /Insert data/ })).toBeNull();
  });
});
