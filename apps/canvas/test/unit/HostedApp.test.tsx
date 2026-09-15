import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedApp } from "../../src/HostedApp.js";

// KAN-1228 (ADR-0020): drives the hosted shell's state machine end to end
// against a routed fetch double -- loading -> auth -> workspace -> spec list ->
// editor, plus sign-out back to auth. The session is mutable so `getSession`
// returns "signed out", then "no workspace", then "active workspace" across
// the progression, exactly as Better Auth's own endpoints would after each
// step stamps the session.

beforeAll(() => {
  // @xyflow/react (the editor's Canvas) uses ResizeObserver, absent in jsdom.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource ??= class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    close() {}
    constructor(public url: string) {}
  };
});

const SPEC_LOAD = {
  success: true,
  spec: {
    version: "1.0",
    agent: {
      id: "greeter",
      name: "Greeter",
      role: "Front desk",
      goal: "Greet visitors.",
      workflow: [{ step: "greet", action: "generate_text" }],
    },
  },
  errors: [],
  layout: {},
  source: "version: '1.0'\n",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

interface MockState {
  session: null | { activeOrganizationId: string | null };
  specs: { id: string; name: string }[];
}

function installFetch(state: MockState) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url, "http://localhost").pathname;
    const key = `${method} ${path}`;

    switch (key) {
      case "GET /api/auth/get-session":
        return jsonResponse(
          200,
          state.session
            ? { user: { id: "u1", email: "dev@example.com", name: "Dev" }, session: state.session }
            : null,
        );
      case "POST /api/auth/sign-in/email":
        state.session = { activeOrganizationId: null };
        return jsonResponse(200, { token: "t" });
      case "POST /api/auth/sign-out":
        state.session = null;
        return jsonResponse(200, {});
      case "POST /api/auth/organization/create":
        return jsonResponse(200, { id: "w1", name: "Acme", slug: "acme-x" });
      case "POST /api/auth/organization/set-active":
        state.session = { activeOrganizationId: "w1" };
        return jsonResponse(200, { id: "w1" });
      case "GET /api/auth/organization/list":
        return jsonResponse(200, []);
      case "GET /api/specs":
        return jsonResponse(200, { success: true, specs: state.specs });
      case "POST /api/specs":
        state.specs = [...state.specs, { id: "s1", name: "Support" }];
        return jsonResponse(201, { success: true, id: "s1", name: "Support" });
      case "GET /api/specs/s1":
        return jsonResponse(200, SPEC_LOAD);
      default:
        throw new Error(`unrouted ${key}`);
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("HostedApp", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", (globalThis as unknown as { EventSource: unknown }).EventSource);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the login screen when there is no session", async () => {
    installFetch({ session: null, specs: [] });
    render(<HostedApp />);
    expect(await screen.findByTestId("auth-screen")).toBeTruthy();
  });

  it("signs in, creates a workspace, lands on the spec list, and opens the editor", async () => {
    installFetch({ session: null, specs: [] });
    render(<HostedApp />);

    // Auth screen -> sign in.
    await screen.findByTestId("auth-screen");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dev@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // No active workspace yet -> workspace screen. Create one.
    await screen.findByTestId("workspace-screen");
    fireEvent.change(screen.getByLabelText("New workspace name"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    // Active workspace -> spec list (empty), create a spec, open the editor.
    await screen.findByTestId("spec-list-empty");
    fireEvent.change(screen.getByLabelText("New agent name"), { target: { value: "Support" } });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    // Editor is the same App, bound to /api/specs/s1.
    await waitFor(() => expect(screen.getByText(/Trigger: Greeter/)).toBeTruthy());
    expect(screen.getByTestId("back-to-specs")).toBeTruthy();
  });

  it("goes straight to the spec list when already signed in with an active workspace", async () => {
    installFetch({
      session: { activeOrganizationId: "w1" },
      specs: [{ id: "s1", name: "Support" }],
    });
    render(<HostedApp />);

    await screen.findByTestId("spec-list");
    expect(await screen.findByText("Support")).toBeTruthy();
    expect(screen.getByTestId("hosted-user").textContent).toContain("dev@example.com");
  });

  it("navigates to the BYOK screen and back", async () => {
    // This test needs the BYOK route too, so it installs its own fetch double.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, "http://localhost").pathname;
        const method = init?.method ?? "GET";
        if (path === "/api/auth/get-session")
          return jsonResponse(200, {
            user: { id: "u1", email: "dev@example.com", name: "Dev" },
            session: { activeOrganizationId: "w1" },
          });
        if (path === "/api/specs") return jsonResponse(200, { success: true, specs: [] });
        if (path === "/api/byok" && method === "GET")
          return jsonResponse(200, { success: true, keys: [] });
        throw new Error(`unrouted ${method} ${path}`);
      }),
    );
    render(<HostedApp />);

    await screen.findByTestId("spec-list");
    fireEvent.click(screen.getByTestId("nav-byok"));
    await screen.findByTestId("byok-screen");
    expect(screen.getByTestId("byok-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("byok-back"));
    await screen.findByTestId("spec-list");
  });

  it("signs out back to the login screen", async () => {
    installFetch({ session: { activeOrganizationId: "w1" }, specs: [] });
    render(<HostedApp />);

    await screen.findByTestId("spec-list");
    fireEvent.click(screen.getByTestId("nav-signout"));
    await screen.findByTestId("auth-screen");
  });
});
