import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageDto } from "../../src/api.js";
import { UsagePanel, formatCost } from "../../src/UsagePanel.js";
import { buildActions } from "../../src/actions.js";

// KAM-325: the Usage panel shows what the server stored, and is honest about cost it could not estimate.

const BASE: UsageDto = {
  from: "2026-11-22",
  to: "2026-11-28",
  totals: { runs: 4, tokensIn: 1840, tokensOut: 360, costUsd: 0.0029, costRuns: 3 },
  days: [
    { day: "2026-11-26", runs: 1, tokensIn: 40, tokensOut: 10, costUsd: null, costRuns: 0 },
    { day: "2026-11-27", runs: 2, tokensIn: 800, tokensOut: 150, costUsd: 0.0015, costRuns: 2 },
    { day: "2026-11-28", runs: 1, tokensIn: 1000, tokensOut: 200, costUsd: 0.0014, costRuns: 1 },
  ],
  deployments: [
    {
      specId: "s1",
      name: "Triage",
      runs: 4,
      tokensIn: 1840,
      tokensOut: 360,
      costUsd: 0.0029,
      costRuns: 3,
    },
  ],
  limits: {
    monthlyRuns: { used: 412, limit: 3000 },
    concurrentRuns: { running: 1, limit: 5 },
    maxRunMinutes: 15,
  },
};

describe("UsagePanel (KAM-325)", () => {
  afterEach(cleanup);

  it("shows the totals, the limits against use, and both tables from what the server said", async () => {
    render(<UsagePanel load={vi.fn(async () => BASE)} />);
    const totals = await screen.findByTestId("usage-totals");
    expect(totals.textContent).toContain("4");
    expect(totals.textContent).toContain("1,840 / 360");
    expect(screen.getByTestId("usage-cost").textContent).toBe("$0.0029");

    const limits = screen.getByTestId("usage-limits");
    expect(limits.textContent).toContain("412 of 3,000");
    expect(limits.textContent).toContain("1 of 5");
    expect(limits.textContent).toContain("stopped after 15 minutes");

    const deployments = within(screen.getByTestId("usage-deployments"));
    expect(deployments.getByText("Triage")).toBeTruthy();
    // Newest day first, token columns added up.
    const rows = within(screen.getByTestId("usage-days")).getAllByRole("row");
    expect(rows[1]!.textContent).toContain("2026-11-28");
    expect(rows[1]!.textContent).toContain("1,200");
  });

  it("says how many runs the cost covers when some had no price, and never shows 0 for no price", async () => {
    render(<UsagePanel load={vi.fn(async () => BASE)} />);
    expect((await screen.findByTestId("usage-cost-note")).textContent).toMatch(/3 of 4 runs/);

    cleanup();
    const unpriced: UsageDto = {
      ...BASE,
      totals: { ...BASE.totals, costUsd: null, costRuns: 0 },
    };
    render(<UsagePanel load={vi.fn(async () => unpriced)} />);
    expect((await screen.findByTestId("usage-cost")).textContent).toBe("No price set");
    expect(screen.getByTestId("usage-cost-note").textContent).toMatch(/No price is set/);
  });

  it("says so when there are no runs, and reloads for another window", async () => {
    const load = vi.fn(async (days: number) =>
      days === 7
        ? {
            ...BASE,
            totals: { runs: 0, tokensIn: 0, tokensOut: 0, costUsd: null, costRuns: 0 },
            days: [],
            deployments: [],
          }
        : BASE,
    );
    render(<UsagePanel load={load} />);
    await screen.findByTestId("usage-totals");
    expect(load).toHaveBeenLastCalledWith(30);
    fireEvent.change(screen.getByLabelText("Show the last"), { target: { value: "7" } });
    await waitFor(() => expect(screen.getByText("No runs in this window.")).toBeTruthy());
    expect(load).toHaveBeenLastCalledWith(7);
  });

  it("shows the server's words when it cannot load", async () => {
    render(
      <UsagePanel load={vi.fn(async () => Promise.reject(new Error("Could not load usage")))} />,
    );
    expect(await screen.findByText(/Could not load usage/)).toBeTruthy();
  });

  it("formats small costs with enough digits to be read", () => {
    expect(formatCost({ runs: 1, tokensIn: 0, tokensOut: 0, costUsd: 0.0014, costRuns: 1 })).toBe(
      "$0.0014",
    );
    expect(formatCost({ runs: 1, tokensIn: 0, tokensOut: 0, costUsd: 12.5, costRuns: 1 })).toBe(
      "$12.50",
    );
  });

  it("is offered in the menu only when the server can report usage", () => {
    const ctx = { openForm: null, yamlOpen: false, hasSecrets: false, hasChecks: false } as never;
    expect(buildActions(ctx).some((a) => a.id === "usage")).toBe(false);
    const withUsage = buildActions({ ...(ctx as object), hasUsage: true } as never);
    expect(withUsage.find((a) => a.id === "usage")?.surface).toBe("menu");
  });
});
