import type { Trigger } from "./schema.js";

// A short human label for what starts a run (KAM-184), for the trigger node on the canvas: "Schedule: every 6h",
// "Webhook (GitHub)", "Poll: every 5m", or "Manual" when the spec has no trigger. Pure, so the canvas and its
// tests share one reading of the trigger fields.

const PRESET_NAME: Record<string, string> = {
  github: "GitHub",
  slack: "Slack",
  alertmanager: "Alertmanager",
  generic: "generic",
};

export function triggerSummary(trigger: Trigger | undefined): string {
  if (trigger === undefined) return "Manual";
  switch (trigger.type) {
    case "schedule": {
      if (trigger.every !== undefined) return `Schedule: every ${trigger.every}`;
      if (trigger.cron !== undefined) {
        const tz = trigger.tz !== undefined ? ` ${trigger.tz}` : "";
        return `Schedule: cron ${trigger.cron}${tz}`;
      }
      return "Schedule";
    }
    case "webhook": {
      if (trigger.preset !== undefined) {
        return `Webhook (${PRESET_NAME[trigger.preset] ?? trigger.preset})`;
      }
      const auth = trigger.auth;
      if (auth === "none") return "Webhook (no auth)";
      if (auth !== undefined && auth.type !== undefined) {
        return `Webhook (${auth.type === "hmac" ? "HMAC" : auth.type})`;
      }
      return "Webhook";
    }
    case "poll":
      return `Poll: every ${trigger.every}`;
  }
}
