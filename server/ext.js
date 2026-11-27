// API for the Nimbl Radar Chrome extension.
// The extension authenticates with a personal key (created in Radar → Settings), sent as
// "Authorization: Bearer rk_…". Keys are stored hashed; only /api/ext/* accepts them.
// Every write here goes through the database directly and bumps the lead's revision (trigger),
// so an open Radar tab picks the change up instead of overwriting it.
const crypto = require("crypto");

// "Request pending": after an InMail to someone who never accepted, the last InMail is a week later.
const CADENCE_DAYS = { "Connection sent": 4, "Request pending": 7, "Connected": 2, "Message sent": 5, "Replied": 2 };
const STAGE_RANK = { "Not contacted": 0, "No response": 0, "Connection sent": 1, "Request pending": 1.5, "Connected": 2, "Message sent": 3, "Replied": 4, "Meeting booked": 5, "Not interested": 99 };
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
create or replace function touch_lead() returns trigger language plpgsql set search_path = public as $$
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

const AUDIT_SCHEMA = require("fs").readFileSync(require("path").join(__dirname, "audit_schema.sql"), "utf8");
async function ensureSchema(pool) { await pool.query(SCHEMA); await pool.query(AUDIT_SCHEMA); }

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
      const r = await pool.query("update api_keys set last_used_at = now() where key_hash = $1 and revoked_at is null returning id, created_by", [hash(m[1])]);
      if (!r.rows.length) return res.status(401).json({ error: "This Radar key isn't valid any more. Create a new one in Radar → Settings." });
      req.extUser = r.rows[0].created_by;
      req.extKeyId = r.rows[0].id;
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

function leadCard(lead, people, notes, alerts, jds) {
  const ci = lead.client_info || {};
  return {
    roleType: lead.role_type || "", jobUrl: lead.job_url || "", datePosted: dstr(lead.date_posted),
    estSize: lead.est_size || "", website: lead.website || "", employmentType: lead.employment_type || "",
    companyProfile: lead.company_profile || "", nearshoreFit: lead.nearshore_fit || "",
    linkedin: ci.linkedin || "", linkedinSummary: ci.linkedinSummary || "",
    people: (people || []).map((p) => ({ id: p.id, name: p.name, title: p.title, stage: p.stage, linkedin: p.linkedin, isPrimary: p.is_primary, nextFollowUp: dstr(p.next_follow_up) })),
    notes: (notes || []).map((n) => ({ date: dstr(n.note_date), text: n.text, author: n.author || "" })),
    roles: (alerts || []).map((a) => ({ title: a.job_title, url: a.job_url, date: dstr(a.date_posted) || dstr(a.found_at), seen: !!a.seen_at })),
    jobDescriptions: (jds || []).map((j) => ({ id: j.id, title: (j.content && j.content.title) || "Job description", status: j.status })),
  };
}

function contactJson(c, lead, drafts, acts) {
  return {
    id: c.id, name: c.name, title: c.title, linkedin: c.linkedin, stage: c.stage, step: c.sequence_step || 0,
    location: c.location || "", owner: c.owner || "",
    nextFollowUp: dstr(c.next_follow_up), lastContacted: dstr(c.last_contacted), isPrimary: c.is_primary,
    agentFound: c.agent_found, sourceUrl: c.source_url || "",
    lead: lead ? { id: lead.id, company: lead.company, status: lead.status, priority: lead.priority, inCrm: lead.in_crm, jobTitle: lead.job_title } : null,
    // Someone who never accepted the request gets the InMail/email drafts, not "thanks for connecting".
    drafts: (drafts || []).filter((d) => c.stage !== "Request pending" || !/^\s*(thanks|thank you)( so much)? for connecting/i.test(d.body || "")).map((d) => ({ id: d.id, kind: d.kind, touch: d.touch, body: d.body, why: (d.meta && d.meta.why) || "" })),
    activities: (acts || []).map((a) => ({ type: a.type, direction: a.direction, date: dstr(a.activity_date), summary: a.summary, author: a.author || "" })),
  };
}

async function loadContact(pool, id) {
  const c = (await pool.query("select * from contacts where id = $1", [id])).rows[0];
  if (!c) return null;
  const lead = (await pool.query("select * from leads where id = $1", [c.lead_id])).rows[0];
  const drafts = (await pool.query(
    "select * from agent_drafts where contact_id = $1 and kind <> 'contact' and used_at is null and dismissed_at is null order by touch, created_at", [id])).rows;
  const acts = (await pool.query("select * from activities where contact_id = $1 order by activity_date desc, sort_order desc limit 25", [id])).rows;
  const out = contactJson(c, lead, drafts, acts);
  if (lead) {
    // The bigger "client card" view in the extension shows the company around this person.
    const [people, notes, alerts, jds] = await Promise.all([
      pool.query("select id, name, title, stage, linkedin, is_primary, next_follow_up from contacts where lead_id = $1 order by sort_order, id", [lead.id]),
      pool.query("select note_date, text, author from lead_notes where lead_id = $1 order by note_date desc nulls last, sort_order desc limit 6", [lead.id]),
      pool.query("select job_title, job_url, date_posted, found_at, seen_at from role_alerts where lead_id = $1 and closed_at is null and promoted_at is null order by found_at desc limit 6", [lead.id]),
      pool.query("select id, content, status from job_descriptions where lead_id = $1 order by created_at desc", [lead.id]).catch(() => ({ rows: [] })),
    ]);
    out.card = leadCard(lead, people.rows, notes.rows, alerts.rows, jds.rows);
  }
  return out;
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
  // The company's LinkedIn page, from the "current company" link on the profile, when Radar has none
  // and the profile's company is the same one.
  const coUrl = String(q.companyUrl || "");
  if (contact && contact.lead && /linkedin\.com\/company\/[^/?#]+/i.test(coUrl) && q.company) {
    const co = norm(q.company), lc = norm(contact.lead.company);
    if (co && lc && (co === lc || co.startsWith(lc) || lc.startsWith(co))) {
      const slug = require("./companyli").companySlug(coUrl);
      if (slug && !/^\d+$/.test(slug)) await require("./companyli").saveIfMissing(pool, contact.lead.id, "https://www.linkedin.com/company/" + slug + "/", "LinkedIn profile").catch(() => {});
    }
  }
  // Fill in where the person is based from their profile, when Radar doesn't have it yet.
  const loc = String(q.location || "").trim();
  if (contact && !contact.location && loc && loc.length <= 80) {
    await pool.query("update contacts set location = $2 where id = $1 and location = ''", [contact.id, loc]);
    contact.location = loc;
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
  const title = String(b.title || "").trim().slice(0, 300);
  const location = String(b.location || "").trim().slice(0, 120);
  await pool.query(
    `insert into contacts (id, lead_id, name, title, email, phone, linkedin, roles, sort_order, stage, sequence_step, is_primary, agent_found, source_url, location)
     values ($1,$2,$3,$4,'','',$5,'{}',(select coalesce(max(sort_order)+1,0) from contacts where lead_id=$2),'Not contacted',0,false,false,$5,$6)`,
    [id, lead.id, name, title, linkedin, location]
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
    // An InMail to someone who never accepted the request keeps them in "Request pending".
    if ((STAGE_RANK[stage] || 0) < 3 && stage !== "Request pending") stage = "Message sent";
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
      // Getting back in touch answers the company's new-role alerts, as logging in the app does.
      if (direction === "Outbound") {
        await client.query("update role_alerts set seen_at = now() where lead_id = $1 and seen_at is null and closed_at is null", [c.lead_id]);
      }
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

// The extension's Home screen: what needs doing today, what's new, how outreach is going (whole
// team) and where the pipeline stands. One round of read-only queries.
async function home(pool, opts = {}) {
  const me = opts.me ? String(opts.me).toLowerCase() : "";
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const OPEN = "l.status not in ('Lost','Not a Fit')";
  const [meta, follow, drafts, checks, newLeads, newRoles, dials, rate, pipe, jds, cands, totals, since] = await Promise.all([
    q("select last_scanned from meta where id = 1"),
    q(`select c.id, c.name, c.title, c.linkedin, c.stage, c.next_follow_up, c.sequence_step, l.id lead_id, l.company, l.in_crm,
              (current_date - c.next_follow_up) as days_over
         from contacts c join leads l on l.id = c.lead_id
        where ${OPEN} and c.next_follow_up is not null and c.next_follow_up <= current_date and c.stage <> 'Not interested' and c.owner = ''
          and ($1 = '' or lower(coalesce(nullif((select a.author from activities a where a.contact_id = c.id and a.type <> 'Note'
                order by a.activity_date desc, a.sort_order desc limit 1), ''), c.added_by)) = $1)
        order by c.next_follow_up, l.in_crm desc, c.name`, [me]),
    q(`select d.contact_id, d.touch, d.kind, c.name, c.linkedin, l.id lead_id, l.company, l.in_crm
         from agent_drafts d join leads l on l.id = d.lead_id left join contacts c on c.id = d.contact_id
        where d.used_at is null and d.dismissed_at is null and d.kind <> 'contact' and d.created_at > now() - interval '21 days'
          and ${OPEN} and (coalesce(d.contact_id, '') = '' or (c.id is not null and c.owner = '' and c.stage not in ('Not interested','No response')))
        order by l.in_crm desc, d.created_at desc`),
    q(`select c.id, c.name, c.title, c.linkedin, l.id lead_id, l.company, l.in_crm
         from contacts c join leads l on l.id = c.lead_id
        where ${OPEN} and c.agent_found order by l.in_crm desc, l.date_added desc, c.sort_order`),
    q(`select id, company, job_title, priority, date_added, in_crm from leads
        where date_added > current_date - 7 order by date_added desc, (priority = 'High') desc, company`),
    q(`select a.lead_id, l.company, a.job_title, a.job_url, a.found_at from role_alerts a join leads l on l.id = a.lead_id
        where a.seen_at is null and a.closed_at is null and a.promoted_at is null and ${OPEN} order by a.found_at desc`),
    q(`select case when activity_date > current_date - 7 then 'this' else 'last' end as wk,
              count(*) filter (where type = 'LinkedIn connection' and direction = 'Outbound') connections,
              count(*) filter (where type in ('LinkedIn message','Email','Call') and direction = 'Outbound') messages,
              count(*) filter (where direction = 'Inbound' and type <> 'Note') replies,
              count(*) filter (where type = 'Meeting' or (type = 'Note' and summary like '%→ Meeting booked%')) meetings
         from activities where activity_date > current_date - 14 and ($1 = '' or lower(author) = $1) group by 1`, [me]),
    q(`with mine as (select distinct contact_id from activities
                        where activity_date > current_date - 30 and direction = 'Outbound' and type <> 'Note' and ($1 = '' or lower(author) = $1))
       select (select count(*) from mine) contacted,
              (select count(distinct a.contact_id) from activities a join mine m on m.contact_id = a.contact_id
                where a.activity_date > current_date - 30 and a.direction = 'Inbound' and a.type <> 'Note') replied`, [me]),
    q(`select status, count(*)::int n from leads l where in_crm group by status`),
    q(`select status, count(*)::int n from job_descriptions group by status`).catch(() => []),
    q(`select stage, count(*)::int n from candidates group by stage`),
    q(`select count(*)::int leads, count(*) filter (where in_crm)::int crm from leads`),
    q(`select min(at) at from audit_log`),
  ]);
  const person = (r) => ({ contactId: r.id || r.contact_id || "", name: r.name || "", title: r.title || "", linkedin: r.linkedin || "", leadId: r.lead_id, company: r.company, inCrm: !!r.in_crm });
  const wk = (k) => { const r = dials.find((x) => x.wk === k) || {}; return { connections: +r.connections || 0, messages: +r.messages || 0, replies: +r.replies || 0, meetings: +r.meetings || 0 }; };
  const STAGES = ["Not Started", "Researching", "Contacted", "Replied", "Meeting Booked", "Proposal Sent", "Won"];
  const count = (rows, key, v) => (rows.find((x) => x[key] === v) || {}).n || 0;
  const r0 = rate[0] || {};
  const draftsByContact = {};
  drafts.forEach((d) => { const k = d.contact_id || d.lead_id; if (!draftsByContact[k]) draftsByContact[k] = Object.assign(person(d), { touch: d.touch, kind: d.kind }); });
  return {
    scope: me ? "me" : "team",
    trackedSince: since[0] && since[0].at ? dstr(since[0].at) : "",
    today: dstr(new Date()),
    lastScanned: dstr(meta[0] && meta[0].last_scanned),
    todo: {
      followUps: follow.map((r) => Object.assign(person(r), { stage: r.stage, due: dstr(r.next_follow_up), daysOver: +r.days_over || 0, touch: Math.min(5, (r.sequence_step || 0) + 1) })),
      drafts: { count: drafts.length, people: Object.values(draftsByContact) },
      titleChecks: checks.map(person),
    },
    fresh: {
      newLeads: newLeads.map((l) => ({ id: l.id, company: l.company, jobTitle: l.job_title, priority: l.priority, dateAdded: dstr(l.date_added), inCrm: l.in_crm })),
      newRoles: newRoles.map((a) => ({ leadId: a.lead_id, company: a.company, jobTitle: a.job_title, url: a.job_url, found: dstr(a.found_at) })),
    },
    dials: { thisWeek: wk("this"), lastWeek: wk("last"), replyRate: { contacted: +r0.contacted || 0, replied: +r0.replied || 0 } },
    pipeline: {
      stages: STAGES.map((s) => ({ status: s, count: count(pipe, "status", s) })),
      closed: count(pipe, "status", "Lost") + count(pipe, "status", "Not a Fit"),
      jds: { ready: count(jds, "status", "ready"), waiting: count(jds, "status", "waiting") },
      candidates: { inProgress: cands.filter((c) => !["Placed", "Not Placed"].includes(c.stage)).reduce((a, c) => a + c.n, 0), placed: count(cands, "stage", "Placed") },
      totals: totals[0] || { leads: 0, crm: 0 },
    },
  };
}

// Who the extension is signed in as (from the key), with name and photo from their last Radar sign-in.
async function me(pool, email, keyId, isOwner) {
  const u = (await pool.query("select name, photo from radar_users where email = $1", [String(email || "").toLowerCase()])).rows[0] || {};
  const nice = String(email || "").split("@")[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const photo = u.photo && u.photo.length !== 1000 ? u.photo : ""; // exactly 1000 = cut off by an old limit
  return { email: email || "", name: u.name || nice || "Radar user", photo, isOwner: !!isOwner, keyId: keyId || "" };
}

// The extension's profile page: your numbers this month vs last month (from what you logged),
// the browsers connected to your account, and when Radar started recording who did what.
async function profile(pool, email, keyId, isOwner) {
  const e = String(email || "").toLowerCase();
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const month = (col) => `case when ${col} >= date_trunc('month', current_date) then 'this' when ${col} >= date_trunc('month', current_date) - interval '1 month' then 'last' end`;
  const [who, acts, rate, adds, saved, placed, keys, since] = await Promise.all([
    me(pool, e, keyId, isOwner),
    q(`select ${month("activity_date")} as m,
              count(*) filter (where type = 'LinkedIn connection' and direction = 'Outbound') connections,
              count(*) filter (where type in ('LinkedIn message','Email','Call') and direction = 'Outbound') messages,
              count(*) filter (where direction = 'Inbound' and type <> 'Note') replies,
              count(*) filter (where type = 'Meeting' or (type = 'Note' and summary like '%→ Meeting booked%')) meetings
         from activities where lower(author) = $1 and activity_date >= date_trunc('month', current_date) - interval '1 month' group by 1`, [e]),
    q(`with mine as (select distinct contact_id from activities where lower(author) = $1 and direction = 'Outbound' and type <> 'Note'
                        and activity_date > current_date - 30)
       select (select count(*) from mine) contacted,
              (select count(distinct a.contact_id) from activities a join mine m on m.contact_id = a.contact_id
                where a.direction = 'Inbound' and a.type <> 'Note' and a.activity_date > current_date - 30) replied`, [e]),
    q(`select ${month("at")} as m, count(*)::int n from audit_log where lower(actor) = $1 and action = 'contact' and detail like 'Added contact%' group by 1`, [e]),
    q(`select ${month("at")} as m, count(*)::int n from audit_log where lower(actor) = $1 and action = 'crm' and detail = 'Saved to the CRM' group by 1`, [e]),
    q(`select count(*)::int n from audit_log where lower(actor) = $1 and action = 'candidate' and detail like '%→ Placed'`, [e]),
    q(`select id, label, prefix, created_at, last_used_at from api_keys where lower(created_by) = $1 and revoked_at is null order by last_used_at desc nulls last, created_at desc`, [e]),
    q(`select min(at) at from audit_log`),
  ]);
  const pick = (rows, m) => { const r = rows.find((x) => x.m === m) || {}; return { connections: +r.connections || 0, messages: +r.messages || 0, replies: +r.replies || 0, meetings: +r.meetings || 0 }; };
  const n = (rows, m) => (rows.find((x) => x.m === m) || {}).n || 0;
  const thisM = Object.assign(pick(acts, "this"), { contactsAdded: n(adds, "this"), savedToCrm: n(saved, "this") });
  const lastM = Object.assign(pick(acts, "last"), { contactsAdded: n(adds, "last"), savedToCrm: n(saved, "last") });
  const r0 = rate[0] || {};
  return {
    user: who,
    thisMonth: thisM, lastMonth: lastM,
    replyRate: { contacted: +r0.contacted || 0, replied: +r0.replied || 0 },
    placements: (placed[0] || {}).n || 0,
    trackedSince: since[0] && since[0].at ? dstr(since[0].at) : "",
    keys: keys.map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, createdAt: dstr(k.created_at), lastUsedAt: k.last_used_at ? dstr(k.last_used_at) : "", current: k.id === keyId })),
  };
}

async function revokeOwnKey(pool, email, id) {
  const r = await pool.query("update api_keys set revoked_at = now() where id = $1 and lower(created_by) = $2 and revoked_at is null returning id",
    [String(id), String(email || "").toLowerCase()]);
  return r.rows.length > 0;
}

async function recordUser(pool, user) {
  if (!user || !user.email) return;
  await pool.query(
    `insert into radar_users (email, name, photo) values ($1, $2, $3)
     on conflict (email) do update set name = excluded.name, photo = excluded.photo, last_seen = now()`,
    [String(user.email).toLowerCase(), String(user.name || "").slice(0, 200), String(user.photo || "").slice(0, 8000)]);
}

module.exports = { me, profile, revokeOwnKey, recordUser, home, markChecked, ensureSchema, createKey, listKeys, revokeKey, keyAuth, lookup, searchLeads, addContact, logActivity, addNote, profileSlug };
