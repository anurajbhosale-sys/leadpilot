// Inserts sample branches. Safe to rerun: existing branches (by name) are left alone.
import "dotenv/config";
import { branches, type BusinessHours } from "./schema";
import { db, sql } from "./index";


const weekdays = (open: string, close: string): BusinessHours =>
  Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, { open, close }]));

const sampleBranches = [
  {
    name: "Austin North",
    region: "Texas",
    timeZone: "America/Chicago",
    zipCodes: ["78727", "78728", "78729", "78750", "78758"],
    businessHours: { ...weekdays("08:00", "18:00"), "6": { open: "09:00", close: "14:00" } },
  },
  {
    name: "Denver Metro",
    region: "Colorado",
    timeZone: "America/Denver",
    zipCodes: ["80202", "80203", "80205", "80206", "80218"],
    businessHours: weekdays("07:30", "17:30"),
  },
  {
    name: "Tampa Bay",
    region: "Florida",
    timeZone: "America/New_York",
    zipCodes: ["33602", "33606", "33609", "33611", "33629"],
    businessHours: { ...weekdays("08:00", "19:00"), "6": { open: "08:00", close: "12:00" } },
  },
];

const inserted = await db
  .insert(branches)
  .values(sampleBranches)
  .onConflictDoNothing({ target: branches.name })
  .returning({ name: branches.name });

console.log(`Seeded ${inserted.length} new branch(es); ${sampleBranches.length - inserted.length} already existed.`);
await sql.end();
