require("dotenv").config();
const path = require("path");
const express = require("express");
const passport = require("passport");
const { pool } = require("./db");
const { buildSession } = require("./session");
const { getState, putState } = require("./state");
const { listPlaybook, upsertPlaybookItem, deletePlaybookItem } = require("./playbook");
const { configurePassport, ensureAuthenticated, googleLoginEnabled, ALLOWED_DOMAIN } = require("./auth");

const app = express();
app.set("trust proxy", 1); // Render terminates TLS upstream; needed for secure cookies
app.use(express.json({ limit: "5mb" }));

// --- Optional shared-password protection -----------------------------------
// Legacy stopgap, kept for local/dev use. If Google sign-in is configured
// (below) it supersedes this — leave APP_USER/APP_PASSWORD unset once Google
// login is on.
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

// --- Google sign-in ----------------------------------------------------------
// Restricted to accounts on ALLOWED_DOMAIN (see server/auth.js). Skipped
// entirely if GOOGLE_CLIENT_ID/SECRET aren't set, so local dev stays simple.
configurePassport();
app.use(buildSession(pool));
app.use(passport.initialize());
app.use(passport.session());

app.get("/auth/login", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect("/");
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/auth/login?error=domain" }),
  (req, res) => res.redirect("/")
);

app.post("/auth/logout", (req, res) => {
  req.logout(() => res.redirect("/auth/login"));
});

app.get("/auth/me", (req, res) => {
  if (!googleLoginEnabled) return res.json({ enabled: false });
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ enabled: true, user: req.user });
  }
  res.status(401).json({ enabled: true, user: null });
});

app.get("/", ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/api/state", ensureAuthenticated, async (req, res) => {
  try {
    res.json(await getState(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load state." });
  }
});

app.put("/api/state", ensureAuthenticated, async (req, res) => {
  try {
    await putState(pool, req.body || {});
    res.json(await getState(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save state." });
  }
});

app.get("/api/playbook", ensureAuthenticated, async (req, res) => {
  try {
    res.json(await listPlaybook(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load the playbook." });
  }
});

app.put("/api/playbook/:id", ensureAuthenticated, async (req, res) => {
  try {
    const ok = await upsertPlaybookItem(pool, { ...(req.body || {}), id: req.params.id });
    if (!ok) return res.status(400).json({ error: "Invalid playbook item." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save the playbook item." });
  }
});

app.delete("/api/playbook/:id", ensureAuthenticated, async (req, res) => {
  try {
    await deletePlaybookItem(pool, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete the playbook item." });
  }
});

app.get("/index.html", ensureAuthenticated, (req, res) => res.redirect("/"));
app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Nimbl Radar listening on http://localhost:${port}`);
});
