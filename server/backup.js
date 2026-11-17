// Backups of everything Radar stores, as one JSON file.
// - buildBackup(): every table except login sessions, uploaded files included (base64).
// - Google Drive: John connects his Drive once (scope drive.file, so Radar only ever sees the
//   files it creates). Radar then saves a backup into a "Nimbl Radar backups" folder whenever the
//   last one is 7+ days old (checked while the app is in use and every few hours while awake),
//   and on demand with "Back up now".
// The Drive refresh token lives in app_settings (key 'drive'), never in the browser.
const crypto = require("crypto");

const TABLES = [
  "leads", "contacts", "activities", "lead_notes", "documents", "role_types", "role_alerts",
  "agent_drafts", "playbook_items", "job_descriptions", "candidates", "candidate_notes",
  "candidate_documents", "jobs", "meta", "files",
];
const BACKUP_EVERY_MS = 7 * 24 * 3600 * 1000;
const FOLDER_NAME = "Nimbl Radar backups";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

async function tableExists(pool, t) {
  const r = await pool.query("select to_regclass($1) is not null as ok", ["public." + t]);
  return r.rows[0].ok;
}

async function buildBackup(pool) {
  const out = { app: "Nimbl Radar", version: 1, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    if (!(await tableExists(pool, t))) continue;
    const r = await pool.query(`select * from ${t}`);
    out.tables[t] = r.rows.map((row) => {
      const o = {};
      Object.keys(row).forEach((k) => {
        const v = row[k];
        o[k] = Buffer.isBuffer(v) ? { base64: v.toString("base64") } : v;
      });
      return o;
    });
  }
  out.counts = Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]));
  return out;
}

// ---- settings storage ----
async function ensureSettingsTable(pool) {
  await pool.query(`create table if not exists app_settings (
    key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now())`);
  await pool.query("alter table app_settings enable row level security");
}
async function getSetting(pool, key) {
  const r = await pool.query("select value from app_settings where key = $1", [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function setSetting(pool, key, value) {
  await pool.query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

// ---- Google OAuth for Drive ----
function redirectUri() {
  return (process.env.PUBLIC_URL || "").replace(/\/$/, "") + "/auth/drive/callback";
}
function driveConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.PUBLIC_URL);
}
function authUrl(state, loginHint) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE + " email",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}
async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.assign({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    }, params)).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Google sign-in for Drive failed: " + (data.error_description || data.error || res.status));
  return data;
}
async function finishConnect(pool, code) {
  const tok = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!tok.refresh_token) throw new Error("Google didn't return a long-lived token. Remove Radar's access at myaccount.google.com/permissions and connect again.");
  let email = "";
  try {
    const info = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + tok.access_token } });
    email = ((await info.json()) || {}).email || "";
  } catch (e) { /* email is only for display */ }
  const prev = (await getSetting(pool, "drive")) || {};
  await setSetting(pool, "drive", { refreshToken: tok.refresh_token, email, folderId: prev.email === email ? prev.folderId || "" : "",
    connectedAt: new Date().toISOString(), lastBackupAt: prev.lastBackupAt || "", lastFileId: prev.lastFileId || "", lastError: "" });
}
async function accessToken(drive) {
  const tok = await tokenRequest({ refresh_token: drive.refreshToken, grant_type: "refresh_token" });
  return tok.access_token;
}

async function driveFetch(token, url, opts) {
  const res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + token }, (opts && opts.headers) || {}) }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error)) || res.status;
    const err = new Error("Google Drive: " + msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function ensureFolder(token, drive) {
  if (drive.folderId) {
    try {
      const f = await driveFetch(token, "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(drive.folderId) + "?fields=id,trashed");
      if (f && f.id && !f.trashed) return f.id;
    } catch (e) { /* folder gone: make a new one */ }
  }
  const f = await driveFetch(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  return f.id;
}

async function uploadJson(token, folderId, name, json) {
  const boundary = "radar" + crypto.randomBytes(8).toString("hex");
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: "application/json" });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
    Buffer.from(json),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return driveFetch(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body,
  });
}

let running = null;
async function runBackup(pool, reason) {
  if (running) return running;
  running = (async () => {
    const drive = await getSetting(pool, "drive");
    if (!drive || !drive.refreshToken) throw new Error("Google Drive isn't connected yet.");
    try {
      const token = await accessToken(drive);
      const folderId = await ensureFolder(token, drive);
      const data = await buildBackup(pool);
      const stamp = data.exportedAt.slice(0, 16).replace("T", " ").replace(":", "-");
      const file = await uploadJson(token, folderId, `Nimbl Radar backup ${stamp} UTC.json`, JSON.stringify(data));
      const next = Object.assign({}, drive, { folderId, lastBackupAt: data.exportedAt, lastFileId: file.id, lastError: "", lastReason: reason || "" });
      await setSetting(pool, "drive", next);
      return { ok: true, at: data.exportedAt, fileId: file.id, link: file.webViewLink || "", counts: data.counts };
    } catch (err) {
      await setSetting(pool, "drive", Object.assign({}, drive, { lastError: String(err.message || err).slice(0, 300), lastErrorAt: new Date().toISOString() }));
      throw err;
    }
  })();
  try { return await running; } finally { running = null; }
}

async function status(pool) {
  const drive = (await getSetting(pool, "drive")) || {};
  const connected = Boolean(drive.refreshToken);
  const last = drive.lastBackupAt || "";
  return {
    configured: driveConfigured(),
    connected,
    email: drive.email || "",
    lastBackupAt: last,
    nextDueAt: connected ? new Date((last ? Date.parse(last) : Date.now()) + (last ? BACKUP_EVERY_MS : 0)).toISOString() : "",
    folderUrl: drive.folderId ? "https://drive.google.com/drive/folders/" + drive.folderId : "",
    lastError: drive.lastError || "",
  };
}

// Called on app use and on a timer: back up when the last one is a week old.
let lastCheck = 0;
async function backupIfDue(pool) {
  const now = Date.now();
  if (now - lastCheck < 10 * 60 * 1000) return; // at most every 10 minutes
  lastCheck = now;
  const drive = await getSetting(pool, "drive");
  if (!drive || !drive.refreshToken) return;
  const last = drive.lastBackupAt ? Date.parse(drive.lastBackupAt) : 0;
  const lastErr = drive.lastErrorAt ? Date.parse(drive.lastErrorAt) : 0;
  if (now - last < BACKUP_EVERY_MS) return;
  if (lastErr && now - lastErr < 6 * 3600 * 1000) return; // after a failure, retry in 6 hours
  await runBackup(pool, "weekly");
}

async function disconnect(pool) {
  const drive = await getSetting(pool, "drive");
  if (drive && drive.refreshToken) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(drive.refreshToken), { method: "POST" });
    } catch (e) { /* best effort */ }
  }
  await setSetting(pool, "drive", { folderId: (drive && drive.folderId) || "", lastBackupAt: (drive && drive.lastBackupAt) || "" });
}

module.exports = { buildBackup, ensureSettingsTable, authUrl, finishConnect, runBackup, status, backupIfDue, disconnect, driveConfigured };
