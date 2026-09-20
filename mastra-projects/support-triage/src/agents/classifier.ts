import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { resolveModel } from "../model.js";

export const classificationSchema = z.object({
  category: z
    .enum(["account", "billing", "technical", "how_to", "other"])
    .describe("The single best-fit support category for this ticket."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are that draftReply is a correct, sendable answer -- 0 to 1."),
  reasoning: z.string().describe("One sentence on why this confidence level, for a human reviewer."),
  draftReply: z
    .string()
    .describe("A complete, ready-to-send reply draft, even when confidence is low -- a human reviewing an escalation needs a concrete starting point, not just a category."),
});
export type Classification = z.infer<typeof classificationSchema>;

// Pure, network-free logic (unit-testable per SLICES.md's V3 test plan) --
// kept separate from the prompt/model call so the threshold can move
// without touching the agent.
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export function resolveConfidenceThreshold(): number {
  const raw = process.env.CONFIDENCE_THRESHOLD;
  if (!raw) return DEFAULT_CONFIDENCE_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`CONFIDENCE_THRESHOLD must be a number between 0 and 1, got "${raw}".`);
  }
  return parsed;
}

export function isConfidentEnough(confidence: number, threshold = resolveConfidenceThreshold()): boolean {
  return confidence >= threshold;
}

export const classifierAgent = new Agent({
  id: "support-classifier",
  name: "Support Ticket Classifier",
  instructions: `You are a support-ticket triage agent for a small software
product. Given a real customer email, classify it into one category, draft
a complete, specific, ready-to-send reply, and honestly self-assess how
confident you are that your draft is correct enough to go out without a
human reviewing it. Be conservative: a generic or evasive answer, a request
you can't actually resolve from the email alone, an angry or ambiguous
message, or anything touching billing/refunds/account access should get
LOW confidence (well under 0.7) even if you can still draft something
plausible. Never inflate confidence to avoid escalation -- a wrong
confident answer sent to a real customer is worse than an escalation.`,
  model: resolveModel(),
});

export async function classifyTicket(from: string, subject: string, body: string): Promise<Classification> {
  const prompt = `From: ${from}
Subject: ${subject}

${body}`;

  const result = await classifierAgent.generate(prompt, {
    structuredOutput: { schema: classificationSchema },
  });
  return result.object;
}
