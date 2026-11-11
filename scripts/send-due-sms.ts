// Sends SMS that were held for business hours and are now due. Same as POST /api/cron/sms.
import "dotenv/config";
import { sql } from "@/db";
import { sendDueSms } from "@/lib/sms";

try {
  console.log(`Sent ${await sendDueSms()} due message(s).`);
} finally {
  await sql.end();
}
