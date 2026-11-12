// One-time setup for a new database (e.g. a Neon database behind a Vercel deployment):
// migrate -> seed branches -> seed 90 days of history -> run the pipeline once, so the
// dashboard has data from the first visit.
//
//   DATABASE_URL='postgres://...' npm run setup          # asks before touching the database
//   DATABASE_URL='postgres://...' npm run setup -- --yes # no prompt (CI, scripts)
//
// Every step is safe to rerun: migrations skip what's applied, seeds upsert, and the pipeline
// is incremental. A DATABASE_URL given on the command line wins over the one in .env.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run: DATABASE_URL='postgres://...' npm run setup");
  process.exit(1);
}

// Show where we're about to write, without the password.
const target = (() => {
  try {
    const u = new URL(url);
    return `${u.username}@${u.host}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
})();

if (!values.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Set up the database at ${target}? (migrate, seed, history, pipeline) [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    console.log("Cancelled.");
    process.exit(1);
  }
}

const steps: [label: string, script: string][] = [
  ["Apply migrations", "db/migrate.ts"],
  ["Seed branches", "db/seed.ts"],
  ["Seed 90 days of history", "db/seed-history.ts"],
  ["Run the pipeline", "scripts/run-pipeline.ts"],
];

console.log(`\nSetting up ${target}\n`);
for (const [i, [label, script]] of steps.entries()) {
  console.log(`[${i + 1}/${steps.length}] ${label}`);
  const result = spawnSync("npx", ["tsx", script], { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    console.error(`\nSetup stopped: "${label}" failed (exit ${result.status ?? result.signal}). Fix it and rerun; finished steps are safe to repeat.`);
    process.exit(1);
  }
  console.log();
}
console.log("Setup complete. Open /dashboard on your deployment.");
