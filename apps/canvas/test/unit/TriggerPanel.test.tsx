import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Trigger } from "@kampong/spec";
import { TriggerPanel } from "../../src/TriggerPanel.js";

// KAM-161: the trigger panel. The form logic is tested in packages/spec (trigger-form.test.ts); this covers what
// the panel adds: the summary, the add/edit/remove flow, the expression fields and the version gate.

function setup(props: Partial<React.ComponentProps<typeof TriggerPanel>> = {}) {
  const onSave = vi.fn(async (_value: Trigger) => true);
  const onRemove = vi.fn(async () => true);
  render(
    <TriggerPanel
      version="1.1"
      trigger={undefined}
      onSave={onSave}
      onRemove={onRemove}
      {...props}
    />,
  );
  return { onSave, onRemove };
}
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("TriggerPanel", () => {
  afterEach(cleanup);

  // KAM-317: from the panel to a first accepted request.
  it("shows the command, URL, header and a curl for a bearer webhook, reading the secret from its variable", () => {
    setup({
      local: true,
      trigger: { type: "webhook", preset: "alertmanager", auth: { secret_env: "ALERT_TOKEN" } },
    } as never);
    const block = screen.getByTestId("trigger-golive");
    expect(block.textContent).toContain("kampong serve agent.yaml");
    expect(block.textContent).toContain("ALERT_TOKEN");
    expect(block.textContent).toContain("http://localhost:8080/webhook");
    const curl = screen.getByTestId("trigger-curl").textContent ?? "";
    expect(curl).toContain("authorization: Bearer ");
    expect(curl).not.toMatch(/Bearer [a-z0-9]{16}/i);
  });

  it("names the signature header for a signed webhook and gives no hand-made curl", () => {
    setup({
      local: true,
      trigger: { type: "webhook", preset: "github", auth: { secret_env: "GH_SECRET" } },
    } as never);
    expect(screen.getByTestId("trigger-golive").textContent).toContain("X-Hub-Signature-256");
    expect(screen.queryByTestId("trigger-curl")).toBeNull();
  });

  it("says an open webhook needs nothing, and shows nothing for a schedule or on the hosted server", () => {
    setup({ local: true, trigger: { type: "webhook" } as never });
    expect(screen.getByTestId("trigger-golive").textContent).toContain("open");
    expect(screen.getByTestId("trigger-curl").textContent).not.toContain("authorization");
    cleanup();
    setup({ local: true, trigger: { type: "schedule", every: "5m" } });
    expect(screen.queryByTestId("trigger-golive")).toBeNull();
    cleanup();
    setup({ trigger: { type: "webhook" } as never });
    expect(screen.queryByTestId("trigger-golive")).toBeNull();
  });

  it("says so when there is no trigger", () => {
    setup();
    expect(screen.getByText("This spec has no trigger.")).toBeTruthy();
  });

  it("says a trigger does not fire by itself while building locally, and links to how to deploy (KAM-289)", () => {
    setup({ local: true, trigger: { type: "schedule", every: "5m" } });
    const note = screen.getByTestId("trigger-local-note");
    expect(note.textContent).toContain("does not start by itself");
    expect(note.textContent).toContain("only when you press Run");
    const link = within(note).getByRole("link", { name: /deploy/i });
    expect(link.getAttribute("href")).toContain("kampong-serve");
  });

  it("says it for a webhook and a poll too, and not when there is no trigger or on the hosted server", () => {
    for (const trigger of [
      { type: "webhook", preset: "github", auth: { secret_env: "S" } },
      { type: "poll", every: "5m", use: "kampong/gmail-imap@1.0.0", op: "list_unseen", id: "uid" },
    ] as unknown as Trigger[]) {
      cleanup();
      setup({ local: true, trigger });
      expect(screen.getByTestId("trigger-local-note")).toBeTruthy();
    }
    cleanup();
    setup({ local: true });
    expect(screen.queryByTestId("trigger-local-note")).toBeNull();
    cleanup();
    setup({ trigger: { type: "schedule", every: "5m" } });
    expect(screen.queryByTestId("trigger-local-note")).toBeNull();
  });

  it("summarises each kind of trigger", () => {
    const cases: [Trigger, RegExp][] = [
      [{ type: "webhook", preset: "github", auth: { secret_env: "S" } }, /github preset, async/],
      [{ type: "schedule", cron: "0 9 * * *" }, /cron 0 9 \* \* \*/],
      [
        {
          type: "poll",
          every: "5m",
          use: "kampong/github@1.0.0",
          op: "list",
          id: "n",
          dedupe: "unique",
        },
        /every 5m: kampong\/github@1\.0\.0 list, unique by n/,
      ],
    ];
    for (const [trigger, expected] of cases) {
      setup({ trigger });
      expect(screen.getByTestId("trigger-summary").textContent).toMatch(expected);
      cleanup();
    }
  });

  it("adds a webhook with a preset: validates, then saves the built trigger", async () => {
    const { onSave } = setup();
    click("Add webhook");
    type("Preset", "github");
    click("Save trigger");
    expect(screen.getByRole("alert").textContent).toContain("secret_env");
    expect(onSave).not.toHaveBeenCalled();

    type("Secret variable name", "GITHUB_WEBHOOK_SECRET");
    click("Save trigger");
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        type: "webhook",
        preset: "github",
        auth: { secret_env: "GITHUB_WEBHOOK_SECRET" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("form", { name: "Trigger" })).toBeNull());
  });

  it("never accepts a literal secret and does not echo it", () => {
    const { onSave } = setup();
    click("Add webhook");
    type("Authentication", "bearer");
    type("Secret variable name", "sk-live-abc123");
    click("Save trigger");
    expect(screen.getByRole("alert").textContent).toContain("NAME of an environment variable");
    expect(screen.getByRole("alert").textContent).not.toContain("sk-live-abc123");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the hmac fields only for hmac, and the timeout only for sync", () => {
    setup();
    click("Add webhook");
    expect(screen.queryByLabelText("Signature header")).toBeNull();
    expect(screen.queryByLabelText("Timeout (ms)")).toBeNull();
    type("Authentication", "hmac");
    expect(screen.getByLabelText("Signature header")).toBeTruthy();
    type("Response", "sync");
    expect(screen.getByLabelText("Timeout (ms)")).toBeTruthy();
  });

  it("checks when as an ingress expression: only trigger is readable", () => {
    setup();
    click("Add webhook");
    type("When", "vars.x = 1");
    expect(screen.getByText(/not available when a request arrives/)).toBeTruthy();
    type("When", "trigger.body.ok");
    expect(screen.queryByText(/not available when a request arrives/)).toBeNull();
  });

  it("completes trigger. in a map line", () => {
    setup();
    click("Add webhook");
    const map = screen.getByLabelText("Map", { exact: false }) as HTMLTextAreaElement;
    fireEvent.change(map, { target: { value: "repo: trigger." } });
    map.setSelectionRange(14, 14);
    fireEvent.keyUp(map);
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining("headers"), expect.stringContaining("body")]);
  });

  it("builds a schedule, switching between cron and an interval", async () => {
    const { onSave } = setup();
    click("Add schedule");
    type("Cron", "0 9 * * 1-5");
    type("Time zone", "Asia/Singapore");
    click("Save trigger");
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        type: "schedule",
        cron: "0 9 * * 1-5",
        tz: "Asia/Singapore",
      }),
    );
  });

  it("shows a schedule's interval field when switched, and says what is wrong", () => {
    setup();
    click("Add schedule");
    type("Runs", "every");
    expect(screen.queryByLabelText("Cron")).toBeNull();
    type("Every", "often");
    click("Save trigger");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("builds a poll and refuses a literal secret", async () => {
    const { onSave } = setup();
    click("Add poll");
    type("Every", "15m");
    type("Component", "kampong/github@1.0.0");
    type("Op", "list_issues");
    type("Arguments", '{"repo": "a/b"}');
    type("Secrets", "token: ghp_real");
    type("Item id", "number");
    click("Save trigger");
    expect(screen.getByRole("alert").textContent).toContain("secrets.token must reference");
    expect(screen.getByRole("alert").textContent).not.toContain("ghp_real");

    type("Secrets", "token: ${GITHUB_TOKEN}");
    click("Save trigger");
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        type: "poll",
        every: "15m",
        use: "kampong/github@1.0.0",
        op: "list_issues",
        with: { repo: "a/b" },
        secrets: { token: "${GITHUB_TOKEN}" },
        id: "number",
        dedupe: "unique",
      }),
    );
  });

  // KAM-313: Component and Op are picked from what is installed, and a wrong pair is refused with what exists.
  describe("a poll's component and op, with the installed components known", () => {
    const entry = (id: string, ops: string[]) =>
      ({
        id,
        version: "1.0.0",
        ops: Object.fromEntries(ops.map((o) => [o, { effect: "read" }])),
      }) as never;
    const components = [
      entry("kampong/gmail-imap", ["list_unseen", "get_message"]),
      entry("kampong/github", ["get_user"]),
    ];

    it("offers the installed components, then that component's ops", () => {
      setup({ components });
      click("Add poll");
      const component = screen.getByLabelText("Component") as HTMLSelectElement;
      expect([...component.options].map((o) => o.value)).toEqual([
        "",
        "kampong/gmail-imap@1.0.0",
        "kampong/github@1.0.0",
      ]);
      fireEvent.change(component, { target: { value: "kampong/github@1.0.0" } });
      const op = screen.getByLabelText("Op") as HTMLSelectElement;
      expect([...op.options].map((o) => o.value)).toEqual(["", "get_user"]);
    });

    it("refuses a saved poll whose op the component does not have, naming the ones it does", () => {
      const { onSave } = setup({
        components,
        trigger: {
          type: "poll",
          every: "5m",
          use: "kampong/github@1.0.0",
          op: "list_issues",
          id: "number",
          dedupe: "unique",
        } as never,
      });
      click("Edit trigger");
      // The stale op stays visible in the list, marked, so nothing silently changes.
      expect((screen.getByLabelText("Op") as HTMLSelectElement).textContent).toContain(
        "list_issues (not in this component)",
      );
      click("Save trigger");
      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toContain(
        'kampong/github@1.0.0 has no op "list_issues". It has: get_user.',
      );
    });

    it("pollPairProblem says what is wrong and what exists", async () => {
      const { pollPairProblem } = await import("../../src/TriggerPanel.js");
      expect(pollPairProblem({ use: "kampong/github@1.0.0", op: "list_issues" }, components)).toBe(
        'kampong/github@1.0.0 has no op "list_issues". It has: get_user.',
      );
      expect(pollPairProblem({ use: "kampong/nothing@1.0.0", op: "x" }, components)).toContain(
        "is not installed here. Installed: kampong/gmail-imap@1.0.0, kampong/github@1.0.0",
      );
      expect(
        pollPairProblem({ use: "kampong/github@1.0.0", op: "get_user" }, components),
      ).toBeUndefined();
      // Where the installed components are not known (hosted), nothing is refused here.
      expect(pollPairProblem({ use: "a@1.0.0", op: "x" }, undefined)).toBeUndefined();
    });
  });

  it("asks for a window with time_window dedupe", () => {
    setup();
    click("Add poll");
    expect(screen.queryByLabelText("Window")).toBeNull();
    type("New means", "time_window");
    expect(screen.getByLabelText("Window")).toBeTruthy();
  });

  it("edits the current trigger in place, with its values filled in", async () => {
    const { onSave } = setup({ trigger: { type: "schedule", every: "1h" } });
    click("Edit trigger");
    expect((screen.getByLabelText("Every", { exact: false }) as HTMLInputElement).value).toBe("1h");
    type("Every", "2h");
    click("Save trigger");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ type: "schedule", every: "2h" }));
  });

  // KAM-194: a failed save keeps the form and its input; the panel shell explains the failure in the server's
  // words (App.test and live-server.test cover that), so the panel adds no second, generic message.
  it("keeps the form open when the save fails, and adds no message of its own", async () => {
    const { onSave } = setup({ trigger: { type: "webhook" } });
    onSave.mockResolvedValueOnce(false);
    click("Edit trigger");
    click("Save trigger");
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("form", { name: "Trigger" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("try again");
  });

  it("clears a form-level problem when the input changes", () => {
    const { onSave } = setup({ version: "1.0" });
    click("Add webhook");
    type("When", "x");
    click("Save trigger");
    expect(screen.getByRole("alert").textContent).toContain('when needs version "1.1"');
    type("When", "");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not send a save to the server while a field is already saying what is wrong", () => {
    const { onSave } = setup();
    click("Add webhook");
    type("When", "vars.x = 1");
    expect(screen.getAllByText(/not available when a request arrives/)).toHaveLength(1);
    click("Save trigger");
    expect(onSave).not.toHaveBeenCalled();
    // Still one message, not the same problem again in a second place, and the field has focus.
    expect(screen.getAllByText(/not available when a request arrives/)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("When", { exact: false }));
  });

  it("removes the trigger", async () => {
    const { onRemove } = setup({ trigger: { type: "webhook" } });
    click("Remove trigger");
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
  });

  it("cancels without saving", () => {
    const { onSave } = setup();
    click("Add webhook");
    click("Cancel");
    expect(screen.queryByRole("form", { name: "Trigger" })).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("on a 1.0 spec offers only a bare webhook and does not offer to upgrade", () => {
    const { onSave } = setup({ version: "1.0" });
    expect(screen.getByRole("status").textContent).toContain('"1.1"');
    expect(
      (screen.getByRole("button", { name: "Add schedule" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Add poll" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: /upgrade/i })).toBeNull();

    click("Add webhook");
    // Expression fields are plain text here: nothing is checked as an expression.
    type("When", "vars.x = 1");
    expect(screen.queryByText(/not available when a request arrives/)).toBeNull();
    click("Save trigger");
    expect(screen.getByRole("alert").textContent).toContain('when needs version "1.1"');
    expect(onSave).not.toHaveBeenCalled();

    type("When", "");
    click("Save trigger");
    return waitFor(() => expect(onSave).toHaveBeenCalledWith({ type: "webhook" }));
  });
});
