import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentCatalogEntry } from "@kampong/spec";
import { ComponentTrust } from "../../src/ComponentTrust.js";
import { DoctorPanel } from "../../src/DoctorPanel.js";

// KAN-1901: what a component may do, whether a run accepts it, and the review-then-pin step.

afterEach(cleanup);

const entry = (over: Partial<ComponentCatalogEntry> = {}): ComponentCatalogEntry => ({
  id: "acme/tickets",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  permissionsSummary: "reach tickets.example.test; read TICKETS_TOKEN",
  slots: [],
  config: [],
  ops: {},
  ...over,
});

describe("ComponentTrust", () => {
  it("shows what the component may do and its state in words", () => {
    render(<ComponentTrust entry={entry({ pin: { state: "pinned" } })} onPin={vi.fn()} />);
    expect(screen.getByTestId("permissions-summary").textContent).toContain("tickets.example.test");
    expect(screen.getByTestId("pin-state").textContent).toBe("Pinned");
    expect(screen.queryByRole("button", { name: /review and pin/i })).toBeNull();
  });

  it("offers no pin action for a built-in component", () => {
    render(<ComponentTrust entry={entry({ pin: { state: "first-party" } })} onPin={vi.fn()} />);
    expect(screen.getByTestId("pin-state").textContent).toBe("Built in");
    expect(screen.queryByRole("button", { name: /review and pin/i })).toBeNull();
  });

  it("asks for a review before pinning, and pins only when confirmed", async () => {
    const onPin = vi.fn().mockResolvedValue({ ok: true });
    render(<ComponentTrust entry={entry({ pin: { state: "unpinned" } })} onPin={onPin} />);
    expect(screen.getByTestId("pin-state").textContent).toBe("Not pinned");
    fireEvent.click(screen.getByRole("button", { name: /review and pin/i }));
    expect(onPin).not.toHaveBeenCalled();
    expect(screen.getAllByText(/reach tickets.example.test; read TICKETS_TOKEN/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(onPin).toHaveBeenCalledWith("acme/tickets@1.0.0", false, entry().digest),
    );
  });

  it("will not pin a wider grant until the author says they accept it", async () => {
    const onPin = vi.fn().mockResolvedValue({ ok: true });
    render(
      <ComponentTrust
        entry={entry({
          pin: { state: "changed", widened: ["it may now reach evil.example.test"] },
        })}
        onPin={onPin}
      />,
    );
    expect(screen.getByTestId("widened").textContent).toContain("evil.example.test");
    fireEvent.click(screen.getByRole("button", { name: /review and pin/i }));
    const pin = screen.getByRole("button", { name: "Pin" }) as HTMLButtonElement;
    expect(pin.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/accept the wider permissions/i));
    expect(pin.disabled).toBe(false);
    fireEvent.click(pin);
    await waitFor(() =>
      expect(onPin).toHaveBeenCalledWith("acme/tickets@1.0.0", true, entry().digest),
    );
  });

  it("shows the server's reason when pinning is refused, and stays open", async () => {
    const onPin = vi.fn().mockResolvedValue({ ok: false, error: "the update widens it" });
    render(<ComponentTrust entry={entry({ pin: { state: "unpinned" } })} onPin={onPin} />);
    fireEvent.click(screen.getByRole("button", { name: /review and pin/i }));
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    expect((await screen.findByRole("alert")).textContent).toContain("the update widens it");
    expect(screen.getByRole("button", { name: "Pin" })).toBeTruthy();
  });

  it("points at `kampong lock` where the server cannot pin", () => {
    render(<ComponentTrust entry={entry({ pin: { state: "unpinned" } })} />);
    expect(screen.getByText(/kampong lock/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /review and pin/i })).toBeNull();
  });

  it("explains that a changed component is refused by a run until it is pinned again", () => {
    render(<ComponentTrust entry={entry({ pin: { state: "changed" } })} onPin={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toMatch(/refuses it until you review/);
  });

  it("does not carry consent from one component to another when the author switches", () => {
    const widened = (id: string) =>
      entry({
        id,
        digest: `sha256:${id.length.toString().repeat(64).slice(0, 64)}`,
        pin: { state: "changed", widened: [`${id} may now reach more`] },
      });
    const { rerender } = render(
      <ComponentTrust key="a" entry={widened("acme/a")} onPin={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /review and pin/i }));
    fireEvent.click(screen.getByLabelText(/accept the wider permissions/i));
    // ComponentToolForm keys the panel by component and digest.
    rerender(<ComponentTrust key="b" entry={widened("acme/bb")} onPin={vi.fn()} />);
    expect(screen.queryByLabelText(/accept the wider permissions/i)).toBeNull();
    expect(screen.getByRole("button", { name: /review and pin/i })).toBeTruthy();
  });
});

describe("DoctorPanel", () => {
  const checks = [
    { status: "pass" as const, area: "spec" as const, message: "spec is valid" },
    { status: "warn" as const, area: "component" as const, message: "could not be confirmed" },
    { status: "fail" as const, area: "env" as const, message: "TICKETS_TOKEN is not set" },
  ];

  it("runs only the offline checks by default and summarises the result", async () => {
    const run = vi.fn().mockResolvedValue(checks);
    render(<DoctorPanel run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({}));
    expect((await screen.findByTestId("doctor-summary")).textContent).toBe(
      "1 failed, 1 to look at.",
    );
    expect(screen.getByText("TICKETS_TOKEN is not set")).toBeTruthy();
    expect(screen.getByText(/^Failed:/)).toBeTruthy();
  });

  it("reaches hosts, or sends credentials, only through its own explicit buttons", async () => {
    const run = vi.fn().mockResolvedValue([]);
    render(<DoctorPanel run={run} />);
    expect(screen.getByText(/Nothing is sent anywhere/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /also reach each host/i }));
    await waitFor(() => expect(run).toHaveBeenLastCalledWith({ online: true }));
    fireEvent.click(screen.getByRole("button", { name: /also check credentials/i }));
    // Nothing is sent until it is confirmed.
    expect(run).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Send and check" }));
    await waitFor(() => expect(run).toHaveBeenLastCalledWith({ online: true, probe: true }));
    expect(screen.getByText(/carrying each credential/)).toBeTruthy();
  });

  it("says so when everything checked out", async () => {
    render(<DoctorPanel run={vi.fn().mockResolvedValue([checks[0]])} />);
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    expect((await screen.findByTestId("doctor-summary")).textContent).toBe(
      "Everything checked out.",
    );
  });

  it("shows an error rather than nothing when the checks cannot run", async () => {
    render(<DoctorPanel run={vi.fn().mockRejectedValue(new Error("server went away"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    expect((await screen.findByRole("alert")).textContent).toContain("server went away");
  });
});
