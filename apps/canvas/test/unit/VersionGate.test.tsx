import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PatchOp } from "@kampong/spec";
import { UpgradeContext } from "../../src/UpgradeContext.js";
import { VersionGate } from "../../src/VersionGate.js";

// KAM-199: the version notice offers an upgrade where the app can write the spec, shows exactly what changes
// before anything is written, and refuses (with the reasons) when the result would not load.

const SOURCE = `version: "1.0"
agent:
  id: a
  name: A
  role: R
  goal: G
  tools:
    - name: lookup
      action: http_request
      method: GET
      url: "https://x.example/{classify.label}"
  workflow:
    - step: classify
      action: classify
`;

function setup(source = SOURCE, apply = vi.fn(async (_ops: PatchOp[]) => true)) {
  render(
    <UpgradeContext.Provider value={{ source, apply }}>
      <VersionGate what="Vars" />
    </UpgradeContext.Provider>,
  );
  return { apply };
}

describe("VersionGate", () => {
  afterEach(cleanup);

  it("without an app that can write the spec, only says to change the version", () => {
    render(<VersionGate what="Vars" />);
    expect(screen.getByRole("status").textContent).toContain('Vars need spec version "1.1"');
    expect(screen.getByRole("status").textContent).toContain("Change version in the YAML");
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();
  });

  it("shows nothing about the change until asked, then the diff and what was rewritten", () => {
    setup();
    expect(screen.queryByRole("region", { name: "Upgrade to 1.1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to 1.1…" }));
    const panel = screen.getByRole("region", { name: "Upgrade to 1.1" });
    const diff = within(panel).getByLabelText("Changes to the YAML").textContent;
    expect(diff).toContain('- version: "1.0"');
    expect(diff).toContain('+ version: "1.1"');
    expect(diff).toContain('+       url: "https://x.example/{{ classify.label }}"');
    expect(panel.textContent).toContain('Tool "lookup".url: {classify.label} becomes {{ … }}');
  });

  it("applies the previewed patch only when Upgrade is pressed, then closes", async () => {
    const { apply } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to 1.1…" }));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toEqual([
      { op: "set", path: ["version"], value: "1.1" },
      {
        op: "set",
        path: ["agent", "tools", 0, "url"],
        value: "https://x.example/{{ classify.label }}",
      },
    ]);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Upgrade to 1.1" })).toBeNull(),
    );
  });

  it("keeps the preview open and says nothing changed when the save fails", async () => {
    setup(
      SOURCE,
      vi.fn(async () => false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to 1.1…" }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("nothing was changed"),
    );
    expect(screen.getByRole("region", { name: "Upgrade to 1.1" })).toBeTruthy();
  });

  it("cancels without writing", () => {
    const { apply } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to 1.1…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Upgrade to 1.1" })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it("refuses a spec that would not load as 1.1, listing why, with no Upgrade button", () => {
    setup(SOURCE.replace("{classify.label}", "{order_id}"));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to 1.1…" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Line \d+: .*order_id/);
    expect(screen.getByRole("region", { name: "Upgrade to 1.1" }).textContent).toContain(
      "nothing was changed",
    );
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    // and says what to do about it
    expect(screen.getByRole("region", { name: "Upgrade to 1.1" }).textContent).toContain(
      "1.1 needs the step named too",
    );
  });
});
