import { z } from "zod";

export const SPECIALISTS = ["security", "style", "test-coverage"] as const;
export type Specialist = (typeof SPECIALISTS)[number];

export const routingSchema = z.object({
  specialists: z.array(z.enum(SPECIALISTS)).describe(
    "Which specialist reviewers this diff actually needs. Omit ones with nothing relevant to say.",
  ),
});

export const reviewSchema = z.object({
  summary: z.string().describe("One-sentence verdict from this specialist's point of view."),
  findings: z.array(
    z.object({
      severity: z.enum(["info", "warning", "blocker"]),
      comment: z.string(),
    }),
  ),
});
export type Review = z.infer<typeof reviewSchema>;
