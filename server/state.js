// Reads and writes the whole Nimbl Radar state as the single nested JSON
// object the frontend (public/app.js) already works with. This mirrors the
// "one document" model the original Claude Artifact prototype used, just
// backed by real Postgres tables instead of an in-page blob — see the
// schema in db/schema.sql. A save replaces a lead's child rows
// (notes/contacts/contact activities/documents/candidates) wholesale, but only for
// leads whose content actually changed: the browser always sends every lead, and
// rewriting all of them took hundreds of database round trips per save.

const CONTACT_STAGES = ["Not contacted", "Connection sent", "Request pending", "Connected", "Message sent", "Replied", "Meeting booked", "Not interested", "No response"];
const ACTIVITY_TYPES = ["LinkedIn connection", "LinkedIn message", "Email", "Call", "Meeting", "Note"];
const ACTIVITY_DIRECTIONS = ["Outbound", "Inbound"];

function emptyClientInfo() {
  return { address: "", phone: "", taxId: "", currency: "USD", linkedin: "" };
}

function emptyContractor() {
  return {
    firstName: "", middleName: "", lastName: "", gender: "", payMethod: "",
    jobTitle: "", paymentRefTemplate: "", mainTask: "", companyName: "",
    companyTaxId: "", companyAddress: "", companyType: "", birthdate: "", startDate: "", endDate: "",
  };
}

function dateOrEmpty(d) {
  return d || "";
}

function dateOrNull(d) {
  return d ? d : null;
}

async function getState(pool) {
  const metaRes = await pool.query("select last_scanned from meta where id = 1");
  const roleTypesRes = await pool.query("select name from role_types order by sort_order, id");
  const leadsRes = await pool.query("select * from leads order by date_added desc nulls last, created_at desc");
  const leadIds = leadsRes.rows.map((r) => r.id);

  const notesRes = leadIds.length
    ? await pool.query("select * from lead_notes where lead_id = any($1) order by sort_order, id", [leadIds])
    : { rows: [] };
  const contactsRes = leadIds.length
    ? await pool.query("select * from contacts where lead_id = any($1) order by sort_order, id", [leadIds])
    : { rows: [] };
  const activitiesRes = leadIds.length
    ? await pool.query("select * from activities where lead_id = any($1) order by activity_date, sort_order, id", [leadIds])
    : { rows: [] };
  const docsRes = leadIds.length
    ? await pool.query("select * from documents where lead_id = any($1) order by sort_order, id", [leadIds])
    : { rows: [] };
  const candsRes = leadIds.length
    ? await pool.query("select * from candidates where lead_id = any($1) order by sort_order, id", [leadIds])
    : { rows: [] };
  const alertsRes = leadIds.length
    ? await pool.query("select * from role_alerts where lead_id = any($1) and promoted_at is null order by found_at desc, id", [leadIds])
    : { rows: [] };
  const alertsByLead = groupBy(alertsRes.rows, "lead_id");
  const draftsRes = leadIds.length
    ? await pool.query(
        `select * from agent_drafts where lead_id = any($1) and used_at is null and dismissed_at is null
           and created_at > now() - interval '21 days' order by created_at desc, id`, [leadIds])
    : { rows: [] };
  const draftsByLead = groupBy(draftsRes.rows, "lead_id");
  const candIds = candsRes.rows.map((r) => r.id);
  const candNotesRes = candIds.length
    ? await pool.query("select * from candidate_notes where candidate_id = any($1) order by sort_order, id", [candIds])
    : { rows: [] };
  const candDocsRes = candIds.length
    ? await pool.query("select * from candidate_documents where candidate_id = any($1) order by sort_order, id", [candIds])
    : { rows: [] };

  const notesByLead = groupBy(notesRes.rows, "lead_id");
  const contactsByLead = groupBy(contactsRes.rows, "lead_id");
  const activitiesByContact = groupBy(activitiesRes.rows, "contact_id");
  const docsByLead = groupBy(docsRes.rows, "lead_id");
  const candsByLead = groupBy(candsRes.rows, "lead_id");
  const candNotesByCand = groupBy(candNotesRes.rows, "candidate_id");
  const candDocsByCand = groupBy(candDocsRes.rows, "candidate_id");

  const leads = leadsRes.rows.map((l) => ({
    id: l.id,
    // Revision: changes whenever the lead or any of its contacts, activities, notes, documents or
    // candidates change (a trigger keeps leads.updated_at current). A save that was based on an
    // older revision is refused for that lead, so a stale tab can't wipe out newer work.
    rev: l.updated_at ? l.updated_at.toISOString() : "",
    company: l.company,
    website: l.website || "",
    roleType: l.role_type || "",
    jobTitle: l.job_title || "",
    jobUrl: l.job_url || "",
    datePosted: dateOrEmpty(l.date_posted),
    jobClosedAt: dateOrEmpty(l.job_closed_at),
    dateAdded: dateOrEmpty(l.date_added),
    employmentType: l.employment_type || "",
    estSize: l.est_size || "",
    priority: l.priority,
    endClient: l.end_client || "",
    companyProfile: l.company_profile || "",
    requiredSkills: l.required_skills || "",
    nearshoreFit: l.nearshore_fit || "",
    status: l.status,
    isNew: l.is_new,
    inCrm: !!l.in_crm,
    crmSavedAt: dateOrEmpty(l.crm_saved_at),
    clientInfo: l.client_info || emptyClientInfo(),
    agentDrafts: (draftsByLead[l.id] || []).map((d) => ({
      id: d.id, contactId: d.contact_id || "", kind: d.kind, touch: d.touch || 0, body: d.body || "",
      meta: d.meta || {}, createdAt: d.created_at.toISOString().slice(0, 10),
    })),
    roleAlerts: (alertsByLead[l.id] || []).map((a) => ({
      id: a.id, roleType: a.role_type || "", jobTitle: a.job_title || "", jobUrl: a.job_url || "",
      datePosted: dateOrEmpty(a.date_posted), note: a.note || "",
      foundAt: a.found_at.toISOString().slice(0, 10), seen: !!a.seen_at, closedAt: dateOrEmpty(a.closed_at),
    })),
    contacts: (contactsByLead[l.id] || []).map((c) => ({
      id: c.id, name: c.name || "", title: c.title || "", email: c.email || "",
      phone: c.phone || "", linkedin: c.linkedin || "", roles: c.roles || [],
      location: c.location || "", owner: c.owner || "",
      stage: c.stage || "Not contacted",
      nextFollowUp: dateOrEmpty(c.next_follow_up),
      lastContacted: dateOrEmpty(c.last_contacted),
      sequenceStep: c.sequence_step || 0,
      isPrimary: !!c.is_primary,
      agentFound: !!c.agent_found,
      sourceUrl: c.source_url || "",
      addedBy: c.added_by || "",
      emailInfo: c.email_info || null,
      activities: (activitiesByContact[c.id] || []).map((a) => ({
        id: a.id, type: a.type, direction: a.direction, date: dateOrEmpty(a.activity_date), summary: a.summary || "",
        author: a.author || "",
      })),
    })),
    documents: (docsByLead[l.id] || []).map((d) => ({ id: d.id, name: d.name || "" })),
    candidates: (candsByLead[l.id] || []).map((c) => ({
      id: c.id, name: c.name || "", jobTitle: c.job_title || "", linkedin: c.linkedin || "",
      email: c.email || "", phone: c.phone || "", country: c.country || "", stage: c.stage,
      contractor: c.contractor || emptyContractor(),
      notes: (candNotesByCand[c.id] || []).map((n) => ({ date: dateOrEmpty(n.note_date), text: n.text || "" })),
      documents: (candDocsByCand[c.id] || []).map((d) => ({ id: d.id, name: d.name || "" })),
    })),
    notes: (notesByLead[l.id] || []).map((n) => ({ date: dateOrEmpty(n.note_date), text: n.text || "", author: n.author || "" })),
  }));

  return {
    lastScanned: dateOrEmpty(metaRes.rows[0] && metaRes.rows[0].last_scanned),
    roleTypes: roleTypesRes.rows.map((r) => r.name),
    leads,
  };
}

function groupBy(rows, key) {
  const out = {};
  for (const row of rows) {
    (out[row[key]] = out[row[key]] || []).push(row);
  }
  return out;
}

// Canonical JSON (sorted keys) so jsonb key order never makes equal values look different.
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

function d10(d) {
  return d ? String(d).slice(0, 10) : "";
}

// Exactly the values putState would write for a lead, in the shape getState reads them back.
// Two leads with the same fingerprint produce identical rows, so the write can be skipped.
// `current` supplies the stored in_crm / crm_saved_at when the payload leaves them out.
function leadFingerprint(l, current) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  return canon({
    id: l.id, company: l.company, website: l.website || "", roleType: l.roleType || "", jobTitle: l.jobTitle || "",
    jobUrl: l.jobUrl || "", datePosted: d10(l.datePosted), dateAdded: d10(l.dateAdded),
    employmentType: l.employmentType || "", estSize: l.estSize || "", priority: l.priority || "Medium",
    endClient: l.endClient || "", companyProfile: l.companyProfile || "", requiredSkills: l.requiredSkills || "",
    nearshoreFit: l.nearshoreFit || "", status: l.status || "Not Started", isNew: !!l.isNew,
    clientInfo: l.clientInfo || emptyClientInfo(),
    inCrm: typeof l.inCrm === "boolean" ? l.inCrm : !!(current && current.inCrm),
    crmSavedAt: d10(l.crmSavedAt) || (current ? d10(current.crmSavedAt) : ""),
    notes: arr(l.notes).map((n) => [d10(n.date), n.text || ""]),
    contacts: arr(l.contacts).map((c) => [
      c.id, c.name || "", c.title || "", c.email || "", c.phone || "", c.linkedin || "", c.roles || [],
      c.location || "", c.owner || "",
      CONTACT_STAGES.includes(c.stage) ? c.stage : "Not contacted", d10(c.nextFollowUp), d10(c.lastContacted),
      Math.min(5, Math.max(0, parseInt(c.sequenceStep, 10) || 0)), c.isPrimary === true,
      c.agentFound === true, String(c.sourceUrl || "").slice(0, 1000),
      arr(c.activities).map((a) => [
        a.id, ACTIVITY_TYPES.includes(a.type) ? a.type : "Note",
        ACTIVITY_DIRECTIONS.includes(a.direction) ? a.direction : "Outbound", d10(a.date), a.summary || "",
      ]),
    ]),
    documents: arr(l.documents).map((d) => [d.id, d.name || ""]),
    candidates: arr(l.candidates).map((c) => [
      c.id, c.name || "", c.jobTitle || "", c.linkedin || "", c.email || "", c.phone || "", c.country || "",
      c.stage || "Identified", c.contractor || emptyContractor(),
      arr(c.notes).map((n) => [d10(n.date), n.text || ""]),
      arr(c.documents).map((d) => [d.id, d.name || ""]),
    ]),
  });
}

// What a save changed on one company, as readable lines for its history (audit_log). Browser saves
// rewrite a company's rows wholesale, so the database triggers stay quiet during them and this diff
// records what actually changed instead.
function describeChanges(cur, l) {
  const out = [];
  const add = (action, detail) => out.push({ action, detail: String(detail).slice(0, 400) });
  const arr = (x) => (Array.isArray(x) ? x : []);
  if (!cur) { add("company", "Added " + (l.company || "a company") + " to Radar"); return out; }
  if ((l.status || "Not Started") !== cur.status) add("status", "Status: " + cur.status + " → " + (l.status || "Not Started"));
  if ((l.priority || "Medium") !== cur.priority) add("priority", "Priority: " + cur.priority + " → " + (l.priority || "Medium"));
  if (typeof l.inCrm === "boolean" && l.inCrm !== cur.inCrm) add("crm", l.inCrm ? "Saved to the CRM" : "Removed from the CRM");
  const fields = [["company", "name"], ["website", "website"], ["roleType", "role type"], ["jobTitle", "role"], ["jobUrl", "job link"],
    ["employmentType", "employment type"], ["estSize", "size"], ["endClient", "end client"], ["companyProfile", "company profile"],
    ["requiredSkills", "required skills"], ["nearshoreFit", "nearshore fit"]];
  const changed = fields.filter(([k]) => (l[k] || "") !== (cur[k] || "")).map(([, label]) => label);
  if (changed.length) add("company", "Edited " + changed.join(", "));
  if (canon(l.clientInfo || emptyClientInfo()) !== canon(cur.clientInfo || emptyClientInfo())) add("company", "Edited client details");

  const curContacts = {}; for (const c of arr(cur.contacts)) curContacts[c.id] = c;
  const newIds = new Set(arr(l.contacts).map((c) => c.id));
  for (const c of arr(l.contacts)) {
    const o = curContacts[c.id];
    if (!o) { add("contact", "Added contact " + (c.name || "") + (c.title ? " (" + c.title + ")" : "")); }
    else {
      const stage = CONTACT_STAGES.includes(c.stage) ? c.stage : "Not contacted";
      if (stage !== o.stage) add("stage", (c.name || o.name) + ": " + o.stage + " → " + stage);
      if ((c.name || "") !== o.name || (c.title || "") !== o.title || (c.email || "") !== o.email || (c.phone || "") !== o.phone || (c.linkedin || "") !== o.linkedin || (c.location || "") !== (o.location || ""))
        add("contact", "Edited contact " + (c.name || o.name));
      if (c.isPrimary === true && !o.isPrimary) add("contact", (c.name || o.name) + " is now the first person to contact");
      if ((c.owner || "") !== (o.owner || "")) add("contact", (c.name || o.name) + (c.owner ? " is " + c.owner + "'s contact" : " is no longer marked as someone else's contact"));
    }
    const had = new Set(arr(o && o.activities).map((a) => a.id));
    for (const a of arr(c.activities)) {
      if (had.has(a.id)) continue;
      const type = ACTIVITY_TYPES.includes(a.type) ? a.type : "Note";
      add("activity", type + (a.direction === "Inbound" ? " from " : " to ") + (c.name || "a contact") + (a.summary ? ": " + String(a.summary).slice(0, 140) : ""));
    }
  }
  for (const o of arr(cur.contacts)) if (!newIds.has(o.id)) add("contact", "Removed contact " + o.name);

  const noteKey = (n) => d10(n.date) + "\u0000" + (n.text || "");
  const curNotes = {}; for (const n of arr(cur.notes)) curNotes[noteKey(n)] = (curNotes[noteKey(n)] || 0) + 1;
  for (const n of arr(l.notes)) {
    const k = noteKey(n);
    if (curNotes[k]) curNotes[k]--; else add("note", "Note: " + String(n.text || "").slice(0, 160));
  }
  const removed = Object.values(curNotes).reduce((s, v) => s + v, 0);
  if (removed) add("note", removed === 1 ? "Deleted a note" : "Deleted " + removed + " notes");

  const curCands = {}; for (const c of arr(cur.candidates)) curCands[c.id] = c;
  for (const c of arr(l.candidates)) {
    const o = curCands[c.id];
    if (!o) add("candidate", "Added candidate " + (c.name || ""));
    else if ((c.stage || "Identified") !== o.stage) add("candidate", "Candidate " + (c.name || o.name) + ": " + o.stage + " → " + (c.stage || "Identified"));
  }
  const curDocs = new Set(arr(cur.documents).map((d) => d.id));
  for (const d of arr(l.documents)) if (!curDocs.has(d.id)) add("document", "Added document " + (d.name || ""));
  return out;
}

// opts.actor: the signed-in person's email (recorded as the author of anything new in this save).
// opts.isOwner: false keeps the tracked role types as they are (only the owner may change them).
async function putState(pool, state, opts = {}) {
  const actor = String(opts.actor || "");
  // What is stored now, to skip leads that did not change. If reading fails, write everything.
  let stored = null;
  try { stored = await getState(pool); } catch (err) { console.error("putState: compare skipped", err.message); }
  const storedById = {};
  if (stored) for (const l of stored.leads) storedById[l.id] = l;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // radar.rewrite tells the audit triggers to stay quiet: the diff below writes the history instead.
    await client.query("select set_config('radar.actor', $1, true), set_config('radar.rewrite', 'on', true)", [actor]);

    // last_scanned is owned by the scanner: never let a (possibly stale) browser tab move it backwards.
    await client.query("update meta set last_scanned = greatest(last_scanned, $1::date) where id = 1", [dateOrNull(state.lastScanned)]);

    const roleTypes = Array.isArray(state.roleTypes) ? state.roleTypes : [];
    if (opts.isOwner !== false && (!stored || canon(stored.roleTypes) !== canon(roleTypes))) {
      await client.query("delete from role_types");
      for (let i = 0; i < roleTypes.length; i++) {
        await client.query("insert into role_types (name, sort_order) values ($1, $2)", [roleTypes[i], i]);
      }
    }

    const leads = Array.isArray(state.leads) ? state.leads : [];
    // Leads missing from the payload are NOT deleted: the app has no delete-lead action, and the daily
    // scan adds leads directly to the database, so a stale browser tab must never wipe them out.

    let written = 0;
    const conflicts = [];
    for (const l of leads) {
      const current = storedById[l.id];
      // A tab still running an older version of the app doesn't send newer contact fields: keep what's stored.
      if (current && Array.isArray(l.contacts)) {
        const was = {};
        for (const c of current.contacts) was[c.id] = c;
        for (const c of l.contacts) {
          if (!c || !was[c.id]) continue;
          for (const k of ["location", "owner"]) if (c[k] === undefined) c[k] = was[c.id][k];
        }
      }
      if (current && leadFingerprint(l, current) === leadFingerprint(current, current)) continue;
      if (current && l.rev && current.rev && l.rev !== current.rev) { conflicts.push(l.id); continue; }
      written++;
      const audit = describeChanges(current, l);
      // Keep who wrote what: authors come from what is stored, never from the browser's copy.
      const prevActs = {}, prevAdded = {}, prevNotes = {}, prevEmailInfo = {};
      if (current) {
        for (const c of current.contacts) {
          prevAdded[c.id] = c.addedBy;
          prevEmailInfo[c.id] = c.emailInfo;
          for (const a of c.activities) prevActs[a.id] = a.author;
        }
        for (const n of current.notes) {
          const k = d10(n.date) + "\u0000" + n.text;
          (prevNotes[k] = prevNotes[k] || []).push(n.author);
        }
      }
      await client.query(
        `insert into leads (id, company, website, role_type, job_title, job_url, date_posted, date_added,
           employment_type, est_size, priority, end_client, company_profile, required_skills, nearshore_fit,
           status, is_new, client_info, in_crm, crm_saved_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, coalesce($19::boolean, false), $20::date, now())
         on conflict (id) do update set
           company=excluded.company, website=excluded.website, role_type=excluded.role_type,
           job_title=excluded.job_title, job_url=excluded.job_url, date_posted=excluded.date_posted,
           date_added=excluded.date_added, employment_type=excluded.employment_type, est_size=excluded.est_size,
           priority=excluded.priority, end_client=excluded.end_client, company_profile=excluded.company_profile,
           required_skills=excluded.required_skills, nearshore_fit=excluded.nearshore_fit, status=excluded.status,
           is_new=excluded.is_new, client_info=excluded.client_info,
           in_crm=coalesce($19::boolean, leads.in_crm), crm_saved_at=coalesce($20::date, leads.crm_saved_at), updated_at=now()`,
        [
          l.id, l.company, l.website || "", l.roleType || "", l.jobTitle || "", l.jobUrl || "",
          dateOrNull(l.datePosted), dateOrNull(l.dateAdded) || new Date().toISOString().slice(0, 10),
          l.employmentType || "", l.estSize || "", l.priority || "Medium", l.endClient || "",
          l.companyProfile || "", l.requiredSkills || "", l.nearshoreFit || "", l.status || "Not Started",
          !!l.isNew, JSON.stringify(l.clientInfo || emptyClientInfo()),
          typeof l.inCrm === "boolean" ? l.inCrm : null, dateOrNull(l.crmSavedAt),
        ]
      );

      await client.query("delete from lead_notes where lead_id = $1", [l.id]);
      const notes = Array.isArray(l.notes) ? l.notes : [];
      for (let i = 0; i < notes.length; i++) {
        const k = d10(notes[i].date) + "\u0000" + (notes[i].text || "");
        const author = prevNotes[k] && prevNotes[k].length ? prevNotes[k].shift() : actor;
        await client.query("insert into lead_notes (lead_id, note_date, text, sort_order, author) values ($1,$2,$3,$4,$5)", [
          l.id, dateOrNull(notes[i].date), notes[i].text || "", i, author,
        ]);
      }

      await client.query("delete from activities where lead_id = $1", [l.id]);
      await client.query("delete from contacts where lead_id = $1", [l.id]);
      const contacts = Array.isArray(l.contacts) ? l.contacts : [];
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        await client.query(
          `insert into contacts (id, lead_id, name, title, email, phone, linkedin, roles, sort_order, stage, next_follow_up, last_contacted, sequence_step, is_primary, agent_found, source_url, added_by, email_info, location, owner)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            c.id, l.id, c.name || "", c.title || "", c.email || "", c.phone || "", c.linkedin || "", c.roles || [], i,
            CONTACT_STAGES.includes(c.stage) ? c.stage : "Not contacted",
            dateOrNull(c.nextFollowUp), dateOrNull(c.lastContacted),
            Math.min(5, Math.max(0, parseInt(c.sequenceStep, 10) || 0)), c.isPrimary === true,
            c.agentFound === true, String(c.sourceUrl || "").slice(0, 1000),
            c.id in prevAdded ? prevAdded[c.id] : actor,
            // "Find email" results are written by the server only; the browser's copy never changes them.
            prevEmailInfo[c.id] ? JSON.stringify(prevEmailInfo[c.id]) : null,
            String(c.location || "").trim().slice(0, 120), String(c.owner || "").trim().slice(0, 60),
          ]
        );
        const acts = Array.isArray(c.activities) ? c.activities : [];
        for (let j = 0; j < acts.length; j++) {
          const a = acts[j];
          await client.query(
            "insert into activities (id, lead_id, contact_id, type, direction, activity_date, summary, sort_order, author) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              a.id, l.id, c.id,
              ACTIVITY_TYPES.includes(a.type) ? a.type : "Note",
              ACTIVITY_DIRECTIONS.includes(a.direction) ? a.direction : "Outbound",
              dateOrNull(a.date) || today, a.summary || "", j,
              a.id in prevActs ? prevActs[a.id] : actor,
            ]
          );
        }
      }

      await client.query("delete from documents where lead_id = $1", [l.id]);
      const documents = Array.isArray(l.documents) ? l.documents : [];
      for (let i = 0; i < documents.length; i++) {
        await client.query("insert into documents (id, lead_id, name, sort_order) values ($1,$2,$3,$4)", [
          documents[i].id, l.id, documents[i].name || "", i,
        ]);
      }

      await client.query("delete from candidates where lead_id = $1", [l.id]);
      const candidates = Array.isArray(l.candidates) ? l.candidates : [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        await client.query(
          `insert into candidates (id, lead_id, name, job_title, linkedin, email, phone, country, stage, contractor, sort_order)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            c.id, l.id, c.name || "", c.jobTitle || "", c.linkedin || "", c.email || "", c.phone || "",
            c.country || "", c.stage || "Identified", JSON.stringify(c.contractor || emptyContractor()), i,
          ]
        );
        const cNotes = Array.isArray(c.notes) ? c.notes : [];
        for (let j = 0; j < cNotes.length; j++) {
          await client.query(
            "insert into candidate_notes (candidate_id, note_date, text, sort_order) values ($1,$2,$3,$4)",
            [c.id, dateOrNull(cNotes[j].date), cNotes[j].text || "", j]
          );
        }
        const cDocs = Array.isArray(c.documents) ? c.documents : [];
        for (let j = 0; j < cDocs.length; j++) {
          await client.query(
            "insert into candidate_documents (id, candidate_id, name, sort_order) values ($1,$2,$3,$4)",
            [cDocs[j].id, c.id, cDocs[j].name || "", j]
          );
        }
      }

      for (const e of audit) {
        await client.query("insert into audit_log (lead_id, actor, action, detail) values ($1,$2,$3,$4)", [l.id, actor || "Claude", e.action, e.detail]);
      }
    }

    await client.query("COMMIT");
    return { written, total: leads.length, conflicts };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function leadHistory(pool, leadId, limit = 60) {
  const r = await pool.query("select at, actor, action, detail from audit_log where lead_id = $1 order by at desc, id desc limit $2", [String(leadId), limit]);
  return r.rows.map((x) => ({ at: x.at.toISOString(), actor: x.actor, action: x.action, detail: x.detail }));
}

module.exports = { getState, putState, leadFingerprint, describeChanges, leadHistory };
