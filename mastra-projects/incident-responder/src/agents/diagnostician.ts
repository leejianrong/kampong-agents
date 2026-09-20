import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { resolveModel } from "../model.js";
import type { ToyServiceDebug } from "../toy-service-client.js";

export const diagnosisSchema = z.object({
  summary: z.string().describe("One-sentence, human-readable description of the incident."),
  likelyCause: z.string().describe("The most probable root cause given the real alert and real service state."),
  proposedFix: z
    .string()
    .describe("A specific, concrete remediation action a human could take -- not vague advice."),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

export const diagnosticianAgent = new Agent({
  id: "diagnostician",
  name: "Incident Diagnostician",
  instructions: `You are an on-call incident diagnostician. You're given a
real Prometheus alert and the real current debug state of the service it
fired against (its chaos mode, when that mode last changed, and its most
recent real request outcomes). Diagnose the likely cause and propose one
specific, concrete fix a human on-call engineer could actually take right
now (e.g. "restart the service", "roll back the last deploy", "scale up
replicas") -- never something vague like "investigate further". You never
take action yourself; you only ever propose.`,
  model: resolveModel(),
});

export async function diagnose(
  alertname: string,
  severity: string,
  description: string,
  debug: ToyServiceDebug,
): Promise<Diagnosis> {
  const prompt = `Alert: ${alertname} (severity: ${severity})
Description: ${description}

Real current service debug state:
${JSON.stringify(debug, null, 2)}`;

  const result = await diagnosticianAgent.generate(prompt, {
    structuredOutput: { schema: diagnosisSchema },
  });
  return result.object;
}
