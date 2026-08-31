require("dotenv").config();
const path = require("path");
const express = require("express");
const { pool } = require("./db");
const { getState, putState } = require("./state");

const app = express();
app.use(express.json({ limit: "5mb" }));

// --- Optional shared-password protection -----------------------------------
// This app can hold candidate PII (tax IDs, birthdates, payment info), so it
// ships with a minimal password gate rather than none at all. Set APP_USER /
// APP_PASSWORD in .env to turn it on. This is deliberately simple (one shared
// login for the whole team) — swap in real per-user auth before this holds
// data you actually care about protecting long-term.
if (process.env.APP_USER && process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === process.env.APP_USER && pass === process.env.APP_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Nimbl Radar"');
    res.status(401).send("Authentication required.");
  });
}

app.get("/api/state", async (req, res) => {
  try {
    res.json(await getState(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load state." });
  }
});

app.put("/api/state", async (req, res) => {
  try {
    await putState(pool, req.body || {});
    res.json(await getState(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save state." });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Nimbl Radar listening on http://localhost:${port}`);
});
