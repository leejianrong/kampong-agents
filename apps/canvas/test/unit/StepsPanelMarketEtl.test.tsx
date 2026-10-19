import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSpec } from "@kampong/spec";
import { StepsPanel } from "../../src/StepsPanel.js";

// KAM-163: every editable step of a shipped, valid template opens in the step editor with no error shown and
// no field flagged invalid. `kampong doctor` accepts this spec, so any message on open is a false one.
// jsdom has no file URL for import.meta, so the path is from the repo root vitest runs in.
const SOURCE = readFileSync(
  resolve(process.cwd(), "packages/cli/templates/market-etl/agent.yaml"),
  "utf8",
);

describe("StepsPanel on the market-etl template", () => {
  afterEach(cleanup);

  it("offers an Edit button for every step but the branch, which says why not", () => {
    const { spec, errors } = parseSpec(SOURCE);
    expect(errors).toEqual([]);
    render(<StepsPanel spec={spec!} onPatch={vi.fn(async () => true)} />);
    expect(editable()).toEqual([
      "each_symbol",
      "fetch",
      "check",
      "shape",
      "sane",
      "delta",
      "row",
      "write",
      "summarize",
      "alert",
      "report",
    ]);
    expect(screen.getAllByText(/edited in the YAML for now/)).toHaveLength(1);
  });

  // KAM-164 (scope inside the loop) and KAM-165 (multi-line values) cleared the five that used to fail.
  it.each([
    "fetch",
    "check",
    "shape",
    "sane",
    "delta",
    "row",
    "write",
    "summarize",
    "alert",
    "report",
  ])("opens %s with no error and nothing flagged invalid", opensClean);
});

function opensClean(name: string) {
  const { spec } = parseSpec(SOURCE);
  render(<StepsPanel spec={spec!} onPatch={vi.fn(async () => true)} />);
  fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
  const problems = [...document.querySelectorAll(".md3-expression__problems li")].map(
    (li) => li.textContent,
  );
  expect(problems).toEqual([]);
  expect(document.querySelector("[aria-invalid='true']")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
}

function editable(): string[] {
  return screen
    .getAllByRole("button", { name: /^Edit / })
    .map((b) => b.getAttribute("aria-label")!.slice("Edit ".length));
}
