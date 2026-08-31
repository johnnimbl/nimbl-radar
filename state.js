// Reads and writes the whole Nimbl Radar state as the single nested JSON
// object the frontend (public/app.js) already works with. This mirrors the
// "one document" model the original Claude Artifact prototype used, just
// backed by real Postgres tables instead of an in-page blob — see the
// schema in db/schema.sql. Every save replaces each lead's child rows
// (notes/contacts/documents/candidates) wholesale; simple and correct for a
// CRM at this scale. If you outgrow that (heavy concurrent editing, a lot
// of leads), split this into per-resource endpoints instead.

function emptyClientInfo() {
  return { address: "", phone: "", taxId: "", currency: "USD" };
}

function emptyContractor() {
  return {
    firstName: "", middleName: "", lastName: "", gender: "", payMethod: "",
    jobTitle: "", paymentRefTemplate: "", mainTask: "", companyName: "",
    companyTaxId: "", companyAddress: "", companyType: "", birthdate: "", startDate: "",
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
  const docsRes = leadIds.length
    ? await pool.query("select * from documents where lead_id = any($1) order by sort_order, id", [leadIds])
    : { rows: [] };
  const candsRes = leadIds.length
    ? await pool.query("select * from candidates where lead_id = any($1) order by sort_order, id", [leadIds])
    : { rows: [] };
  const candIds = candsRes.rows.map((r) => r.id);
  const candNotesRes = candIds.length
    ? await pool.query("select * from candidate_notes where candidate_id = any($1) order by sort_order, id", [candIds])
    : { rows: [] };
  const candDocsRes = candIds.length
    ? await pool.query("select * from candidate_documents where candidate_id = any($1) order by sort_order, id", [candIds])
    : { rows: [] };

  const notesByLead = groupBy(notesRes.rows, "lead_id");
  const contactsByLead = groupBy(contactsRes.rows, "lead_id");
  const docsByLead = groupBy(docsRes.rows, "lead_id");
  const candsByLead = groupBy(candsRes.rows, "lead_id");
  const candNotesByCand = groupBy(candNotesRes.rows, "candidate_id");
  const candDocsByCand = groupBy(candDocsRes.rows, "candidate_id");

  const leads = leadsRes.rows.map((l) => ({
    id: l.id,
    company: l.company,
    website: l.website || "",
    roleType: l.role_type || "",
    jobTitle: l.job_title || "",
    jobUrl: l.job_url || "",
    datePosted: dateOrEmpty(l.date_posted),
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
    clientInfo: l.client_info || emptyClientInfo(),
    contacts: (contactsByLead[l.id] || []).map((c) => ({
      id: c.id, name: c.name || "", title: c.title || "", email: c.email || "",
      phone: c.phone || "", linkedin: c.linkedin || "", roles: c.roles || [],
    })),
    documents: (docsByLead[l.id] || []).map((d) => ({ id: d.id, name: d.name || "" })),
    candidates: (candsByLead[l.id] || []).map((c) => ({
      id: c.id, name: c.name || "", jobTitle: c.job_title || "", linkedin: c.linkedin || "",
      email: c.email || "", phone: c.phone || "", country: c.country || "", stage: c.stage,
      contractor: c.contractor || emptyContractor(),
      notes: (candNotesByCand[c.id] || []).map((n) => ({ date: dateOrEmpty(n.note_date), text: n.text || "" })),
      documents: (candDocsByCand[c.id] || []).map((d) => ({ id: d.id, name: d.name || "" })),
    })),
    notes: (notesByLead[l.id] || []).map((n) => ({ date: dateOrEmpty(n.note_date), text: n.text || "" })),
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

async function putState(pool, state) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("update meta set last_scanned = $1 where id = 1", [dateOrNull(state.lastScanned)]);

    await client.query("delete from role_types");
    const roleTypes = Array.isArray(state.roleTypes) ? state.roleTypes : [];
    for (let i = 0; i < roleTypes.length; i++) {
      await client.query("insert into role_types (name, sort_order) values ($1, $2)", [roleTypes[i], i]);
    }

    const leads = Array.isArray(state.leads) ? state.leads : [];
    const incomingIds = leads.map((l) => l.id);
    const existing = await client.query("select id from leads");
    for (const row of existing.rows) {
      if (!incomingIds.includes(row.id)) {
        await client.query("delete from leads where id = $1", [row.id]);
      }
    }

    for (const l of leads) {
      await client.query(
        `insert into leads (id, company, website, role_type, job_title, job_url, date_posted, date_added,
           employment_type, est_size, priority, end_client, company_profile, required_skills, nearshore_fit,
           status, is_new, client_info, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
         on conflict (id) do update set
           company=excluded.company, website=excluded.website, role_type=excluded.role_type,
           job_title=excluded.job_title, job_url=excluded.job_url, date_posted=excluded.date_posted,
           date_added=excluded.date_added, employment_type=excluded.employment_type, est_size=excluded.est_size,
           priority=excluded.priority, end_client=excluded.end_client, company_profile=excluded.company_profile,
           required_skills=excluded.required_skills, nearshore_fit=excluded.nearshore_fit, status=excluded.status,
           is_new=excluded.is_new, client_info=excluded.client_info, updated_at=now()`,
        [
          l.id, l.company, l.website || "", l.roleType || "", l.jobTitle || "", l.jobUrl || "",
          dateOrNull(l.datePosted), dateOrNull(l.dateAdded) || new Date().toISOString().slice(0, 10),
          l.employmentType || "", l.estSize || "", l.priority || "Medium", l.endClient || "",
          l.companyProfile || "", l.requiredSkills || "", l.nearshoreFit || "", l.status || "Not Started",
          !!l.isNew, JSON.stringify(l.clientInfo || emptyClientInfo()),
        ]
      );

      await client.query("delete from lead_notes where lead_id = $1", [l.id]);
      const notes = Array.isArray(l.notes) ? l.notes : [];
      for (let i = 0; i < notes.length; i++) {
        await client.query("insert into lead_notes (lead_id, note_date, text, sort_order) values ($1,$2,$3,$4)", [
          l.id, dateOrNull(notes[i].date), notes[i].text || "", i,
        ]);
      }

      await client.query("delete from contacts where lead_id = $1", [l.id]);
      const contacts = Array.isArray(l.contacts) ? l.contacts : [];
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        await client.query(
          "insert into contacts (id, lead_id, name, title, email, phone, linkedin, roles, sort_order) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [c.id, l.id, c.name || "", c.title || "", c.email || "", c.phone || "", c.linkedin || "", c.roles || [], i]
        );
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
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getState, putState };
