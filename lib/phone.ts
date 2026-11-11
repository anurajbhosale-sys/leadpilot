/**
 * Normalize a US phone number to 10 digits so different formats compare equal:
 * "+1 (512) 555-0142", "512.555.0142", "15125550142" -> "5125550142".
 * Returns null if it isn't a 10-digit number (optionally with a leading 1).
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}
