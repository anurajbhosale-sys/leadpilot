import { cronAuthError } from "@/lib/cron";
import { sendDueSms } from "@/lib/sms";

// POST /api/cron/sms: sends SMS that were held for business hours (run every few minutes).
export async function POST(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;
  return Response.json({ sent: await sendDueSms() });
}
