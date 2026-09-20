import { classifyTicket, isConfidentEnough } from "./agents/classifier.js";
import { createDraftReply, fetchNewTickets } from "./gmail-client.js";
import { emitTriageEvent } from "./events.js";
import { postApprovalRequest } from "./slack-approval.js";

interface PendingTicket {
  from: string;
  subject: string;
  category: string;
  draftReply: string;
  messageId?: string;
  references: string[];
}

// In-memory only -- a real restart loses in-flight escalations, the same
// simplification incident-responder's openIncidents makes (see its README
// gap-analysis). Acceptable for a discovery demo; a real product would need
// this persisted.
const pendingTickets = new Map<string, PendingTicket>();

export function getPendingTicket(ticketId: string): PendingTicket | undefined {
  return pendingTickets.get(ticketId);
}

export function clearPendingTicket(ticketId: string): void {
  pendingTickets.delete(ticketId);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example).`);
  return value;
}

/** One real poll cycle: fetch unseen inbox messages, classify each, and either draft immediately (confident) or escalate to Slack (not confident) -- never both, never neither. */
export async function pollInbox(): Promise<void> {
  const tickets = await fetchNewTickets();

  for (const ticket of tickets) {
    const ticketId = String(ticket.uid);
    emitTriageEvent({
      type: "ticket_received",
      ticket: ticketId,
      from: ticket.from,
      subject: ticket.subject,
      at: Date.now(),
    });

    try {
      emitTriageEvent({ type: "classification_started", ticket: ticketId, at: Date.now() });
      const classification = await classifyTicket(ticket.from, ticket.subject, ticket.text);
      emitTriageEvent({
        type: "classification_ready",
        ticket: ticketId,
        category: classification.category,
        confidence: classification.confidence,
        at: Date.now(),
      });

      if (isConfidentEnough(classification.confidence)) {
        await createDraftReply({
          to: ticket.from,
          subject: ticket.subject,
          inReplyTo: ticket.messageId,
          references: ticket.references,
          body: classification.draftReply,
        });
        emitTriageEvent({ type: "draft_created", ticket: ticketId, draftId: ticketId, at: Date.now() });
        continue;
      }

      pendingTickets.set(ticketId, {
        from: ticket.from,
        subject: ticket.subject,
        category: classification.category,
        draftReply: classification.draftReply,
        messageId: ticket.messageId,
        references: ticket.references,
      });

      const text = [
        `*Real ticket from:* ${ticket.from}`,
        `*Subject:* ${ticket.subject}`,
        `*Category:* ${classification.category} (confidence ${classification.confidence.toFixed(2)})`,
        `*Why escalated:* ${classification.reasoning}`,
        `*Proposed reply:*\n>${classification.draftReply.replaceAll("\n", "\n>")}`,
      ].join("\n");

      await postApprovalRequest({
        token: requireEnv("SLACK_BOT_TOKEN"),
        channel: requireEnv("SLACK_CHANNEL"),
        ticketId,
        text,
      });
      emitTriageEvent({
        type: "escalation_posted",
        ticket: ticketId,
        reason: classification.reasoning,
        at: Date.now(),
      });
    } catch (err) {
      emitTriageEvent({
        type: "ticket_error",
        ticket: ticketId,
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
      throw err;
    }
  }
}

/** Runs on a real human's Slack approval decision -- only an approval actually creates the real Gmail draft; a rejection just records the decision. */
export async function resolveEscalation(ticketId: string, decision: "approved" | "rejected"): Promise<void> {
  const pending = getPendingTicket(ticketId);
  if (!pending) return;

  if (decision === "approved") {
    await createDraftReply({
      to: pending.from,
      subject: pending.subject,
      inReplyTo: pending.messageId,
      references: pending.references,
      body: pending.draftReply,
    });
    emitTriageEvent({ type: "draft_created", ticket: ticketId, draftId: ticketId, at: Date.now() });
  }

  clearPendingTicket(ticketId);
}
