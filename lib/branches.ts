import { db } from "@/db";
import { branches } from "@/db/schema";

export type Branch = typeof branches.$inferSelect;

/** "78727-1234" and " 78727 " both become "78727". */
export function normalizeZip(zip: string): string {
  return zip.trim().slice(0, 5);
}

/** Pure lookup: the branch that serves this ZIP, or null if none does. */
export function matchBranchByZip<B extends Pick<Branch, "zipCodes">>(all: B[], zip: string): B | null {
  const target = normalizeZip(zip);
  return all.find((b) => b.zipCodes.includes(target)) ?? null;
}

/** There are only a handful of branches, so load them all and match in code (unit-tested above). */
export async function findBranchByZip(zip: string): Promise<Branch | null> {
  const all = await db.select().from(branches);
  return matchBranchByZip(all, zip);
}
