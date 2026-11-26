import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildActions } from "../../src/actions.js";
import { TopBar } from "../../src/TopBar.js";

// KAM-326: the Deploy verb exists only where the server can deploy, and the top bar draws it.

const ctx = {
  openForm: null,
  yamlOpen: false,
  hasSecrets: false,
  hasChecks: false,
  noSpecYet: false,
  toggleForm: vi.fn(),
  toggleYaml: () => {},
  download: () => {},
};

describe("Deploy action (KAM-326)", () => {
  afterEach(cleanup);

  it("is offered only when the client can deploy", () => {
    expect(buildActions({ ...ctx }).some((a) => a.id === "deploy")).toBe(false);
    expect(buildActions({ ...ctx, hasDeploy: true }).some((a) => a.id === "deploy")).toBe(true);
  });

  it("is not offered before there is a spec to deploy", () => {
    expect(
      buildActions({ ...ctx, hasDeploy: true, noSpecYet: true }).some((a) => a.id === "deploy"),
    ).toBe(false);
  });

  it("is a button in the top bar that opens the panel", () => {
    ctx.toggleForm.mockClear();
    render(
      <TopBar
        name="Refund Agent"
        saveState="saved"
        actions={buildActions({ ...ctx, hasDeploy: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));
    expect(ctx.toggleForm).toHaveBeenCalledWith("deploy");
  });
});
