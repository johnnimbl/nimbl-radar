// Fills in each company's LinkedIn page (leads.client_info.linkedin) by reading the link most
// companies put in their website's header or footer. Runs in the background while the server is up;
// the LinkedIn extension and the morning scan fill in the ones a website doesn't link to.
const UA = "Mozilla/5.0 (compatible; NimblRadar/1.0; +https://nimbl.ai)";
const RECHECK_DAYS = 14;

async function fetchHtml(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, redirect: "follow", signal: ctrl.signal });
    if (!r.ok || !/text\/html/.test(r.headers.get("content-type") || "")) return "";
    return (await r.text()).slice(0, 800000);
  } catch (e) { return ""; } finally { clearTimeout(t); }
}

// Website builders, job boards and HR tools whose own LinkedIn link sits in many sites' footers.
const NOT_THE_COMPANY = /^(wix-com|wix|squarespace|wordpress|webflow|godaddy|hubspot|built-in|builtin|rippling|greenhouse|lever|workable|breezy-hr|breezyhr|bamboohr|indeed|glassdoor|ziprecruiter|teamtailor|recruitee|jobvite|smartrecruiters|workday|gusto|paylocity|adp|linkedin)$/;

// Does the slug look like it belongs to this company? Numeric ids can't be checked, so they pass.
function slugFits(slug, company, website) {
  if (/^\d+$/.test(slug)) return true;
  const flat = slug.replace(/[^a-z0-9]/g, "");
  const host = (originOf(website).replace(/^https?:\/\/(www\.)?/, "").split(".")[0] || "").toLowerCase();
  const words = String(company || "").toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^(inc|llc|ltd|the|and|group|consulting|solutions|technology|technologies)$/.test(w));
  if (host && host.length >= 3 && (flat.includes(host.replace(/[^a-z0-9]/g, "")) || host.replace(/[^a-z0-9]/g, "").includes(flat))) return true;
  return words.some((w) => flat.includes(w));
}

// "https://www.linkedin.com/company/cabin-consulting/" from any linkedin.com/company/<slug> links on
// the page; the slug linked most often wins (a footer link usually appears more than once).
// Links to website builders or job boards, or that don't look like this company, are skipped.
function companyLinkFrom(html, company, website) {
  const counts = {};
  const re = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9%_.-]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const slug = decodeURIComponent(m[1]).replace(/\.+$/, "").toLowerCase();
    if (!slug || /^(login|signup|jobs)$/.test(slug) || NOT_THE_COMPANY.test(slug)) continue;
    if (company !== undefined && !slugFits(slug, company, website)) continue;
    counts[slug] = (counts[slug] || 0) + 1;
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return best ? "https://www.linkedin.com/company/" + best + "/" : "";
}

function originOf(website) {
  const s = String(website || "").trim();
  if (!s) return "";
  try { return new URL(/^https?:\/\//i.test(s) ? s : "https://" + s).origin; } catch (e) { return ""; }
}

async function findForWebsite(website, company) {
  const origin = originOf(website);
  if (!origin) return "";
  for (const p of ["", "/about", "/about-us", "/contact", "/contact-us"]) {
    const link = companyLinkFrom(await fetchHtml(origin + p), company || "", website);
    if (link) return link;
  }
  return "";
}

// Saves a company LinkedIn link found elsewhere (e.g. by the extension), only if none is set yet.
// Bumps updated_at so an open tab with an older copy can't save over it.
async function saveIfMissing(pool, leadId, url, source) {
  const r = await pool.query(
    `update leads set client_info = coalesce(client_info, '{}'::jsonb) || jsonb_build_object('linkedin', $2::text, 'linkedinSource', $3::text), updated_at = now()
      where id = $1 and coalesce(client_info->>'linkedin', '') = '' returning id`, [leadId, url, source]);
  return r.rowCount > 0;
}

async function fillCompanyLinkedins(pool, opts) {
  const limit = (opts && opts.limit) || 25;
  const rows = (await pool.query(
    `select id, company, website from leads
      where status not in ('Lost','Not a Fit') and coalesce(website, '') <> '' and coalesce(client_info->>'linkedin', '') = ''
        and (client_info->>'linkedinLookedAt' is null or (client_info->>'linkedinLookedAt')::date < current_date - ${RECHECK_DAYS})
      order by in_crm desc, date_added desc limit $1`, [limit])).rows;
  let found = 0;
  for (const l of rows) {
    const url = await findForWebsite(l.website, l.company);
    if (url && await saveIfMissing(pool, l.id, url, "company website")) found++;
    else {
      // Remember the look so the same sites aren't fetched every few hours. (No updated_at bump:
      // losing this marker to an older tab only means looking again.)
      await pool.query(`update leads set client_info = coalesce(client_info, '{}'::jsonb) || jsonb_build_object('linkedinLookedAt', current_date::text) where id = $1`, [l.id]);
    }
  }
  return { checked: rows.length, found };
}

const companySlug = (url) => { const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(String(url || "")); return m ? decodeURIComponent(m[1]).toLowerCase() : ""; };

module.exports = { fillCompanyLinkedins, companyLinkFrom, saveIfMissing, companySlug, findForWebsite };
