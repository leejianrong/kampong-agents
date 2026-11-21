import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DataFields } from "../../src/DataFields.js";

afterEach(cleanup);

// A value that holds more fields sits under its name, so nesting does not squeeze each level into a narrower column.
it("stacks a nested value under its name and keeps a plain value beside it", () => {
  const { container } = render(
    <DataFields
      testId="d"
      value={{ count: 1, tags: ["a", "b"], results: [{ meta: { symbol: "AAPL" } }] }}
    />,
  );
  const rows = [...container.querySelectorAll(":scope .md3-fields > .md3-fields__row")];
  const stacked = (name: string) =>
    rows
      .find((r) => r.querySelector("dt")?.textContent === name)
      ?.classList.contains("md3-fields__row--stack");
  expect(stacked("count")).toBe(false);
  expect(stacked("tags")).toBe(false);
  expect(stacked("results")).toBe(true);
});
