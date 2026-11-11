// Loads and validates the golden sets. Expected labels are checked against the same enums the
// model's output is, so a typo in a label fails loudly instead of silently lowering accuracy.
import { z } from "zod";
import { callAnalysisSchema, leadExtractionSchema } from "@/lib/schemas";
import callSet from "./call-analysis.json";
import leadSet from "./lead-extraction.json";

/** One correct value, or a list of values that are all acceptable for an ambiguous case. */
const accepted = <T extends z.ZodType<string>>(values: T) => z.union([values, z.array(values).min(1)]);

export const leadCaseSchema = z.object({
  id: z.string(),
  note: z.string(),
  message: z.string().min(1),
  firstName: z.string().min(1),
  branch: z.object({ name: z.string(), approvedOffers: z.array(z.string()) }),
  expected: z.object({
    serviceCategory: accepted(leadExtractionSchema.shape.serviceCategory),
    urgency: accepted(leadExtractionSchema.shape.urgency),
    contactPreference: accepted(leadExtractionSchema.shape.contactPreference),
  }),
});

export const callCaseSchema = z.object({
  id: z.string(),
  note: z.string(),
  transcript: z.string().min(1),
  expected: z.object({
    intent: accepted(callAnalysisSchema.shape.intent),
    cancellationRisk: accepted(callAnalysisSchema.shape.cancellationRisk),
  }),
});

export type LeadCase = z.infer<typeof leadCaseSchema>;
export type CallCase = z.infer<typeof callCaseSchema>;
export type GoldenSets = { leads: LeadCase[]; calls: CallCase[] };

const uniqueIds = <T extends { id: string }>(cases: T[]) => {
  const dupes = cases.map((c) => c.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) throw new Error(`Duplicate golden case IDs: ${dupes.join(", ")}`);
  return cases;
};

export function loadGoldenSets(): GoldenSets {
  return {
    leads: uniqueIds(z.array(leadCaseSchema).parse(leadSet.cases)),
    calls: uniqueIds(z.array(callCaseSchema).parse(callSet.cases)),
  };
}
