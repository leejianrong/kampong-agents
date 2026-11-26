import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeployPanel } from "../../src/DeployPanel.js";
import type { DeployApi, DeployApprovalDto, DeployRunDto, DeploymentDto } from "../../src/api.js";

const DEPLOYED: DeploymentDto = {
  deploymentId: "d1",
  status: "live",
  webhookPath: "/hooks/w/ws1/d1",
};

function fakeApi(over: Partial<DeployApi> = {}): DeployApi {
  return {
    get: vi.fn(async () => null),
    deploy: vi.fn(async () => ({ ...DEPLOYED, webhookSecret: "whsec_abc" })),
    setStatus: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    rotateSecret: vi.fn(async () => "whsec_new"),
    listRuns: vi.fn(async (): Promise<DeployRunDto[]> => []),
    listApprovals: vi.fn(async (): Promise<DeployApprovalDto[]> => []),
    ...over,
  };
}

const run = (over: Partial<DeployRunDto> = {}): DeployRunDto => ({
  id: "r1",
  status: "completed",
  source: "webhook",
  triggeredBy: "webhook",
  startedAt: "2026-11-26T10:00:00.000Z",
  completedAt: "2026-11-26T10:00:05.000Z",
  outcome: "Finished",
  costUsd: null,
  ...over,
});

const panel = (api: DeployApi, approve = vi.fn(async () => ({}))) =>
  render(
    <DeployPanel api={api} approve={approve} origin="https://kampong.example" refreshMs={0} />,
  );

describe("DeployPanel (KAM-326)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers Go live when the spec was never deployed, then shows the address and the secret once", async () => {
    const api = fakeApi();
    panel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));

    expect((await screen.findByTestId("deploy-address")).textContent).toBe(
      "https://kampong.example/hooks/w/ws1/d1",
    );
    expect(screen.getByTestId("deploy-status").textContent).toBe("Live");
    const secret = screen.getByTestId("deploy-secret");
    expect(secret.textContent).toContain("whsec_abc");
    expect(secret.textContent).toContain("shown once");

    // Once dismissed it cannot be shown again.
    fireEvent.click(within(secret).getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByTestId("deploy-secret")).toBeNull();
    expect(document.body.textContent).not.toContain("whsec_abc");
  });

  it("prefers the server's public URL over the page origin", async () => {
    panel(
      fakeApi({
        get: vi.fn(async () => ({
          ...DEPLOYED,
          webhookUrl: "https://kampong.abangai.dev/hooks/w/ws1/d1",
        })),
      }),
    );
    expect((await screen.findByTestId("deploy-address")).textContent).toBe(
      "https://kampong.abangai.dev/hooks/w/ws1/d1",
    );
  });

  it("pauses and resumes", async () => {
    const api = fakeApi({ get: vi.fn(async () => DEPLOYED) });
    panel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.getByTestId("deploy-status").textContent).toBe("Paused"));
    expect(api.setStatus).toHaveBeenCalledWith("paused");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByTestId("deploy-status").textContent).toBe("Live"));
    expect(api.setStatus).toHaveBeenLastCalledWith("live");
  });

  it("rotating shows the new secret once", async () => {
    const api = fakeApi({ get: vi.fn(async () => DEPLOYED) });
    panel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Rotate secret" }));
    expect((await screen.findByTestId("deploy-secret")).textContent).toContain("whsec_new");
  });

  it("deleting asks first, and Keep it changes nothing", async () => {
    const api = fakeApi({ get: vi.fn(async () => DEPLOYED) });
    panel(api);
    fireEvent.click(await screen.findByRole("button", { name: "Delete deployment" }));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete deployment" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    expect(await screen.findByRole("button", { name: "Go live" })).toBeTruthy();
    expect(api.remove).toHaveBeenCalledOnce();
  });

  it("lists recent runs with how they started and ended", async () => {
    panel(
      fakeApi({
        get: vi.fn(async () => DEPLOYED),
        listRuns: vi.fn(async () => [
          run(),
          run({ id: "r2", source: "schedule", outcome: "Rejected", status: "rejected" }),
        ]),
      }),
    );
    const list = await screen.findByTestId("deploy-runs");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list.textContent).toContain("Finished");
    expect(list.textContent).toContain("Web address");
    expect(list.textContent).toContain("Schedule");
  });

  it("approves and rejects a waiting run, then refreshes", async () => {
    const approvals: DeployApprovalDto[] = [
      {
        runId: "r9",
        startedAt: "2026-11-26T10:00:00.000Z",
        step: "refund",
        reason: "Refund over limit",
      },
    ];
    const listApprovals = vi.fn(async () => approvals);
    const approve = vi.fn(async () => ({}));
    panel(fakeApi({ get: vi.fn(async () => DEPLOYED), listApprovals }), approve);

    const list = await screen.findByTestId("deploy-approvals");
    expect(list.textContent).toContain("Refund over limit");
    fireEvent.click(within(list).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("r9", true));
    await waitFor(() => expect(listApprovals.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(within(list).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(approve).toHaveBeenLastCalledWith("r9", false));
  });

  it("says plainly when nothing is waiting or has run", async () => {
    panel(fakeApi({ get: vi.fn(async () => DEPLOYED) }));
    expect(await screen.findByTestId("deploy-no-approvals")).toBeTruthy();
    expect(screen.getByTestId("deploy-no-runs")).toBeTruthy();
  });

  it("shows the server's words when going live is refused", async () => {
    panel(
      fakeApi({
        deploy: vi.fn(async () => {
          throw new Error("This workflow uses a feature hosted cannot run yet.");
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Go live" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(document.body.textContent).toContain("feature hosted cannot run yet");
    expect(screen.queryByTestId("deploy-address")).toBeNull();
  });
});
