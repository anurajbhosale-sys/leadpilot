import { cronAuthError } from "@/lib/cron";
import { runWinbackJob } from "@/lib/winback-db";

// POST /api/cron/winback: hourly win-back job (SPEC A2).
export async function POST(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    return Response.json(await runWinbackJob());
  } catch (err) {
    // The watermark wasn't advanced, so the next run retries this batch.
    console.error("Win-back job failed:", err);
    return Response.json({ error: "Win-back job failed" }, { status: 500 });
  }
}
