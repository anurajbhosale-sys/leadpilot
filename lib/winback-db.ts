import { eq } from "drizzle-orm";
import { db } from "@/db";
import { approvalQueue, branches } from "@/db/schema";
import { draftWinbackSms } from "@/lib/ai/draft";
import { getCrm } from "@/lib/providers/crm";
import { dbWatermarks } from "@/lib/watermarks";
import { runWinback, type WinbackDeps } from "@/lib/winback";

/** Production wiring for the win-back job: Postgres + the CRM provider + the LLM. */
export function winbackDeps(crm = getCrm()): WinbackDeps {
  return {
    crm,
    watermarks: dbWatermarks,
    branches: {
      async get(id) {
        const [b] = await db.select().from(branches).where(eq(branches.id, id));
        return b ?? null;
      },
    },
    queue: {
      async has(sourceKey) {
        const [row] = await db
          .select({ id: approvalQueue.id })
          .from(approvalQueue)
          .where(eq(approvalQueue.sourceKey, sourceKey));
        return Boolean(row);
      },
      async add(item) {
        await db
          .insert(approvalQueue)
          .values({ kind: "winback_sms", ...item })
          .onConflictDoNothing({ target: approvalQueue.sourceKey });
      },
    },
    draft: draftWinbackSms,
  };
}

export function runWinbackJob(crm = getCrm()) {
  return runWinback(winbackDeps(crm));
}
