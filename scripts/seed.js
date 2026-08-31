// Loads db/seed-data.json (the 9 leads carried over from the original Claude
// Artifact prototype) into the database. Safe to re-run: it's a full
// putState() call, so it just overwrites current data with the seed set.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("../server/db");
const { putState, getState } = require("../server/state");

async function main() {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "db", "seed-data.json"), "utf8"));
  await putState(pool, seed);
  const state = await getState(pool);
  console.log(`Seeded ${state.leads.length} leads, tracking roles: ${state.roleTypes.join(", ")}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
