// A company's roles: the one it was saved with (columns on leads) and the ones found since (role_alerts).
// Roles close; a role found since can become the main one, and the old main role is then kept as a
// closed-or-open role found since, so nothing about it is lost (job descriptions follow their role).
const httpError = (status, message) => Object.assign(new Error(message), { status });

// alertId "" is the main role.
async function setRoleClosed(pool, leadId, alertId, closed) {
  const when = closed ? new Date().toISOString().slice(0, 10) : null;
  const r = alertId
    ? await pool.query("update role_alerts set closed_at = $1, seen_at = coalesce(seen_at, now()) where id = $2 and lead_id = $3", [when, String(alertId), String(leadId)])
    : await pool.query("update leads set job_closed_at = $1 where id = $2", [when, String(leadId)]);
  if (!r.rowCount) throw httpError(404, "Role not found.");
  return { closedAt: when || "" };
}

async function promoteRole(pool, leadId, alertId) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const l = (await c.query("select * from leads where id = $1 for update", [String(leadId)])).rows[0];
    const a = (await c.query("select * from role_alerts where id = $1 and lead_id = $2 and promoted_at is null for update",
      [String(alertId), String(leadId)])).rows[0];
    if (!l || !a) throw httpError(404, "Role not found.");
    const today = new Date().toISOString().slice(0, 10);
    if (l.job_title || l.job_url) {
      const archiveId = "was-main-" + l.id + "-" + Date.now();
      const note = ["Was the main role until " + today, l.employment_type].filter(Boolean).join(". ");
      await c.query(
        `insert into role_alerts (id, lead_id, role_type, job_title, job_url, date_posted, note, found_at, seen_at, closed_at)
         values ($1, $2, $3, $4, $5, $6, $7, (coalesce($8::date, $9::date) + interval '12 hours'), now(), $10)`,
        [archiveId, l.id, l.role_type || "", l.job_title || "", l.job_url || "", l.date_posted, note,
          l.date_added, l.created_at, l.job_closed_at]);
      await c.query("update job_descriptions set role_alert_id = $1 where lead_id = $2 and role_alert_id is null", [archiveId, l.id]);
    }
    await c.query("update job_descriptions set role_alert_id = null where role_alert_id = $1", [a.id]);
    // The saved role's employment type and skills described the old role; the found role's note describes this one.
    await c.query(
      `update leads set role_type = coalesce(nullif($2, ''), role_type), job_title = $3, job_url = $4, date_posted = $5,
         employment_type = '', required_skills = $6, job_closed_at = $7, updated_at = now() where id = $1`,
      [l.id, a.role_type || "", a.job_title || "", a.job_url || "", a.date_posted, a.note || "", a.closed_at]);
    await c.query("update role_alerts set promoted_at = now(), seen_at = coalesce(seen_at, now()) where id = $1", [a.id]);
    await c.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { c.release(); }
}

module.exports = { setRoleClosed, promoteRole };
