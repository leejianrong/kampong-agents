import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulePreviewNote, describeInterval, formatRun } from "../../src/SchedulePreviewNote.js";
import { SecretsPanel } from "../../src/SecretsPanel.js";
import { TriggerPanel } from "../../src/TriggerPanel.js";
import { PanelFooter } from "../../src/Panel.js";

// KAM-197: a schedule says what it means, when it next runs and when it is too frequent; a disabled Save says why.

// Wednesday 2026-10-21 10:30:00 UTC
const NOW = Date.UTC(2026, 9, 21, 10, 30, 0);

describe("formatRun and describeInterval", () => {
  it("writes a run time in the schedule's own zone", () => {
    expect(formatRun(Date.UTC(2026, 9, 22, 1, 0), "Asia/Singapore")).toBe("Thu 22 Oct, 09:00");
    expect(formatRun(Date.UTC(2026, 9, 22, 1, 0), "UTC")).toBe("Thu 22 Oct, 01:00");
  });

  it("says an interval the way a person would", () => {
    expect(describeInterval(10_000)).toBe("every 10 seconds");
    expect(describeInterval(1000)).toBe("every second");
    expect(describeInterval(90_000)).toBe("every 90 seconds");
    expect(describeInterval(900_000)).toBe("every 15 minutes");
    expect(describeInterval(3_600_000)).toBe("every hour");
    expect(describeInterval(7_200_000)).toBe("every 2 hours");
    expect(describeInterval(86_400_000)).toBe("every day");
  });
});

describe("SchedulePreviewNote", () => {
  afterEach(cleanup);

  it("shows the words and the next three runs of a cron, in its zone", () => {
    render(<SchedulePreviewNote cron="0 9 * * *" tz="Asia/Singapore" now={NOW} />);
    expect(screen.getByTestId("schedule-words").textContent).toBe("Runs at 09:00 every day.");
    expect(screen.getByTestId("schedule-next").textContent).toBe(
      "Next runs (Asia/Singapore): Thu 22 Oct, 09:00; Fri 23 Oct, 09:00; Sat 24 Oct, 09:00",
    );
    expect(screen.queryByTestId("schedule-warning")).toBeNull();
  });

  it("warns on a cron that runs every minute", () => {
    render(<SchedulePreviewNote cron="* * * * *" now={NOW} />);
    expect(screen.getByTestId("schedule-warning").textContent).toMatch(/runs every minute/);
    // A word and a glyph, not colour alone.
    expect(screen.getByTestId("schedule-warning").textContent).toContain("⚠");
  });

  it("warns on an interval under a minute and not on one over", () => {
    const { rerender } = render(<SchedulePreviewNote every="10s" now={NOW} />);
    expect(screen.getByText("Runs every 10 seconds.")).toBeTruthy();
    expect(screen.getByTestId("schedule-warning").textContent).toMatch(/more than once a minute/);
    rerender(<SchedulePreviewNote every="15m" now={NOW} />);
    expect(screen.getByText("Runs every 15 minutes.")).toBeTruthy();
    expect(screen.queryByTestId("schedule-warning")).toBeNull();
  });

  it("says nothing while the text is blank, half-typed or wrong: the save reports that", () => {
    const { rerender } = render(<SchedulePreviewNote cron="" now={NOW} />);
    expect(screen.queryByTestId("schedule-preview")).toBeNull();
    rerender(<SchedulePreviewNote cron="0 9 *" now={NOW} />);
    expect(screen.queryByTestId("schedule-preview")).toBeNull();
    rerender(<SchedulePreviewNote cron="0 9 * * *" tz="Mars/Olympus" now={NOW} />);
    expect(screen.queryByTestId("schedule-preview")).toBeNull();
  });
});

describe("TriggerPanel schedule help", () => {
  afterEach(cleanup);

  function open() {
    render(
      <TriggerPanel
        version="1.1"
        trigger={undefined}
        onSave={vi.fn(async () => true)}
        onRemove={vi.fn(async () => true)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
  }

  it("explains the cron field, and previews it as it is typed", () => {
    open();
    expect(
      screen.getByText(/Five fields: minute hour day-of-month month day-of-week/),
    ).toBeTruthy();
    expect(screen.queryByTestId("schedule-preview")).toBeNull();
    fireEvent.change(screen.getByLabelText("Cron", { exact: false }), {
      target: { value: "*/5 * * * *" },
    });
    expect(screen.getByTestId("schedule-words").textContent).toBe("Runs every 5 minutes.");
    expect(screen.getByTestId("schedule-next").textContent).toMatch(/^Next runs \(UTC\): /);
    fireEvent.change(screen.getByLabelText("Cron", { exact: false }), {
      target: { value: "* * * * *" },
    });
    expect(screen.getByTestId("schedule-warning")).toBeTruthy();
  });

  it("warns on an interval under a minute", () => {
    open();
    fireEvent.change(screen.getByLabelText("Runs", { exact: false }), {
      target: { value: "every" },
    });
    fireEvent.change(screen.getByLabelText("Every", { exact: false }), {
      target: { value: "10s" },
    });
    expect(screen.getByTestId("schedule-warning").textContent).toMatch(/every 10 seconds/);
  });
});

describe("a disabled Save says why", () => {
  afterEach(cleanup);

  it("PanelFooter ties the reason to Save while it is disabled, and drops it when it is not", () => {
    const { rerender } = render(
      <PanelFooter save="Save" disabled disabledReason="Enter a value to save." />,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const reason = screen.getByText("Enter a value to save.");
    expect(save.getAttribute("aria-describedby")).toBe(reason.id);
    expect(save.getAttribute("aria-description") ?? "").toBe("");
    rerender(<PanelFooter save="Save" disabled={false} disabledReason="Enter a value to save." />);
    expect(screen.queryByText("Enter a value to save.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("the Secrets form names what is missing: the name, a valid name, then the value", async () => {
    render(<SecretsPanel list={async () => []} save={async () => []} remove={async () => []} />);
    fireEvent.click(await screen.findByRole("button", { name: /add|set a/i }));
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(screen.getByText("Enter a name to save.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bad name!" } });
    expect(screen.getByText(/letters, digits and underscores/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "SLACK_BOT_TOKEN" } });
    expect(screen.getByText("Enter a value to save.")).toBeTruthy();
    expect(save().getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "xoxb-1" } });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText("Enter a value to save.")).toBeNull();
  });
});
