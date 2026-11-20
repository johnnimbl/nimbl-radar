// Job descriptions: a posting John saves (link and/or pasted text, status 'waiting'), which Claude
// rewrites into the Nimbl layout (status 'ready'), and which the app turns into a letterhead PDF.
const TEXT_KEYS = ["title", "practice", "location", "type", "level", "about", "language", "apply"];
const LIST_KEYS = ["responsibilities", "requirements", "niceToHave"];

function str(v, max) { return String(v == null ? "" : v).slice(0, max); }

function cleanContent(c) {
  c = c && typeof c === "object" ? c : {};
  const out = {};
  TEXT_KEYS.forEach((k) => { out[k] = str(c[k], k === "about" || k === "apply" ? 4000 : 300).trim(); });
  LIST_KEYS.forEach((k) => {
    const v = Array.isArray(c[k]) ? c[k] : String(c[k] || "").split("\n");
    out[k] = v.map((s) => str(s, 600).trim()).filter(Boolean).slice(0, 30);
  });
  return out;
}

function toJson(r) {
  return {
    id: r.id, leadId: r.lead_id, roleAlertId: r.role_alert_id || "", status: r.status, sourceUrl: r.source_url, sourceText: r.source_text,
    content: cleanContent(r.content), showClient: r.show_client, clientLabel: r.client_label,
    contactEmail: r.contact_email, contactPhone: r.contact_phone, createdBy: r.created_by || "",
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

async function listJds(pool) {
  const res = await pool.query("select * from job_descriptions order by created_at, id");
  return res.rows.map(toJson);
}

async function getJd(pool, id) {
  const res = await pool.query(
    "select j.*, l.company from job_descriptions j join leads l on l.id = j.lead_id where j.id = $1", [String(id)]);
  if (!res.rows.length) return null;
  return Object.assign(toJson(res.rows[0]), { company: res.rows[0].company });
}

// body.roleAlertId names the role it's for: "" is the role the company was saved with. Without it
// (the Chrome extension, older clients) the posting link decides: a link matching a role found since goes there.
async function createJd(pool, leadId, body, defaults) {
  const url = str(body.sourceUrl, 1000).trim();
  let roleAlertId = null;
  if (body.roleAlertId) {
    const r = await pool.query("select id from role_alerts where id = $1 and lead_id = $2", [String(body.roleAlertId), String(leadId)]);
    roleAlertId = r.rows.length ? r.rows[0].id : null;
  } else if (!("roleAlertId" in body) && url) {
    const r = await pool.query("select id from role_alerts where lead_id = $1 and job_url = $2 order by found_at desc limit 1", [String(leadId), url]);
    roleAlertId = r.rows.length ? r.rows[0].id : null;
  }
  const res = await pool.query(
    `insert into job_descriptions (lead_id, role_alert_id, source_url, source_text, contact_email, contact_phone)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [String(leadId), roleAlertId, url, str(body.sourceText, 60000),
      str(body.contactEmail || defaults.email, 200).trim(), str(body.contactPhone, 60).trim()]
  );
  return toJson(res.rows[0]);
}

async function updateJd(pool, id, body) {
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if ("sourceUrl" in body) add("source_url", str(body.sourceUrl, 1000).trim());
  if ("sourceText" in body) add("source_text", str(body.sourceText, 60000));
  if ("content" in body) add("content", JSON.stringify(cleanContent(body.content)));
  if ("status" in body && ["waiting", "ready"].includes(body.status)) add("status", body.status);
  if ("showClient" in body) add("show_client", body.showClient === true);
  if ("clientLabel" in body) add("client_label", str(body.clientLabel, 120).trim());
  if ("contactEmail" in body) add("contact_email", str(body.contactEmail, 200).trim());
  if ("contactPhone" in body) add("contact_phone", str(body.contactPhone, 60).trim());
  if (!sets.length) return getJd(pool, id);
  vals.push(String(id));
  await pool.query(`update job_descriptions set ${sets.join(", ")}, updated_at = now() where id = $${vals.length}`, vals);
  return getJd(pool, id);
}

async function deleteJd(pool, id) {
  await pool.query("delete from job_descriptions where id = $1", [String(id)]);
}

module.exports = { listJds, getJd, createJd, updateJd, deleteJd, cleanContent };
