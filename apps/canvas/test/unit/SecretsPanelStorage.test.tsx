import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsPanel } from "../../src/SecretsPanel.js";

// KAM-204: the line under "Add secret" says where a value is kept, and must not claim a local file on the hosted server.

const noop = vi.fn(async () => []);

describe("SecretsPanel storage line (KAM-204)", () => {
  afterEach(cleanup);

  it("names the local file by default", async () => {
    render(<SecretsPanel list={noop} save={noop} remove={noop} />);
    expect(await screen.findByText(/stored on this machine/)).toBeTruthy();
    expect(document.body.textContent).toContain(".kampong/secrets.env");
  });

  it("says the workspace on the server when hosted, and names no local file", async () => {
    render(<SecretsPanel list={noop} save={noop} remove={noop} storage="workspace" />);
    expect(await screen.findByText(/encrypted and kept in this workspace/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(".kampong/secrets.env");
    expect(document.body.textContent).toContain("never shown again");
  });
});
