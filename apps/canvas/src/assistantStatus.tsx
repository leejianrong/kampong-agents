import type { AssistantStatus } from "./api.js";

// ADR-0063 / KAM-282: one way of saying the assistant is not available, and what a failed prompt means, in words a
// person who does not run servers can act on. The technical text (an environment variable, a host) is behind a
// toggle, never the main line.

export const ASSISTANT_DOCS = "https://leejianrong.github.io/kampong-agents/reference/cli/";

type Off = Extract<AssistantStatus, { configured: false }>;

export interface Plain {
  headline: string;
  hint?: string;
}

export function explainUnavailable(status: Off): Plain {
  switch (status.code) {
    case "unreachable":
      return {
        headline: "The assistant's local model isn't running.",
        hint: "Start it, then try again.",
      };
    case "incomplete":
      return {
        headline: "The assistant is almost set up.",
        hint: "It still needs a model to use.",
      };
    case "unsupported":
      return {
        headline: "The assistant can't use this model provider.",
        hint: "It needs an OpenRouter, OpenAI-compatible or local model.",
      };
    default:
      return {
        headline: "The assistant isn't set up yet.",
        hint: "It needs an AI service to talk to. You can still build with the steps.",
      };
  }
}

/** A failed prompt, in plain words; the original text is kept for the details. */
export function explainFailure(message: string): Plain {
  if (/answered (401|403)\b/.test(message)) {
    return {
      headline: "The assistant's AI service did not accept its key.",
      hint: "Check the key is right, then try again.",
    };
  }
  if (/answered 429\b/.test(message)) {
    return {
      headline: "The assistant's AI service says it is busy or over its limit.",
      hint: "Wait a moment and try again.",
    };
  }
  if (/Could not reach|did not answer|fetch failed|ECONN|ENOTFOUND/i.test(message)) {
    return {
      headline: "The assistant could not be reached.",
      hint: "Check that your AI service is running, then try again.",
    };
  }
  return { headline: message };
}

/** The short reason the assistant's buttons are off, for a tooltip; undefined when it is available. */
export function unavailableReason(status: AssistantStatus | undefined): string | undefined {
  return status && !status.configured ? explainUnavailable(status).headline : undefined;
}

export function AssistantSetupNote({ status, testId }: { status: Off; testId?: string }) {
  const plain = explainUnavailable(status);
  return (
    <div className="kg-chat__setup-note" data-testid={testId}>
      <p className="kg-small">
        <strong>{plain.headline}</strong>
        {plain.hint && <span> {plain.hint}</span>}
      </p>
      <details className="kg-chat__setup-details">
        <summary className="kg-small">How to set it up</summary>
        <p className="kg-small">{status.error}</p>
        <p className="kg-small">
          <a href={ASSISTANT_DOCS} target="_blank" rel="noreferrer">
            Read the setup guide
          </a>
        </p>
      </details>
    </div>
  );
}
