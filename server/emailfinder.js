// "Find email" for a contact. Free route, in order:
//  1. The company's own website: if this person's address is published there, that's the answer.
//  2. Hunter's Email Finder (free plan: 50 searches a month), which returns an address it has seen
//     published somewhere, or its best guess from the company's email format, with a confidence score.
//  3. Nothing confirmed: Radar's own best guesses from common formats, clearly labelled as unverified.
// Nothing here sends an email or contacts the person.
const dns = require("dns").promises;

const HUNTER_BASE = process.env.HUNTER_API_BASE || "https://api.hunter.io/v2";
const PAGES = ["", "/about", "/about-us", "/team", "/our-team", "/leadership", "/contact", "/contact-us", "/company"];
const UA = "Mozilla/5.0 (compatible; NimblRadar/1.0; +https://nimbl.ai)";

function domainOf(website) {
  let s = String(website || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[\/?#:]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : "";
}

function ascii(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// "María García-López, PMP" -> { first: "María", last: "García-López" }. Initials-only surnames
// ("Michelle B.") can't be searched, so they come back with initialOnly = true.
function splitName(full) {
  let s = String(full || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{M}\s.'-]/gu, " ")
    .replace(/,.*$/, " ");
  const drop = /^(mr|mrs|ms|dr|jr|sr|ii|iii|iv|pmp|mba|phd|csm|cspo)\.?$/i;
  const parts = s.split(/\s+/).filter(Boolean).filter((p) => !drop.test(p));
  if (parts.length < 2) return { first: parts[0] || "", last: "", initialOnly: false };
  const first = parts[0];
  const last = parts[parts.length - 1];
  return { first, last, initialOnly: /^\p{L}\.?$/u.test(last) };
}

// Common work-email formats, most common first. Compound surnames get both the joined and
// first-part versions (García-López -> garcialopez and garcia).
function guesses(first, last, domain) {
  const f = ascii(first).replace(/[^a-z]/g, "");
  const lastParts = ascii(last).split(/[-\s']+/).filter(Boolean);
  if (!f || !lastParts.length) return [];
  const lasts = [...new Set([lastParts.join(""), lastParts[0]])];
  const out = [];
  for (const l of lasts) out.push(`${f}.${l}`, `${f}`, `${f[0]}${l}`, `${f}${l}`, `${f}${l[0]}`, `${f[0]}.${l}`, `${f}_${l}`);
  return [...new Set(out)].slice(0, 10).map((x) => `${x}@${domain}`);
}

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: ctrl.signal });
    if (!r.ok) return "";
    const type = r.headers.get("content-type") || "";
    if (!/text\/html|text\/plain/.test(type)) return "";
    return (await r.text()).slice(0, 600000);
  } catch (e) { return ""; } finally { clearTimeout(t); }
}

// Addresses on the company's own domain published on its website, and the page each came from.
async function siteEmails(website, domain) {
  const base = /^https?:\/\//i.test(website) ? website.replace(/\/+$/, "") : "https://" + domain;
  const origin = base.match(/^https?:\/\/[^\/]+/i)[0];
  const found = new Map();
  const pages = await Promise.all(PAGES.map((p) => fetchText(origin + p, 6000).then((html) => ({ url: origin + p, html }))));
  const re = new RegExp("[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.)*" + domain.replace(/\./g, "\\.") + "\\b", "gi");
  for (const { url, html } of pages) {
    if (!html) continue;
    const text = html.replace(/&#64;|&#x40;|\[at\]|\(at\)/gi, "@");
    for (const m of text.match(re) || []) {
      const e = m.toLowerCase();
      if (!found.has(e)) found.set(e, url || origin);
    }
  }
  return found;
}

function matchesPerson(email, first, last) {
  const local = ascii(email.split("@")[0]).replace(/[^a-z]/g, "");
  const f = ascii(first).replace(/[^a-z]/g, "");
  const parts = ascii(last).split(/[-\s']+/).map((p) => p.replace(/[^a-z]/g, "")).filter(Boolean);
  if (!f || !parts.length || local.length < 3) return false;
  // Full first and last name in the address, or initial + surname (jsmith, smithj).
  return parts.some((l) => (local.includes(f) && local.includes(l)) || local === f[0] + l || local === l + f[0]);
}

async function hasMail(domain) {
  try { return (await dns.resolveMx(domain)).length > 0; } catch (e) { return false; }
}

async function hunterFind(domain, first, last, key) {
  const qs = new URLSearchParams({ domain, first_name: first, last_name: last, api_key: key });
  const r = await fetch(`${HUNTER_BASE}/email-finder?${qs}`, { headers: { accept: "application/json" } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Hunter didn't accept the API key. Check HUNTER_API_KEY in Render."), { status: 502 });
  if (r.status === 429) throw Object.assign(new Error("Hunter's free searches for this month are used up."), { status: 429 });
  if (!r.ok) {
    const msg = (body.errors && body.errors[0] && (body.errors[0].details || body.errors[0].id)) || ("HTTP " + r.status);
    throw Object.assign(new Error("Hunter: " + msg), { status: 502 });
  }
  return body.data || {};
}

async function hunterLeft(key) {
  try {
    const r = await fetch(`${HUNTER_BASE}/account?api_key=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } });
    const d = (await r.json()).data || {};
    const s = d.requests && d.requests.searches;
    return s && typeof s.available === "number" ? Math.max(0, s.available - (s.used || 0)) : null;
  } catch (e) { return null; }
}

// Returns the result and, when an address was found, writes it to the contact (only if the
// contact has no email yet). The full result always goes into contacts.email_info.
async function findEmail(pool, contactId, opts) {
  const o = opts || {};
  const res = await pool.query(
    `select c.id, c.lead_id, c.name, c.email, c.email_info, l.website, l.company from contacts c join leads l on l.id = c.lead_id where c.id = $1`,
    [String(contactId)]);
  const c = res.rows[0];
  if (!c) throw Object.assign(new Error("Contact not found."), { status: 404 });
  const domain = domainOf(o.domain || c.website);
  if (!domain) throw Object.assign(new Error(`Add ${c.company}'s website to the company first; the email is built from its domain.`), { status: 400 });
  const { first, last, initialOnly } = splitName(c.name);
  if (!first || !last || initialOnly) {
    throw Object.assign(new Error(`Radar needs ${c.name || "the person"}'s full surname to search. Update the name on the contact (e.g. from their LinkedIn profile) and try again.`), { status: 400 });
  }

  const info = { email: "", status: "not_found", source: "", sourceUrl: "", score: null, domain, guesses: [], checkedAt: new Date().toISOString(), hunterLeft: null, notes: [] };
  const key = process.env.HUNTER_API_KEY || "";

  if (!(await hasMail(domain))) info.notes.push(`${domain} has no mail server listed, so the domain may be wrong.`);

  // 1. Published on the company's own website.
  const onSite = await siteEmails(c.website || domain, domain);
  for (const [e, url] of onSite) {
    if (matchesPerson(e, first, last)) {
      Object.assign(info, { email: e, status: "published", source: "Company website", sourceUrl: url });
      break;
    }
  }

  // 2. Hunter.
  if (!info.email) {
    if (!key) info.notes.push("Hunter isn't connected yet (no HUNTER_API_KEY), so only the company website was checked.");
    else {
      const h = await hunterFind(domain, first, last, key);
      info.hunterLeft = await hunterLeft(key);
      if (h.email) {
        const v = (h.verification && h.verification.status) || "";
        const seen = Array.isArray(h.sources) ? h.sources.filter((s) => s && s.uri) : [];
        info.email = String(h.email).toLowerCase();
        info.score = typeof h.score === "number" ? h.score : null;
        info.source = seen.length ? `Hunter (seen on ${seen.length} public page${seen.length === 1 ? "" : "s"})` : "Hunter (from the company's email format)";
        info.sourceUrl = seen.length ? seen[0].uri : "";
        info.status = v === "valid" ? "verified"
          : seen.length ? "published"
          : (v === "accept_all" || (info.score || 0) >= 70) ? "likely" : "guess";
        if (v === "accept_all") info.notes.push("The company's mail server accepts every address, so it can't be confirmed for certain.");
      }
    }
  }

  // 3. Radar's own guesses, never written to the contact.
  if (!info.email) info.guesses = guesses(first, last, domain).slice(0, 6);
  // Shared inboxes (info@, hello@...) are a fallback worth knowing; other people's addresses aren't shown.
  const shared = [...onSite.keys()].filter((e) => e !== info.email && /^(info|hello|contact|sales|team|office|hi|inquiries|enquiries|partners|partnerships|careers|jobs|hr|recruiting|talent)@/.test(e)).slice(0, 4);
  if (shared.length) info.notes.push("Shared inbox on their website: " + shared.join(", "));

  // An unverified guess is shown, never saved on its own: John chooses whether to use it.
  const setEmail = info.email && info.status !== "guess" && (!c.email || o.replace === true);
  await pool.query(
    setEmail ? "update contacts set email = $2, email_info = $3 where id = $1" : "update contacts set email_info = $2 where id = $1",
    setEmail ? [c.id, info.email, JSON.stringify(info)] : [c.id, JSON.stringify(info)]);
  // A new email changes the lead, so an open tab with the old copy can't save over it.
  if (setEmail) await pool.query("update leads set updated_at = now() where id = $1", [c.lead_id]);
  return { contactId: c.id, emailSet: !!setEmail, email: setEmail ? info.email : c.email || "", info };
}

module.exports = { findEmail, splitName, guesses, domainOf, matchesPerson };
