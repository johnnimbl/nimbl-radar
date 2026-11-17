const $ = (id) => document.getElementById(id);
let chosen = null, sourceUrl = "", radarUrl = "";
const api = (method, path, body) => chrome.runtime.sendMessage({ type: "api", method, path, body });
function show(text, ok) { const o = $("out"); o.className = "msg " + (ok ? "ok" : "err"); o.textContent = text; }

function renderLeads(items) {
  const box = $("leads");
  box.textContent = "";
  if (!items.length) { const p = document.createElement("p"); p.className = "help"; p.textContent = "No company found. Add it in Radar first."; box.appendChild(p); return; }
  items.forEach((l) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pick"; b.setAttribute("role", "option");
    b.setAttribute("aria-selected", chosen && chosen.id === l.id ? "true" : "false");
    if (chosen && chosen.id === l.id) b.style.background = "var(--yellow)";
    b.textContent = l.company + " ";
    const s = document.createElement("small"); s.textContent = (l.inCrm ? "CRM · " : "") + l.status; b.appendChild(s);
    b.addEventListener("click", () => { chosen = l; $("save").disabled = false; renderLeads(items); });
    box.appendChild(b);
  });
}

let timer = null, lastItems = [];
async function search() {
  const r = await api("GET", "/leads?q=" + encodeURIComponent($("q").value.trim()));
  if (!r || !r.ok) { show((r && r.error) || "Couldn't reach Radar.", false); return; }
  radarUrl = r.radarUrl; lastItems = r.data.items; renderLeads(lastItems);
}
$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });

chrome.storage.session.get("capture").then(({ capture }) => {
  capture = capture || {};
  $("text").value = capture.text || "";
  sourceUrl = capture.url || "";
  $("src").textContent = sourceUrl ? "From " + (capture.title ? capture.title + " · " : "") + sourceUrl : "";
  // A good first guess: a job board page title often names the company.
  search();
});

$("save").addEventListener("click", async () => {
  if (!chosen) return;
  const text = $("text").value.trim();
  if (!text) { show("There's no text to save.", false); return; }
  const kind = document.querySelector('input[name="kind"]:checked').value;
  $("save").disabled = true;
  const r = kind === "jd"
    ? await api("POST", "/job-descriptions", { leadId: chosen.id, sourceUrl, sourceText: text })
    : await api("POST", "/notes", { leadId: chosen.id, text, sourceUrl });
  $("save").disabled = false;
  if (r && r.ok) {
    show(kind === "jd" ? "Saved to " + chosen.company + " as a job posting. Ask Claude to write it up." : "Note saved to " + chosen.company + ".", true);
    await chrome.storage.session.remove("capture");
    setTimeout(() => window.close(), 1600);
  } else show((r && r.error) || "Couldn't save.", false);
});
$("cancel").addEventListener("click", () => window.close());
