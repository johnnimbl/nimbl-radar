// API for the Nimbl Radar Chrome extension.
// The extension authenticates with a personal key (created in Radar → Settings), sent as
// "Authorization: Bearer rk_…". Keys are stored hashed; only /api/ext/* accepts them.
// Every write here goes through the database directly and bumps the lead's revision (trigger),
// so an open Radar tab picks the change up instead of overwriting it.
const crypto = require("crypto");

const CADENCE_DAYS = { "Connection sent": 4, "Connected": 2, "Message sent": 5, "Replied": 2 };
const STAGE_RANK = { "Not contacted": 0, "No response": 0, "Connection sent": 1, "Connected": 2, "Message sent": 3, "Replied": 4, "Meeting booked": 5, "Not interested": 99 };
const STATUS_ORDER = ["Not Started", "Researching", "Contacted", "Replied", "Meeting Booked", "Proposal Sent", "Won"];
const STAGE_TO_STATUS = { "Connection sent": "Contacted", "Connected": "Contacted", "Message sent": "Contacted", "Replied": "Replied", "Meeting booked": "Meeting Booked" };

const SCHEMA = `
create table if not exists api_keys (
  id text primary key default gen_random_uuid()::text,
  key_hash text not null unique,
  label text not null default '',
  prefix text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table api_keys enable row level security;
create or replace function touch_lead() returns trigger language plpgsql as $$
declare lid text;
begin
  if tg_op = 'DELETE' then lid := old.lead_id; else lid := new.lead_id; end if;
  update leads set updated_at = now() where id = lid and updated_at <> now();
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
    update leads set updated_at = now() where id = old.lead_id and updated_at <> now();
  end if;
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['contacts','activities','lead_notes','documents','candidates'] loop
    if to_regclass('public.' || t) is not null and not exists (
      select 1 from pg_trigger where tgname = 'touch_lead_' || case when t = 'lead_notes' then 'notes' else t end) then
      execute format('create trigger %I after insert or update or delete on %I for each row execute function touch_lead()',
        'touch_lead_' || case when t = 'lead_notes' then 'notes' else t end, t);
    end if;
  end loop;
end $$;`;

async function ensureSchema(pool) { await pool.query(SCHEMA); }

const hash = (k) => crypto.createHash("sha256").update(k).digest("hex");

async function createKey(pool, label, email) {
  const key = "rk_" + crypto.randomBytes(24).toString("base64url");
  await pool.query("insert into api_keys (key_hash, label, prefix, created_by) values ($1,$2,$3,$4)",
    [hash(key), String(label || "Chrome extension").slice(0, 80), key.slice(0, 7), String(email || "")]);
  return key;
}
async function listKeys(pool) {
  const r = await pool.query("select id, label, prefix, created_by, created_at, last_used_at from api_keys where revoked_at is null order by created_at desc");
  return r.rows.map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, createdBy: k.created_by, createdAt: k.created_at, lastUsedAt: k.last_used_at }));
}
async function revokeKey(pool, id) { await pool.query("update api_keys set revoked_at = now() where id = $1", [String(id)]); }

function keyAuth(pool) {
  return async (req, res, next) => {
    const m = /^Bearer\s+(rk_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || "");
    if (!m) return res.status(401).json({ error: "Add your Radar key in the extension's settings." });
    try {
      const r = await pool.query("update api_keys set last_used_at = now() where key_hash = $1 and revoked_at is null returning created_by", [hash(m[1])]);
      if (!r.rows.length) return res.status(401).json({ error: "This Radar key isn't valid any more. Create a new one in Radar → Settings." });
      req.extUser = r.rows[0].created_by;
      next();
    } catch (err) { next(err); }
  };
}

// "https://www.linkedin.com/in/jane-doe-123/?x" -> "jane-doe-123"
function profileSlug(url) {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(String(url || ""));
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|ltd|limited|corp|corporation|co|group|gmbh|sa|the)\b/g, " ").replace(/\s+/g, " ").trim();
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || "");

function contactJson(c, lead, drafts, acts) {
  return {
    id: c.id, name: c.name, title: c.title, linkedin: c.linkedin, stage: c.stage, step: c.sequence_step || 0,
    nextFollowUp: dstr(c.next_follow_up), lastContacted: dstr(c.last_contacted), isPrimary: c.is_primary,
    agentFound: c.agent_found, sourceUrl: c.source_url || "",
    lead: lead ? { id: lead.id, company: lead.company, status: lead.status, priority: lead.priority, inCrm: lead.in_crm, jobTitle: lead.job_title } : null,
    drafts: (drafts || []).map((d) => ({ id: d.id, kind: d.kind, touch: d.touch, body: d.body, why: (d.meta && d.meta.why) || "" })),
    activities: (acts || []).map((a) => ({ type: a.type, direction: a.direction, date: dstr(a.activity_date), summary: a.summary })),
  };
}

async function loadContact(pool, id) {
  const c = (await pool.query("select * from contacts where id = $1", [id])).rows[0];
  if (!c) return null;
  const lead = (await pool.query("select * from leads where id = $1", [c.lead_id])).rows[0];
  const drafts = (await pool.query(
    "select * from agent_drafts where contact_id = $1 and kind <> 'contact' and used_at is null and dismissed_at is null order by touch, created_at", [id])).rows;
  const acts = (await pool.query("select * from activities where contact_id = $1 order by activity_date desc, sort_order desc limit 5", [id])).rows;
  return contactJson(c, lead, drafts, acts);
}

async function lookup(pool, q) {
  const slug = profileSlug(q.linkedin);
  let contact = null;
  if (slug) {
    const r = await pool.query(
      "select id from contacts where lower(linkedin) ~ ('linkedin\\.com/in/' || $1 || '(/|\\?|#|$)') order by sort_order limit 1",
      [slug.replace(/[^a-z0-9%_-]/g, "")]);
    if (r.rows.length) contact = await loadContact(pool, r.rows[0].id);
  }
  if (!contact && q.name) {
    // Saved without a LinkedIn URL (or with a different one): match on the name, using the company
    // to choose when the same name appears more than once. Then remember the URL for next time.
    const r = await pool.query(
      "select c.id, c.linkedin, l.company from contacts c join leads l on l.id = c.lead_id where lower(regexp_replace(c.name, '\\s+', ' ', 'g')) = lower($1)",
      [String(q.name).replace(/\s+/g, " ").trim()]);
    const co = norm(q.company);
    const sameCo = (x) => co && norm(x.company) && (norm(x.company) === co || norm(x.company).startsWith(co) || co.startsWith(norm(x.company)));
    const withoutUrl = r.rows.filter((x) => !profileSlug(x.linkedin));
    const hit = r.rows.find(sameCo) || (withoutUrl.length === 1 && r.rows.length === 1 ? withoutUrl[0] : null);
    if (hit) {
      if (slug && !profileSlug(hit.linkedin)) {
        await pool.query("update contacts set linkedin = $2 where id = $1", [hit.id, "https://www.linkedin.com/in/" + slug + "/"]);
      }
      contact = await loadContact(pool, hit.id);
    }
  }
  const companies = q.company ? await matchLeads(pool, q.company) : [];
  return { contact, companies };
}

async function matchLeads(pool, company) {
  const n = norm(company);
  if (!n) return [];
  const r = await pool.query("select id, company, status, priority, in_crm, website from leads");
  const scored = r.rows.map((l) => {
    const ln = norm(l.company);
    let score = 0;
    if (ln === n) score = 3;
    else if (ln && (ln.startsWith(n) || n.startsWith(ln))) score = 2;
    else if (ln && (ln.includes(n) || n.includes(ln))) score = 1;
    return { l, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (b.l.in_crm - a.l.in_crm));
  return scored.slice(0, 5).map(({ l }) => ({ id: l.id, company: l.company, status: l.status, inCrm: l.in_crm }));
}

async function searchLeads(pool, q) {
  const s = String(q || "").trim();
  const r = s
    ? await pool.query("select id, company, status, in_crm from leads where company ilike $1 order by in_crm desc, company limit 12", ["%" + s + "%"])
    : await pool.query("select id, company, status, in_crm from leads where in_crm order by company limit 30");
  return r.rows.map((l) => ({ id: l.id, company: l.company, status: l.status, inCrm: l.in_crm }));
}

async function addContact(pool, b) {
  const lead = (await pool.query("select id from leads where id = $1", [String(b.leadId || "")])).rows[0];
  if (!lead) throw Object.assign(new Error("Pick a company in Radar first."), { status: 400 });
  const name = String(b.name || "").trim().slice(0, 120);
  if (!name) throw Object.assign(new Error("The name is missing."), { status: 400 });
  const slug = profileSlug(b.linkedin);
  const linkedin = slug ? "https://www.linkedin.com/in/" + slug + "/" : "";
  if (slug) {
    const dup = await pool.query("select id from contacts where lower(linkedin) ~ ('linkedin\\.com/in/' || $1 || '(/|\\?|#|$)') limit 1", [slug.replace(/[^a-z0-9%_-]/g, "")]);
    if (dup.rows.length) return loadContact(pool, dup.rows[0].id);
  }
  const id = "cx" + crypto.randomBytes(5).toString("hex");
  const title = [String(b.title || "").trim(), b.location ? "(" + String(b.location).trim() + ")" : ""].filter(Boolean).join(" ").slice(0, 300);
  await pool.query(
    `insert into contacts (id, lead_id, name, title, email, phone, linkedin, roles, sort_order, stage, sequence_step, is_primary, agent_found, source_url)
     values ($1,$2,$3,$4,'','',$5,'{}',(select coalesce(max(sort_order)+1,0) from contacts where lead_id=$2),'Not contacted',0,false,false,$5)`,
    [id, lead.id, name, title, linkedin]
  );
  return loadContact(pool, id);
}

// what: 'connection' (touch 1 sent), 'message' (a later LinkedIn message sent), 'reply' (they replied), 'note'
async function logActivity(pool, b) {
  const c = (await pool.query("select * from contacts where id = $1", [String(b.contactId || "")])).rows[0];
  if (!c) throw Object.assign(new Error("That person isn't in Radar any more."), { status: 404 });
  const what = String(b.what || "");
  const summary = String(b.summary || "").slice(0, 4000);
  const t = today();
  let type = "LinkedIn message", direction = "Outbound", stage = c.stage, step = c.sequence_step || 0;
  if (what === "connection") { type = "LinkedIn connection"; step = Math.max(step, 1); if ((STAGE_RANK[stage] || 0) < 1) stage = "Connection sent"; }
  else if (what === "message") {
    const touch = Math.min(5, Math.max(2, parseInt(b.touch, 10) || step + 1));
    step = Math.max(step, touch);
    if ((STAGE_RANK[stage] || 0) < 3) stage = "Message sent";
  } else if (what === "reply") { direction = "Inbound"; if ((STAGE_RANK[stage] || 0) < 4 || stage === "Not interested") stage = "Replied"; }
  else if (what === "note") { type = "Note"; }
  else throw Object.assign(new Error("Unknown activity."), { status: 400 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const so = (await client.query("select coalesce(max(sort_order)+1,0) as n from activities where contact_id = $1", [c.id])).rows[0].n;
    await client.query(
      "insert into activities (id, lead_id, contact_id, type, direction, activity_date, summary, sort_order) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      ["a" + crypto.randomBytes(6).toString("hex"), c.lead_id, c.id, type, direction, t, summary, so]);
    if (what !== "note") {
      const next = CADENCE_DAYS[stage] ? addDays(t, CADENCE_DAYS[stage]) : null;
      await client.query(
        "update contacts set stage=$2, sequence_step=$3, last_contacted=$4, next_follow_up=$5, agent_found=false where id=$1",
        [c.id, stage, step, direction === "Outbound" ? t : (c.last_contacted || t), next]);
      // Drafts for this touch and earlier ones are used up; a reply also answers re-engagement drafts.
      await client.query(
        "update agent_drafts set used_at = now() where contact_id = $1 and used_at is null and dismissed_at is null and kind <> 'contact' and (touch <= $2 or kind = 'reengage')",
        [c.id, what === "reply" ? 99 : step]);
      const lead = (await client.query("select status from leads where id = $1", [c.lead_id])).rows[0];
      const target = STAGE_TO_STATUS[stage];
      const auto = ["Not Started", "Researching", "Contacted", "Replied", "Meeting Booked"];
      if (lead && target && auto.includes(lead.status) && STATUS_ORDER.indexOf(target) > STATUS_ORDER.indexOf(lead.status)) {
        await client.query("update leads set status = $2, updated_at = now() where id = $1", [c.lead_id, target]);
      }
    }
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  return loadContact(pool, c.id);
}

async function addNote(pool, b) {
  const lead = (await pool.query("select id from leads where id = $1", [String(b.leadId || "")])).rows[0];
  if (!lead) throw Object.assign(new Error("Pick a company in Radar first."), { status: 400 });
  const text = String(b.text || "").trim().slice(0, 8000);
  if (!text) throw Object.assign(new Error("The note is empty."), { status: 400 });
  await pool.query(
    "insert into lead_notes (lead_id, note_date, text, sort_order) values ($1, current_date, $2, (select coalesce(max(sort_order)+1,0) from lead_notes where lead_id=$1))",
    [lead.id, text + (b.sourceUrl ? "\n(From " + String(b.sourceUrl).slice(0, 300) + ")" : "")]);
  return { ok: true };
}

async function markChecked(pool, id) {
  await pool.query("update contacts set agent_found = false where id = $1", [String(id)]);
  return loadContact(pool, String(id));
}

module.exports = { markChecked, ensureSchema, createKey, listKeys, revokeKey, keyAuth, lookup, searchLeads, addContact, logActivity, addNote, profileSlug };
