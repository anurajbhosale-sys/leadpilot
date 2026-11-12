import { cronAuthError } from "@/lib/cron";
import { sendDueSms } from "@/lib/sms";

// GET is how Vercel Cron would call it; POST is kept for manual and external schedulers.
export async function GET(request: Request) {
  return POST(request);
}

// POST /api/cron/sms: sends SMS that were held for business hours (run every few minutes).
export async function POST(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;
  return Response.json({ sent: await sendDueSms() });
}
