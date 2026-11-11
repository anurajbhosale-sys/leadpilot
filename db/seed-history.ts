// Seeds 90 days of realistic history for the reporting pipeline and dashboard:
//   - leads (web + phone, with UTM sources) and analyzed calls, in the app tables
//   - the mock CRM's customers, bookings, subscriptions and cancellations (mock_crm_* tables)
// Ad spend needs no seeding: the mock ad platforms compute it from the date (lib/history.ts).
//
//   npm run db:seed:history                # last 90 days, up to now
//   npm run db:seed:history -- --days 30
//
// Safe to rerun: rerunning on a later day adds the new days. Run `npm run db:seed` first.
import "dotenv/config";
import { parseArgs } from "node:util";
import { seedHistory } from "./history-seed";
import { db, sql } from "./index";

const { values } = parseArgs({ options: { days: { type: "string", default: "90" } } });
const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error("--days must be a whole number from 1 to 730");

try {
  const s = await seedHistory(db, { days });
  console.log(
    `Seeded ${s.days} days of history across ${s.branches} branches: ${s.leads} leads, ${s.calls} calls, ` +
      `${s.customers} CRM customers (${s.booked} booked), ${s.subscriptions} subscriptions (${s.cancelled} cancelled).`,
  );
} finally {
  await sql.end();
}
