import { diagnose } from "./agents/diagnostician.js";
import { fetchToyServiceDebug } from "./toy-service-client.js";
import { emitIncidentEvent } from "./events.js";
import { postApprovalRequest } from "./slack-approval.js";

export interface AlertmanagerAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  fingerprint: string;
}

export interface AlertmanagerWebhookPayload {
  alerts: AlertmanagerAlert[];
}

interface OpenIncident {
  alertname: string;
  severity: string;
}

// In-memory only -- a real restart loses in-flight incident context, which
// is an acceptable simplification for a discovery demo (see README
// gap-analysis) but would need real persistence for anything longer-lived.
const openIncidents = new Map<string, OpenIncident>();

export function getOpenIncident(incidentId: string): OpenIncident | undefined {
  return openIncidents.get(incidentId);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

/** The real end-to-end chain: real alert -> real diagnosis against the real service -> real Slack proposal, gated on a real human decision (ADR-0004: never auto-executed). */
export async function handleAlertmanagerWebhook(payload: AlertmanagerWebhookPayload): Promise<void> {
  for (const alert of payload.alerts) {
    const incidentId = alert.fingerprint;
    const alertname = alert.labels.alertname ?? "UnknownAlert";
    const severity = alert.labels.severity ?? "unknown";

    if (alert.status === "resolved") {
      openIncidents.delete(incidentId);
      emitIncidentEvent({ type: "alert_resolved", incident: incidentId, alertname, at: Date.now() });
      continue;
    }

    openIncidents.set(incidentId, { alertname, severity });
    emitIncidentEvent({ type: "alert_firing", incident: incidentId, alertname, severity, at: Date.now() });

    try {
      emitIncidentEvent({ type: "diagnosis_started", incident: incidentId, at: Date.now() });
      const debug = await fetchToyServiceDebug();
      const description = alert.annotations.description ?? alert.annotations.summary ?? "";
      const diagnosis = await diagnose(alertname, severity, description, debug);

      emitIncidentEvent({
        type: "diagnosis_ready",
        incident: incidentId,
        summary: diagnosis.summary,
        likelyCause: diagnosis.likelyCause,
        at: Date.now(),
      });

      const text = [
        `*Real alert:* ${alertname} (${severity})`,
        `*Diagnosis:* ${diagnosis.summary}`,
        `*Likely cause:* ${diagnosis.likelyCause}`,
        `*Proposed fix:* ${diagnosis.proposedFix}`,
        "_This agent never executes a fix itself -- it only proposes one._",
      ].join("\n");

      await postApprovalRequest({
        token: requireEnv("SLACK_BOT_TOKEN"),
        channel: requireEnv("SLACK_CHANNEL"),
        incidentId,
        text,
      });
      emitIncidentEvent({
        type: "proposal_posted",
        incident: incidentId,
        proposedFix: diagnosis.proposedFix,
        at: Date.now(),
      });
    } catch (err) {
      emitIncidentEvent({
        type: "incident_error",
        incident: incidentId,
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
      throw err;
    }
  }
}
