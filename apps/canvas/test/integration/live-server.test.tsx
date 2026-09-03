/** @vitest-environment jsdom */
import { createDevServer } from "@kampong/cli";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.js";

// The real acceptance criterion (SLICES.md V1): a spec written entirely
// outside the app renders on the canvas with zero import step, and a
// canvas action (Add Tool) really mutates the file on disk. This runs the
// real Fastify server from @kampong/cli (not mocked) over real HTTP against
// a real temp file, and renders the real React tree via testing-library --
// about as close to true end-to-end as this suite gets without browser
// automation (no Playwright in this repo yet; that gap is worth flagging,
// not papering over).

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}

const EXTERNALLY_WRITTEN_SPEC = `# Written entirely outside the app, no canvas involved
version: "1.0"
agent:
  id: external-agent
  name: "Externally Authored Agent"
  role: "Ops"
  goal: "Prove zero-import-step rendering."
  workflow:
    - step: do_thing
      action: run
`;

describe("canvas against a real local server (no mocks)", () => {
  let dir: string;
  let specPath: string;
  let layoutPath: string;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kampong-live-"));
    specPath = join(dir, "agent.yaml");
    layoutPath = join(dir, "layout.json");
    writeFileSync(specPath, EXTERNALLY_WRITTEN_SPEC);

    app = createDevServer({ specPath, layoutPath });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = address;

    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders a spec written entirely outside the app with zero import step", async () => {
    render(<App apiBaseUrl={baseUrl} />);

    await waitFor(() => {
      expect(screen.getByText(/Trigger: Externally Authored Agent/)).toBeTruthy();
    });
    expect(screen.getByTestId("yaml-preview").textContent).toContain(
      "Written entirely outside the app",
    );
  });

  it("adding a tool through the canvas really mutates the file on disk, preserving comments", async () => {
    render(<App apiBaseUrl={baseUrl} />);
    await waitFor(() => screen.getByText(/Trigger: Externally Authored Agent/));

    fireEvent.click(screen.getByText("Add Tool"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "check_status" } });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://api.example.com/status" },
    });
    fireEvent.click(screen.getByText("Save Tool"));

    await waitFor(() => {
      const onDisk = readFileSync(specPath, "utf8");
      expect(onDisk).toContain("check_status");
    });
    const onDisk = readFileSync(specPath, "utf8");
    expect(onDisk).toContain("# Written entirely outside the app");
  });
});
