import { createHash } from "node:crypto";

/**
 * Same person + same request => same key, even if formatting differs
 * ("(512) 555-0100" vs "512-555-0100", "Ann@X.com" vs "ann@x.com").
 * The key is sent to the CRM and stored on the lead, so a resubmit never creates a duplicate.
 */
export function leadIdempotencyKey(input: { phone?: string; email?: string; zip: string; message: string }): string {
  const parts = [
    (input.phone ?? "").replace(/\D/g, "").slice(-10),
    (input.email ?? "").trim().toLowerCase(),
    input.zip.trim().slice(0, 5),
    input.message.trim().toLowerCase().replace(/\s+/g, " "),
  ];
  return "lead_" + createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}
