import type { Trigger } from "@kampong/spec";
import type { DoctorCheckDto } from "./api.js";

// KAM-311: Check setup in a person's words. `kampong doctor` words its rows for a developer ("kampong/slack@1.0.0
// resolves (first-party; may do: egress: slack.com; secret slots: token -> slack.com ...)"); the canvas shows
// what to fix first and says it plainly. What doctor checks is unchanged: only how the canvas presents it.

export interface CheckRow {
  status: "pass" | "warn" | "fail" | "unchecked";
  text: string;
  /** The row as the CLI worded it, kept for the tooltip and for finding the missing secret to offer to set. */
  original: string;
}

/** SLACK_BOT_TOKEN -> "Slack bot token". */
export function humanName(env: string): string {
  const words = env.toLowerCase().split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const ENV_NOT_SET = /^([A-Za-z_][A-Za-z0-9_]*) is not set(?: \((.*)\))?$/;
const ENV_SET = /^([A-Za-z_][A-Za-z0-9_]*) is set(?: \((.*)\))?$/;
const COMPONENT_OK = /^(\S+?) resolves(?: and matches its pin)? \(/;
const ASSISTANT = /^the assistant would send prompts and the workflow to (\S+)/;

/** ", used by kampong/slack@1.0.0" from doctor's "secret slot token of kampong/slack@1.0.0". */
function usedBy(what: string | undefined): string {
  if (!what) return "";
  const slot = /^secret slot \S+ of (.+)$/.exec(what);
  return `, used by ${slot ? slot[1] : what}`;
}

function plain(check: DoctorCheckDto, reached: boolean): CheckRow {
  const m = check.message;
  const row = (status: CheckRow["status"], text: string): CheckRow => ({
    status,
    text,
    original: m,
  });
  const unset = ENV_NOT_SET.exec(m);
  if (unset)
    return row(
      check.status,
      `Needs your ${humanName(unset[1]!)} (${unset[1]})${usedBy(unset[2])}.`,
    );
  const set = ENV_SET.exec(m);
  if (set) return row(check.status, `${humanName(set[1]!)} is set.`);
  const comp = COMPONENT_OK.exec(m);
  if (comp) return row(check.status, `${comp[1]} is ready.`);
  const assistant = ASSISTANT.exec(m);
  if (assistant && check.status === "pass" && !reached) {
    return row(
      "unchecked",
      `The assistant would send prompts and the workflow to ${assistant[1]}. Not checked: tick "Also reach each host" to see whether it answers.`,
    );
  }
  return row(check.status, m.charAt(0).toUpperCase() + m.slice(1));
}

/** The trigger as one row. Nothing here is run: a trigger only starts something while `kampong serve` is up. */
export function triggerRow(trigger: Trigger | undefined): CheckRow | undefined {
  if (trigger === undefined) return undefined;
  const what =
    trigger.type === "schedule"
      ? `Schedule, ${trigger.cron !== undefined ? `cron ${trigger.cron}` : `every ${trigger.every}`}`
      : trigger.type === "poll"
        ? `Poll, every ${trigger.every}`
        : "Webhook";
  const text = `${what}: set up correctly. It starts runs only while kampong serve is running; nothing is listening yet.`;
  return { status: "unchecked", text, original: text };
}

export interface Arranged {
  /** Failures, then warnings, then anything not checked: what to look at. */
  attention: CheckRow[];
  passed: CheckRow[];
}

const ORDER = { fail: 0, warn: 1, unchecked: 2, pass: 3 } as const;

export function arrange(
  checks: readonly DoctorCheckDto[],
  options: { reached: boolean; trigger?: Trigger | undefined },
): Arranged {
  const rows = checks.map((c) => plain(c, options.reached));
  const trig = triggerRow(options.trigger);
  if (trig) rows.push(trig);
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ORDER[a.r.status] - ORDER[b.r.status] || a.i - b.i)
    .map((x) => x.r);
  return {
    attention: sorted.filter((r) => r.status !== "pass"),
    passed: sorted.filter((r) => r.status === "pass"),
  };
}
