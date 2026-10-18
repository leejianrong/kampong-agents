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

  it("offers an Edit button for every transform, validate and action step", () => {
    const { spec, errors } = parseSpec(SOURCE);
    expect(errors).toEqual([]);
    render(<StepsPanel spec={spec!} onPatch={vi.fn(async () => true)} />);
    expect(editable()).toEqual(["check", "shape", "sane", "delta", "row", "summarize", "report"]);
  });

  // The two steps that read the loop's own steps (KAM-164) and the three whose values span several lines
  // (KAM-165) fail today. `it.fails` keeps CI green and turns red the moment a fix lands, which is the cue to
  // move that name into OPENS_CLEAN.
  const OPENS_CLEAN = ["summarize", "report"];
  const STILL_FAILING = ["check", "shape", "sane", "delta", "row"];

  it.each(OPENS_CLEAN)("opens %s with no error and nothing flagged invalid", opensClean);
  it.fails.each(STILL_FAILING)("opens %s with no error and nothing flagged invalid", opensClean);
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
