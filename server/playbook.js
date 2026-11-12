// Playbook items: research notes, objection cheat sheet and message templates.
// Kept apart from the lead state so editing a note never touches (or races with) lead saves.
const KINDS = ["note", "objection", "template"];

function clean(item) {
  const id = String(item.id || "");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  if (!KINDS.includes(item.kind)) return null;
  return {
    id,
    kind: item.kind,
    title: String(item.title || "").slice(0, 300),
    body: String(item.body || "").slice(0, 20000),
    tag: String(item.tag || "").slice(0, 60),
  };
}

async function listPlaybook(pool) {
  const res = await pool.query("select id, kind, title, body, tag, created_at from playbook_items order by created_at, id");
  return res.rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, tag: r.tag, createdAt: r.created_at.toISOString() }));
}

async function upsertPlaybookItem(pool, item) {
  const c = clean(item);
  if (!c) return false;
  await pool.query(
    `insert into playbook_items (id, kind, title, body, tag) values ($1,$2,$3,$4,$5)
     on conflict (id) do update set title = excluded.title, body = excluded.body, tag = excluded.tag, updated_at = now()`,
    [c.id, c.kind, c.title, c.body, c.tag]
  );
  return true;
}

async function deletePlaybookItem(pool, id) {
  await pool.query("delete from playbook_items where id = $1", [String(id)]);
}

module.exports = { listPlaybook, upsertPlaybookItem, deletePlaybookItem };
