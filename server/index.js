require("dotenv").config();
const path = require("path");
const express = require("express");
const passport = require("passport");
const { pool } = require("./db");
const { buildSession } = require("./session");
const { getState, putState, leadHistory } = require("./state");
const { emailOf, isOwner, requireOwner, actorPool, testUser } = require("./actor");
const { listPlaybook, upsertPlaybookItem, deletePlaybookItem } = require("./playbook");
const { listFiles, saveFile, getFile, deleteFile, MAX_FILE_BYTES } = require("./files");
const { listJds, getJd, createJd, updateJd, deleteJd } = require("./jds");
const { renderJobDescriptionPdf } = require("./jdpdf");
const backup = require("./backup");
const ext = require("./ext");
const crypto = require("crypto");
const { configurePassport, ensureAuthenticated, googleLoginEnabled, ALLOWED_DOMAIN } = require("./auth");

const app = express();
app.set("trust proxy", 1); // Render terminates TLS upstream; needed for secure cookies
app.use(express.json({ limit: "5mb" }));

// --- Security headers ------------------------------------------------------------
// Pages may only load their own scripts (no inline or third-party scripts), can't be framed by
// other sites, and browsers are told to always use HTTPS. API and PDF responses skip the page
// policy so Chrome's PDF viewer keeps working.
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=()",
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  if (!req.path.startsWith("/api/")) {
    res.set("Content-Security-Policy", [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://accounts.google.com",
      "object-src 'none'",
    ].join("; "));
  }
  next();
});

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
  if (!googleLoginEnabled) {
    const t = testUser(req);
    return res.json({ enabled: false, user: t || null, isOwner: isOwner(req) });
  }
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ enabled: true, user: req.user, isOwner: isOwner(req) });
  }
  res.status(401).json({ enabled: true, user: null });
});

app.get("/", ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/api/state", ensureAuthenticated, async (req, res) => {
  try {
    res.json(await getState(pool));
    // Using the app is what wakes it on Render's free tier, so check for a due weekly backup here.
    backup.backupIfDue(pool).catch((err) => console.error("Weekly backup failed:", err.message));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load state." });
  }
});

// --- Chrome extension: keys (managed in Radar) and the key-authenticated API ----
app.get("/api/extension-keys", ensureAuthenticated, async (req, res) => {
  try {
    // The owner sees and can revoke everyone's keys; everyone else only their own.
    const all = await ext.listKeys(pool);
    const me = emailOf(req);
    res.json({ items: isOwner(req) ? all : all.filter((k) => String(k.createdBy || "").toLowerCase() === me) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to load keys." }); }
});
app.post("/api/extension-keys", ensureAuthenticated, async (req, res) => {
  try { res.json({ key: await ext.createKey(pool, (req.body || {}).label, emailOf(req)) }); } catch (err) { console.error(err); res.status(500).json({ error: "Failed to create a key." }); }
});
app.delete("/api/extension-keys/:id", ensureAuthenticated, async (req, res) => {
  try {
    if (!isOwner(req)) {
      const mine = (await ext.listKeys(pool)).some((k) => String(k.id) === String(req.params.id) && String(k.createdBy || "").toLowerCase() === emailOf(req));
      if (!mine) return res.status(403).json({ error: "You can only revoke your own keys." });
    }
    await ext.revokeKey(pool, req.params.id); res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to revoke the key." }); }
});
const extApi = express.Router();
extApi.use(ext.keyAuth(pool));
const as = (req) => actorPool(pool, req.extUser || "");
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (err) {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong in Radar." });
  }
};
extApi.get("/ping", wrap(async (req) => ({ ok: true, user: req.extUser })));
extApi.get("/lookup", wrap((req) => ext.lookup(as(req), req.query)));
extApi.get("/home", wrap(() => ext.home(pool)));
extApi.get("/leads", wrap(async (req) => ({ items: await ext.searchLeads(pool, req.query.q) })));
extApi.post("/contacts", wrap((req) => ext.addContact(as(req), req.body || {})));
extApi.post("/contacts/:id/checked", wrap((req) => ext.markChecked(as(req), req.params.id)));
extApi.post("/activities", wrap((req) => ext.logActivity(as(req), req.body || {})));
extApi.post("/notes", wrap((req) => ext.addNote(as(req), req.body || {})));
extApi.post("/job-descriptions", wrap(async (req) => {
  const b = req.body || {};
  const lead = await pool.query("select id from leads where id = $1", [String(b.leadId || "")]);
  if (!lead.rows.length) throw Object.assign(new Error("Pick a company in Radar first."), { status: 400 });
  return createJd(as(req), b.leadId, { sourceUrl: b.sourceUrl, sourceText: b.sourceText }, { email: req.extUser || "" });
}));
extApi.get("/job-descriptions/:id/pdf", async (req, res) => {
  try {
    const jd = await getJd(pool, req.params.id);
    if (!jd) return res.status(404).json({ error: "Job description not found." });
    const pdf = await renderJobDescriptionPdf(jd);
    res.set({ "Content-Type": "application/pdf", "Content-Length": String(pdf.length), "Cache-Control": "private, no-store" });
    res.end(pdf);
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to build the PDF." }); }
});
app.use("/api/ext", extApi);

// --- Backups (Google Drive + download) ----------------------------------------
app.get("/auth/drive", ensureAuthenticated, requireOwner, (req, res) => {
  if (!backup.driveConfigured()) return res.status(400).send("Google sign-in isn't configured on this server.");
  const state = crypto.randomBytes(16).toString("hex");
  req.session.driveState = state;
  req.session.save(() => res.redirect(backup.authUrl(state, req.user && req.user.email)));
});
app.get("/auth/drive/callback", ensureAuthenticated, requireOwner, async (req, res) => {
  const expected = req.session && req.session.driveState;
  if (req.session) delete req.session.driveState;
  if (req.query.error) return res.redirect("/?backup=" + encodeURIComponent("cancelled"));
  if (!expected || req.query.state !== expected || !req.query.code) return res.redirect("/?backup=" + encodeURIComponent("error:Sign-in link expired, try again"));
  try {
    await backup.finishConnect(pool, String(req.query.code));
    await backup.runBackup(pool, "first");
    res.redirect("/?backup=connected");
  } catch (err) {
    console.error(err);
    res.redirect("/?backup=" + encodeURIComponent("error:" + String(err.message || err).slice(0, 160)));
  }
});
app.get("/api/backup/status", ensureAuthenticated, async (req, res) => {
  try { res.json(await backup.status(pool)); } catch (err) { console.error(err); res.status(500).json({ error: "Failed to read backup status." }); }
});
app.post("/api/backup/run", ensureAuthenticated, async (req, res) => {
  try { res.json(await backup.runBackup(pool, "manual")); } catch (err) { console.error(err); res.status(500).json({ error: String(err.message || err) }); }
});
app.post("/api/backup/disconnect", ensureAuthenticated, requireOwner, async (req, res) => {
  try { await backup.disconnect(pool); res.json({ ok: true }); } catch (err) { console.error(err); res.status(500).json({ error: "Failed to disconnect." }); }
});
app.get("/api/backup/download", ensureAuthenticated, async (req, res) => {
  try {
    const data = await backup.buildBackup(pool);
    const name = "Nimbl Radar backup " + data.exportedAt.slice(0, 10) + ".json";
    res.set({ "Content-Type": "application/json", "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name), "Cache-Control": "private, no-store" });
    res.send(JSON.stringify(data));
  } catch (err) { console.error(err); res.status(500).send("Failed to build the backup."); }
});

app.put("/api/state", ensureAuthenticated, async (req, res) => {
  try {
    const result = await putState(pool, req.body || {}, { actor: emailOf(req), isOwner: isOwner(req) });
    const fresh = await getState(pool);
    fresh.conflicts = result.conflicts || [];
    res.json(fresh);
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

// --- Uploaded files ------------------------------------------------------------
app.get("/api/files", ensureAuthenticated, async (req, res) => {
  try {
    res.json(await listFiles(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load files." });
  }
});

// The browser sends the raw file as the request body; its name travels in a header so it
// stays out of URLs and request logs.
app.post(
  "/api/leads/:id/files",
  ensureAuthenticated,
  express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES + 1024 }),
  async (req, res) => {
    try {
      const out = await saveFile(pool, {
        leadId: req.params.id,
        contactId: req.query.contactId,
        rawName: req.get("X-File-Name"),
        body: req.body,
        uploadedBy: emailOf(req),
      });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out.file);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to save the file." });
    }
  }
);

app.get("/api/files/:id", ensureAuthenticated, async (req, res) => {
  try {
    const f = await getFile(pool, req.params.id);
    if (!f) return res.status(404).send("File not found.");
    res.set({
      "Content-Type": f.contentType,
      "Content-Length": String(f.data.length),
      "Content-Disposition": (f.inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(f.name),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    res.end(f.data);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to load the file.");
  }
});

app.delete("/api/files/:id", ensureAuthenticated, async (req, res) => {
  try {
    await deleteFile(pool, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete the file." });
  }
});

// --- New-role alerts (written by the daily scan for companies in the CRM) ------
app.post("/api/role-alerts/:id/seen", ensureAuthenticated, async (req, res) => {
  try {
    await pool.query("update role_alerts set seen_at = coalesce(seen_at, now()) where id = $1", [String(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update the alert." });
  }
});

app.post("/api/leads/:id/role-alerts/seen", ensureAuthenticated, async (req, res) => {
  try {
    await pool.query("update role_alerts set seen_at = now() where lead_id = $1 and seen_at is null", [String(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update the alerts." });
  }
});

// --- Change history for one company (audit_log) --------------------------------
app.get("/api/leads/:id/history", ensureAuthenticated, async (req, res) => {
  try { res.json({ items: await leadHistory(pool, req.params.id) }); } catch (err) { console.error(err); res.status(500).json({ error: "Failed to load the history." }); }
});

// --- Job descriptions (Nimbl letterhead PDFs) -----------------------------------
app.get("/api/job-descriptions", ensureAuthenticated, async (req, res) => {
  try { res.json({ items: await listJds(pool) }); } catch (err) { console.error(err); res.status(500).json({ error: "Failed to load job descriptions." }); }
});
app.post("/api/leads/:id/job-descriptions", ensureAuthenticated, async (req, res) => {
  try {
    const lead = await pool.query("select id from leads where id = $1", [String(req.params.id)]);
    if (!lead.rows.length) return res.status(404).json({ error: "Lead not found." });
    res.json(await createJd(actorPool(pool, emailOf(req)), req.params.id, req.body || {}, { email: emailOf(req) }));
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to save the job description." }); }
});
app.put("/api/job-descriptions/:id", ensureAuthenticated, async (req, res) => {
  try {
    const jd = await updateJd(actorPool(pool, emailOf(req)), req.params.id, req.body || {});
    if (!jd) return res.status(404).json({ error: "Job description not found." });
    res.json(jd);
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to save the job description." }); }
});
app.delete("/api/job-descriptions/:id", ensureAuthenticated, async (req, res) => {
  try { await deleteJd(actorPool(pool, emailOf(req)), req.params.id); res.json({ ok: true }); } catch (err) { console.error(err); res.status(500).json({ error: "Failed to delete the job description." }); }
});
app.get("/api/job-descriptions/:id/pdf", ensureAuthenticated, async (req, res) => {
  try {
    const jd = await getJd(pool, req.params.id);
    if (!jd) return res.status(404).send("Job description not found.");
    const pdf = await renderJobDescriptionPdf(jd);
    const name = "Nimbl.ai - " + ((jd.content && jd.content.title) || "Job description").replace(/[\\/:*?"<>|]+/g, " ").trim() + ".pdf";
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": (req.query.download ? "attachment" : "inline") + "; filename*=UTF-8''" + encodeURIComponent(name),
      "Cache-Control": "private, no-store",
    });
    res.end(pdf);
  } catch (err) { console.error(err); res.status(500).send("Failed to build the PDF."); }
});

// --- Agent drafts (written by the morning scan; never sent by the app) ---------
app.post("/api/agent-drafts/:id/:how(used|dismissed)", ensureAuthenticated, async (req, res) => {
  try {
    const col = req.params.how === "used" ? "used_at" : "dismissed_at";
    await pool.query(`update agent_drafts set ${col} = coalesce(${col}, now()) where id = $1`, [String(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update the draft." });
  }
});

// Oversized uploads are rejected by the body parser before the route runs.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large" && req.path.startsWith("/api/")) {
    return res.status(413).json({ error: "That file is over the 10 MB limit." });
  }
  next(err);
});

app.get("/index.html", ensureAuthenticated, (req, res) => res.redirect("/"));
app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Nimbl Radar listening on http://localhost:${port}`);
  backup.ensureSettingsTable(pool).catch((err) => console.error("app_settings:", err.message));
  ext.ensureSchema(pool).catch((err) => console.error("extension schema:", err.message));
  // While the server is awake, look for a due weekly backup every 3 hours.
  setInterval(() => backup.backupIfDue(pool).catch((err) => console.error("Weekly backup failed:", err.message)), 3 * 3600 * 1000);
});
