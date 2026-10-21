import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoctorPanel } from "../../src/DoctorPanel.js";
import { RunPanel } from "../../src/RunPanel.js";
import { SecretsPanel } from "../../src/SecretsPanel.js";
import type { ApiClient, SecretStatusDto } from "../../src/api.js";
import { missingSecretNames, missingSecretNamesIn } from "../../src/secretNames.js";

// KAM-192: a run or check that says a credential is not set offers "Set it here", which opens the Secrets panel
// on that name.

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
}

describe("missingSecretNames", () => {
  it("reads the name from each way the engine and doctor say a variable is not set", () => {
    expect(
      missingSecretNames(
        'Missing API key: environment variable "OPENROUTER_API_KEY" (required by model provider "openrouter") is not set. Set it in your shell or a local .env file.',
      ),
    ).toEqual(["OPENROUTER_API_KEY"]);
    expect(
      missingSecretNames(
        "Environment variable ALPHAVANTAGE_API_KEY is not set (referenced in a request field).",
      ),
    ).toEqual(["ALPHAVANTAGE_API_KEY"]);
    expect(missingSecretNames("GITHUB_WEBHOOK_SECRET is not set (webhook trigger secret)")).toEqual(
      ["GITHUB_WEBHOOK_SECRET"],
    );
    expect(
      missingSecretNames('tool: config.token reads environment variable "TOKEN", which is not set'),
    ).toEqual(["TOKEN"]);
    expect(
      missingSecretNames(
        'x: environment variable SLACK_BOT_TOKEN is not set (secret slot "token")',
      ),
    ).toEqual(["SLACK_BOT_TOKEN"]);
  });

  it("finds nothing in a message that is not about a missing variable", () => {
    expect(missingSecretNames(undefined)).toEqual([]);
    expect(missingSecretNames("The workflow has errors")).toEqual([]);
    expect(missingSecretNames('environment variable "X" is set')).toEqual([]);
    expect(missingSecretNamesIn(["a", undefined])).toEqual([]);
  });

  it("lists each name once across messages", () => {
    const m = "Environment variable KEY is not set (referenced in a request field).";
    expect(missingSecretNamesIn([m, m, "OTHER is not set (x)"])).toEqual(["KEY", "OTHER"]);
  });
});

function runApi(startRun: ApiClient["startRun"]): ApiClient {
  return {
    startRun,
    approveRun: vi.fn(),
    subscribeToRunEvents: () => () => {},
  } as unknown as ApiClient;
}

describe("RunPanel Set it here", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers it on a start error that names a missing key, and calls back with the name", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onSetSecret = vi.fn();
    const api = runApi(async () => ({
      success: false,
      error:
        'Missing API key: environment variable "OPENROUTER_API_KEY" (required by model provider "openrouter") is not set. Set it in your shell or a local .env file.',
    }));
    render(<RunPanel api={api} onSetSecret={onSetSecret} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const button = await screen.findByRole("button", { name: "Set it here" });
    expect(button.textContent).toBe("Set it here");
    fireEvent.click(button);
    expect(onSetSecret).toHaveBeenCalledWith("OPENROUTER_API_KEY");
  });

  it("offers it for the credential behind failed loop items, and one button per name", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const item = (index: number, name: string) => ({
      index,
      item: index,
      step: "fetch",
      message: `Environment variable ${name} is not set (referenced in a request field).`,
    });
    const api = runApi(async () => ({
      success: true,
      id: "r",
      state: {
        status: "completed",
        trace: [],
        finalOutput: {
          loop: {
            results: [],
            skipped: [],
            count: 3,
            errors: [item(0, "KEY_A"), item(1, "KEY_A"), item(2, "KEY_B")],
          },
        },
      },
    }));
    render(<RunPanel api={api} onSetSecret={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("button", { name: "Set KEY_A here" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set KEY_B here" }).textContent).toBe(
      "Set KEY_B here",
    );
  });

  it("offers it on a failed run, and nothing for an unrelated error or without a Secrets panel", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const failed = (error: string) =>
      runApi(async () => ({
        success: true,
        id: "r",
        state: { status: "failed", trace: [], error },
      }));
    const { unmount } = render(
      <RunPanel
        api={failed("Environment variable K is not set (referenced in a request field).")}
        onSetSecret={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("button", { name: "Set it here" })).toBeTruthy();
    unmount();

    const other = render(<RunPanel api={failed("Boom")} onSetSecret={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("run-halted");
    expect(screen.queryByTestId("run-set-secret")).toBeNull();
    other.unmount();

    render(<RunPanel api={failed("Environment variable K is not set (x).")} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByTestId("run-halted");
    expect(screen.queryByTestId("run-set-secret")).toBeNull();
  });
});

describe("DoctorPanel Set it here", () => {
  afterEach(cleanup);

  it("offers it on a check that says a variable is not set, not on a pass", async () => {
    const onSetSecret = vi.fn();
    render(
      <DoctorPanel
        onSetSecret={onSetSecret}
        run={async () => [
          {
            status: "warn",
            area: "env",
            message: "GITHUB_WEBHOOK_SECRET is not set (webhook trigger secret)",
          },
          { status: "pass", area: "env", message: "OTHER_KEY is set (model key)" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run checks" }));
    const button = await screen.findByRole("button", {
      name: "Set it here for GITHUB_WEBHOOK_SECRET",
    });
    fireEvent.click(button);
    expect(onSetSecret).toHaveBeenCalledWith("GITHUB_WEBHOOK_SECRET");
    expect(screen.getAllByRole("button", { name: /^Set it here/ })).toHaveLength(1);
  });
});

describe("SecretsPanel focus", () => {
  afterEach(cleanup);

  const rows: SecretStatusDto[] = [
    { name: "GITHUB_WEBHOOK_SECRET", source: "unset", referenced: true },
  ];
  const props = {
    list: async () => rows,
    save: vi.fn(async () => rows),
    remove: vi.fn(async () => rows),
  };

  it("lists a needed webhook secret as Needed, not set", async () => {
    render(<SecretsPanel {...props} />);
    expect(await screen.findByText("Needed, not set")).toBeTruthy();
  });

  it("opens the Set form for the asked name, and again for a new request", async () => {
    const { rerender } = render(
      <SecretsPanel {...props} focus={{ name: "ALPHAVANTAGE_API_KEY", nonce: 1 }} />,
    );
    expect(await screen.findByLabelText("New value for ALPHAVANTAGE_API_KEY")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText(/New value for/)).toBeNull());
    rerender(<SecretsPanel {...props} focus={{ name: "ALPHAVANTAGE_API_KEY", nonce: 2 }} />);
    expect(await screen.findByLabelText("New value for ALPHAVANTAGE_API_KEY")).toBeTruthy();
  });
});
