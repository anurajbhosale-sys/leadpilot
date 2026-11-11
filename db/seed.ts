// Inserts or updates sample branches by name, so rerunning refreshes their config.
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
    approvedOffers: ["$50 off your first service"],
  },
  {
    name: "Denver Metro",
    region: "Colorado",
    timeZone: "America/Denver",
    zipCodes: ["80202", "80203", "80205", "80206", "80218"],
    businessHours: weekdays("07:30", "17:30"),
    approvedOffers: [], // no offers: any price or discount in an SMS needs human review
  },
  {
    name: "Tampa Bay",
    region: "Florida",
    timeZone: "America/New_York",
    zipCodes: ["33602", "33606", "33609", "33611", "33629"],
    businessHours: { ...weekdays("08:00", "19:00"), "6": { open: "08:00", close: "12:00" } },
    approvedOffers: ["Your first inspection is free"],
  },
];

for (const branch of sampleBranches) {
  const { name: _name, ...config } = branch; // name is the conflict key, not something to update
  await db.insert(branches).values(branch).onConflictDoUpdate({ target: branches.name, set: config });
}

console.log(`Seeded ${sampleBranches.length} branches: ${sampleBranches.map((b) => b.name).join(", ")}.`);
await sql.end();
