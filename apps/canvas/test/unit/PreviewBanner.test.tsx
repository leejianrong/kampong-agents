import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewBanner } from "../../src/PreviewBanner.js";

function stubHealthz(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }) as Response),
  );
}

describe("PreviewBanner (KAM-320)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the operator's notice when /healthz reports one", async () => {
    stubHealthz({ status: "ok", previewNotice: "Preview: no SLA." });
    render(<PreviewBanner />);
    expect((await screen.findByTestId("preview-banner")).textContent).toBe("Preview: no SLA.");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows nothing when there is no notice", async () => {
    stubHealthz({ status: "ok" });
    render(<PreviewBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });

  it("shows nothing when the probe fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    render(<PreviewBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("preview-banner")).toBeNull();
  });
});
