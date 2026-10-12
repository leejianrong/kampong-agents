// Vendored from packages/engine/src/pending-approval.ts as part of a `kampong export`
// -- see docs/adr/0010-exported-runtime-is-vendored-not-retemplated.md. The
// only change from the source file is the type import, which now comes from
// the local ./spec-types.js rather than "@kampong/spec" (this project has no
// dependency on that package -- ADR-0002). From here on this file is yours: it
// will not be touched again by a future export.
//
import { createHash } from "node:crypto";
import type { AgentSpec } from "./spec-types.js";
import type { StateStore } from "./state-store.js";

// Persisted pending approvals (KAN-1854, ADR-0028 section 3, ADR-0042). When a run pauses for a human
// it can write what it needs to continue into the StateStore, under a correlation key. Any process that
// has the same store and the same spec can then resolve the approval by that key.

/** Every pending approval lives under this prefix, so `list(APPROVAL_KEY_PREFIX)` is the pending set. */
export const APPROVAL_KEY_PREFIX = "approval:";

/** A pending approval that is not resolved within this time expires (7 days). Override with `approvalTtlMs`. */
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const approvalStateKey = (key: string): string => `${APPROVAL_KEY_PREFIX}${key}`;

/**
 * Where in a step the run paused. `before`: the step has not done its work yet (a tool waiting to be
 * allowed, an approval step, a request_human_approval branch), so resuming re-enters the step and
 * continues from its gate. `after`: the step already ran and its output is in `outputs` (a confidence
 * guardrail), so resuming continues with the next step and never re-runs it.
 */
export type ApprovalPhase = "before" | "after";

export interface PersistedApproval {
  /** The correlation key; also the suffix of the store key. */
  key: string;
  /** SHA-256 of the spec the run was started with (see specHash). A different spec will not resume it. */
  specHash: string;
  /** `agent.id` of the spec, for listing without loading it. */
  agentId: string;
  /** Index into `agent.workflow` of the paused step. */
  stepIndex: number;
  step: string;
  phase: ApprovalPhase;
  kind: "tool" | "guardrail" | "approval";
  reason: string;
  toolName?: string;
  /** Every earlier step's output, by step name (including the paused step's own for phase `after`). */
  outputs: Record<string, unknown>;
  /** The run's raw input. */
  input: string;
  /** What started the run, with credential-looking headers removed. */
  trigger?: { headers?: Record<string, string>; body?: unknown };
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds the record expires at. */
  expiresAt: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Identity of a spec: SHA-256 over its parsed content in a key-order-independent form, so comments and formatting do not change it. */
export function specHash(spec: AgentSpec): string {
  return createHash("sha256").update(canonical(spec)).digest("hex");
}

// Same rule `kampong serve` applies before a header reaches an expression; a store file must never hold one.
const CREDENTIAL_HEADER =
  /authorization|cookie|token|secret|signature|api-?key|password|credential|x-amz-security/i;

export function storableTrigger(
  trigger: { headers?: Record<string, string>; body?: unknown } | undefined,
): PersistedApproval["trigger"] {
  if (!trigger) return undefined;
  const headers = trigger.headers
    ? Object.fromEntries(
        Object.entries(trigger.headers).filter(([name]) => !CREDENTIAL_HEADER.test(name)),
      )
    : undefined;
  return {
    ...(headers && { headers }),
    ...(trigger.body !== undefined && { body: trigger.body }),
  };
}

/** The pending approvals in a store, oldest first. Expired ones are not returned. */
export async function listPendingApprovals(store: StateStore): Promise<PersistedApproval[]> {
  const rows = await store.list<PersistedApproval>(APPROVAL_KEY_PREFIX);
  return rows.map((r) => r.value).sort((a, b) => a.createdAt - b.createdAt);
}
