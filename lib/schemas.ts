import { z } from "zod";

// What the lead form submits. Phone or email is required so we can follow up.
export const leadFormSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    phone: z.string().trim().max(30).optional().default(""),
    email: z.union([z.literal(""), z.email("Invalid email")]).optional().default(""),
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP code"),
    message: z.string().trim().min(10, "Tell us a bit more (10+ characters)").max(2000),
    // Attribution from the landing URL
    utmSource: z.string().max(200).optional(),
    utmMedium: z.string().max(200).optional(),
    utmCampaign: z.string().max(200).optional(),
    gclid: z.string().max(200).optional(),
  })
  .refine((v) => v.phone.replace(/\D/g, "").length >= 10 || v.email !== "", {
    message: "Enter a phone number or an email",
    path: ["phone"],
  });

export type LeadFormInput = z.infer<typeof leadFormSchema>;

export const serviceCategories = [
  "plumbing",
  "hvac",
  "electrical",
  "pest_control",
  "lawn_care",
  "cleaning",
  "other",
] as const;

// Structured fields the LLM pulls out of the free-text request.
export const leadExtractionSchema = z.object({
  serviceCategory: z.enum(serviceCategories),
  urgency: z.enum(["low", "medium", "high"]),
  contactPreference: z.enum(["phone", "sms", "email", "no_preference"]),
  summary: z.string().min(1).max(200),
});

export type LeadExtraction = z.infer<typeof leadExtractionSchema>;

export const smsDraftSchema = z.object({
  message: z.string().min(1),
});
