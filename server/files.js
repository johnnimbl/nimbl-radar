// Uploaded files (LinkedIn profile PDFs, contracts, screenshots) attached to a lead and,
// optionally, to one of its contacts. The bytes live in Postgres next to the rest of the data,
// in their own table so the lead state sync never reads or rewrites them.
const crypto = require("crypto");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = (Number(process.env.FILES_TOTAL_MAX_MB) || 250) * 1024 * 1024;

// extension -> [content type sent on download, whether the browser may show it in a tab]
const TYPES = {
  pdf: ["application/pdf", true],
  png: ["image/png", true],
  jpg: ["image/jpeg", true],
  jpeg: ["image/jpeg", true],
  webp: ["image/webp", true],
  gif: ["image/gif", true],
  doc: ["application/msword", false],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
  xls: ["application/vnd.ms-excel", false],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false],
  ppt: ["application/vnd.ms-powerpoint", false],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", false],
  txt: ["text/plain; charset=utf-8", false],
  csv: ["text/csv; charset=utf-8", false],
  rtf: ["application/rtf", false],
};

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function cleanName(raw) {
  let name = String(raw || "");
  try { name = decodeURIComponent(name); } catch (e) { /* keep as sent */ }
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop().trim();
  if (name.length > 180) {
    const ext = extOf(name);
    name = name.slice(0, 180 - ext.length - 1) + "." + ext;
  }
  return name;
}

function toMeta(r) {
  return {
    id: r.id,
    leadId: r.lead_id,
    contactId: r.contact_id || "",
    name: r.name,
    ext: extOf(r.name),
    size: r.size,
    uploadedAt: r.uploaded_at.toISOString(),
    uploadedBy: r.uploaded_by || "",
  };
}

const META_COLS = "id, lead_id, contact_id, name, size, uploaded_at, uploaded_by";

async function listFiles(pool) {
  const res = await pool.query(`select ${META_COLS} from files order by uploaded_at, id`);
  return res.rows.map(toMeta);
}

// Returns { file } on success or { status, error } when the upload is refused.
async function saveFile(pool, { leadId, contactId, rawName, body, uploadedBy }) {
  const name = cleanName(rawName);
  const ext = extOf(name);
  if (!name || !TYPES[ext]) {
    return { status: 400, error: "That file type isn't supported. Use a PDF, an image, or a Word, Excel, PowerPoint, text or CSV file." };
  }
  if (!Buffer.isBuffer(body) || body.length === 0) return { status: 400, error: "The file was empty." };
  if (body.length > MAX_FILE_BYTES) return { status: 413, error: "That file is over the 10 MB limit." };
  const cid = /^[A-Za-z0-9_-]{1,60}$/.test(String(contactId || "")) ? String(contactId) : "";

  const lead = await pool.query("select 1 from leads where id = $1", [String(leadId)]);
  if (!lead.rowCount) return { status: 404, error: "That lead no longer exists." };
  const total = await pool.query("select coalesce(sum(size), 0)::bigint as total from files");
  if (Number(total.rows[0].total) + body.length > MAX_TOTAL_BYTES) {
    return { status: 507, error: "File storage is full. Delete some older files first." };
  }

  const id = "f" + crypto.randomBytes(9).toString("hex");
  const res = await pool.query(
    `insert into files (id, lead_id, contact_id, name, mime, size, data, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${META_COLS}`,
    [id, String(leadId), cid, name, TYPES[ext][0], body.length, body, String(uploadedBy || "").slice(0, 200)]
  );
  return { file: toMeta(res.rows[0]) };
}

async function getFile(pool, id) {
  const res = await pool.query("select name, data from files where id = $1", [String(id)]);
  if (!res.rowCount) return null;
  const r = res.rows[0];
  const type = TYPES[extOf(r.name)] || ["application/octet-stream", false];
  return { name: r.name, data: r.data, contentType: type[0], inline: type[1] };
}

async function deleteFile(pool, id) {
  await pool.query("delete from files where id = $1", [String(id)]);
}

module.exports = { listFiles, saveFile, getFile, deleteFile, MAX_FILE_BYTES };
