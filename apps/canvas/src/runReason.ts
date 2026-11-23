import { missingSecretNames } from "./secretNames.js";

// ADR-0063 / KAM-270: a failed step in words a support person can act on. The engine and the services it calls
// word a failure for engineers (a status line, a URL with its query, a provider's whole notice). This reads the
// common ones back as a headline and a next step; anything it does not know stays "This step failed", with the
// raw message one click away.

export interface Reason {
  headline: string;
  /** What to do about it, when one thing is clearly the right thing. */
  action?: string;
  /** A recovery the screen can offer as buttons, when there is one. */
  fix?: "replay_missing";
  /** What a count of these reads as, "22 had no recorded answer": a verb phrase, for a banner that counts causes. */
  brief?: string;
  /** True when the headline is a guess from the message's wording rather than a generic fallback. */
  known: boolean;
}

/** `kampong/alpha-vantage.time_series_daily` -> "Alpha Vantage". */
function serviceOf(message: string): string | undefined {
  const component = /Tool "(?:kampong\/)?([a-z0-9][a-z0-9-]*)[.@"]/i.exec(message)?.[1];
  const host = /https?:\/\/(?:www\.)?([a-z0-9-]+)\./i.exec(message)?.[1];
  const raw = component ?? host;
  if (!raw) return undefined;
  return raw
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function explainError(message: string): Reason {
  const service = serviceOf(message);
  const who = service ?? "The service";
  // KAM-281: Replay answers from recordings and never falls back to a live call; this input has none.
  if (/No recorded (model )?fixture/i.test(message)) {
    return {
      headline: "This input has no recorded answer, so Replay cannot run it.",
      action: "Run it live once, or clear the input and use the recorded one.",
      fix: "replay_missing",
      brief: "had no recorded answer",
      known: true,
    };
  }
  const missing = missingSecretNames(message);
  if (missing.length > 0) {
    return {
      headline: `A key this step needs is not set (${missing.join(", ")}).`,
      action: "Add it under Secrets, then run again.",
      brief: `needed a key that is not set (${missing.join(", ")})`,
      known: true,
    };
  }
  if (
    /rate.?limit|too many requests|\b429\b|requests per (day|minute|second)|quota/i.test(message)
  ) {
    return {
      headline: `${service ? `${service}'s` : "The service's"} usage limit was reached.`,
      action: "Wait a while and run again, or use a plan with a higher limit.",
      brief: "hit the usage limit",
      known: true,
    };
  }
  if (
    /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid (api )?key|not authori[sz]ed/i.test(message)
  ) {
    return {
      headline: `${who} did not accept the key.`,
      action: "Check the key is right and has access, under Secrets.",
      brief: "were refused: the key was not accepted",
      known: true,
    };
  }
  if (/\b404\b|not found/i.test(message)) {
    return {
      headline: `${who} could not find what was asked for.`,
      action: "Check the address or the id this step uses.",
      brief: "could not find what was asked for",
      known: true,
    };
  }
  if (/time(d)?[ -]?out|ETIMEDOUT|AbortError|took too long/i.test(message)) {
    return {
      headline: `${who} took too long to answer.`,
      action: "Run again. If it keeps happening, check the service's status page.",
      brief: "took too long to answer",
      known: true,
    };
  }
  if (/\b5\d\d\b|bad gateway|service unavailable|internal server error/i.test(message)) {
    return {
      headline: `${who} had a problem on its side.`,
      action: "Try again in a moment.",
      brief: "hit a problem on the service's side",
      known: true,
    };
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|could not reach|unreachable/i.test(message)) {
    return {
      headline: `Could not reach ${service ?? "the service"}.`,
      action: "Check your connection and the address, then run again.",
      brief: "could not reach the service",
      known: true,
    };
  }
  return { headline: "This step failed.", known: false };
}

/** The message with each URL's query string cut, so a key or a long filter does not fill the screen. */
export function trimUrls(message: string): string {
  return message.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, "$1?…");
}
