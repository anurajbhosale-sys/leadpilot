// Runs the win-back job once, directly (no HTTP), against the database in DATABASE_URL.
//
//   npm run winback:run                        # process cancellations since the last watermark
//   npm run winback:run -- --add-cancellation  # first simulate a brand-new cancellation
//
// The mock CRM lives in this process and starts with the same seeded cancellations every time;
// the watermark in Postgres is what stops them being processed twice.
import "dotenv/config";
import { parseArgs } from "node:util";
import { sql } from "@/db";
import { MockCrm, SEED_CUSTOMERS, SEED_SUBSCRIPTIONS } from "@/lib/providers/crm";
import { runWinbackJob } from "@/lib/winback-db";

const { values } = parseArgs({ options: { "add-cancellation": { type: "boolean", default: false } } });

const crm = new MockCrm(SEED_CUSTOMERS, SEED_SUBSCRIPTIONS);
if (values["add-cancellation"]) {
  const sub = crm.addCancellation(
    { name: "Nina Shah", phone: "813-555-0144", zip: "33611", branchId: 3, smsConsent: true },
    "Monthly pest control",
    "switching providers",
  );
  console.log(`Simulated a new cancellation: ${sub.id} at ${sub.cancelledAt!.toISOString()}`);
}

try {
  console.log(await runWinbackJob(crm));
} finally {
  await sql.end();
}
