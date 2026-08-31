const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// Keep DATE columns as plain 'YYYY-MM-DD' strings instead of letting node-postgres
// convert them to JS Date objects (which shifts by a day depending on server TZ).
const { types } = require("pg");
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

module.exports = { pool };
