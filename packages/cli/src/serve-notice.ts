import { buildSchedule, nextTick } from "@kampong/engine";
import type { AgentSpec } from "@kampong/spec";
import { runDoctor, tcpConnect, type ConnectFn } from "./doctor.js";

// KAM-308: what `kampong serve` says when it starts. It used to start silently with no token, no keys and no model,
// and complain only per request (a bare 401 to the sender, one log line), and it printed `http://0.0.0.0:PORT`,
// an address nobody can paste into Alertmanager. Everything here prints names only, never a value, and never
// refuses to start: a person may set a variable a moment later, or run only the schedule.

/** The address to show a person: `0.0.0.0` and `::` mean "every interface", which is not something to paste. */
export function shownHost(host: string): string {
  return host === "0.0.0.0" || host === "::" || host === "" ? "localhost" : host;
}

const every = (host: string) => host === "0.0.0.0" || host === "::";

function clock(epochMs: number): string {
  // Local time with the offset, to the minute: "2026-11-23 18:00 (+08:00)".
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`;
}

export interface TriggerLinesOptions {
  host: string;
  port: number;
  now?: () => number;
}

/** The "how a run starts" lines for the banner, matching the spec's trigger. */
export function serveTriggerLines(spec: AgentSpec, options: TriggerLinesOptions): string[] {
  const { host, port, now = Date.now } = options;
  const base = `http://${shownHost(host)}:${port}`;
  const trigger = spec.agent.trigger;
  const lines: string[] = [];

  if (trigger?.type === "poll") {
    lines.push(`  trigger: poll ${trigger.use} ${trigger.op} every ${trigger.every}`);
  } else if (trigger?.type === "schedule") {
    const built = buildSchedule(trigger);
    const when = trigger.cron !== undefined ? `cron ${trigger.cron}` : `every ${trigger.every}`;
    const tz = trigger.cron !== undefined ? ` (${trigger.tz ?? "UTC"})` : "";
    if (built.ok) {
      const first = nextTick(built.value, now(), now());
      lines.push(`  trigger: schedule, ${when}${tz}; the first run is at ${clock(first)}`);
    } else {
      lines.push(`  trigger: schedule, ${when}${tz}`);
    }
    lines.push(`  run now: POST ${base}/schedule/run-now`);
  } else {
    lines.push(`  trigger: POST ${base}/webhook`);
  }
  if (every(host)) {
    lines.push(
      "  note:    listening on every network interface; to reach it from another machine use this machine's own address or hostname instead of localhost",
    );
  }
  return lines;
}

export interface StartupFindingsOptions {
  env: NodeJS.ProcessEnv;
  /** Test seam; the real TCP connect otherwise. */
  connect?: ConnectFn;
}

/**
 * What would stop a run, found before the first request: variables that are not set, components that are not
 * installed, and a local model that is not running. Names only. Empty when everything is ready.
 */
export async function serveStartupFindings(
  spec: AgentSpec,
  specPath: string,
  options: StartupFindingsOptions,
): Promise<string[]> {
  const { env, connect = tcpConnect } = options;
  const findings: string[] = [];

  // Offline: no request leaves this machine for these.
  const checks = await runDoctor(spec, specPath, { env, online: false, probe: false });
  for (const check of checks) {
    if (check.status === "pass") continue;
    if (check.area === "env" || check.area === "component" || check.area === "spec") {
      findings.push(check.message);
    }
  }

  // A local model is the one thing worth a connection at start-up: it is on this machine, and "not running" is
  // the most common reason a first run fails.
  const model = spec.agent.model;
  if (model?.provider === "ollama") {
    let target: { host: string; port: number } | undefined;
    try {
      const url = new URL(model.base_url ?? "http://localhost:11434");
      target = {
        host: url.hostname,
        port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      };
    } catch {
      target = undefined;
    }
    if (target) {
      const reason = await connect(target.host, target.port);
      if (reason !== undefined) {
        findings.push(
          `the local model (Ollama) is not reachable at ${target.host}:${target.port} (${reason}); a run that needs it will fail`,
        );
      }
    }
  }
  return findings;
}

/** The warning block for the banner, or no lines when nothing is wrong. */
export function formatFindings(findings: string[]): string[] {
  if (findings.length === 0) return [];
  return [
    `warning: ${findings.length === 1 ? "1 thing" : `${findings.length} things`} to fix before the first run (the service is still up):`,
    ...findings.map((f) => `  - ${f}`),
    "  Run `kampong doctor <spec>` for the full check.",
  ];
}
