// Toolbar popup: Home (or your profile) on any site.
let radarUrl = "https://nimbl-radar-app.onrender.com";
let view = "home";            // "home" or "profile"
let scope = "team";
let me = null;
const box = document.getElementById("home");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = (method, path) => chrome.runtime.sendMessage({ type: "api", method, path });

function signedOut(msg) {
  me = null; drawChip();
  box.innerHTML = (msg ? '<p class="msg err">' + esc(msg) + "</p>" : "") +
    '<div class="card"><p><strong>Sign in to connect the extension to your Radar account.</strong></p>' +
    '<p class="help">Use your Nimbl Google account, the same as Radar.</p>' +
    '<div class="row"><button class="btn btn-primary" type="button" data-act="signin">Sign in with Google</button></div></div>';
}
function drawChip() {
  const el = document.getElementById("chip");
  el.innerHTML = me ? window.RadarHome.chip(me, {}, view === "profile") : "";
  window.RadarHome.fixAvatars(el);
  document.getElementById("title").textContent = view === "profile" ? "Profile" : "Home";
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: "settings" });
  radarUrl = s.radarUrl;
  if (!s.hasKey) { signedOut(); return; }
  box.innerHTML = '<p class="help">Loading…</p>';
  const [m, r] = await Promise.all([api("GET", "/me"), view === "profile" ? api("GET", "/profile") : api("GET", "/home?scope=" + scope)]);
  if (m && m.ok) me = m.data;
  drawChip();
  if (!r || !r.ok) { if (r && r.needsKey) signedOut(r.error); else box.innerHTML = '<p class="msg err">' + esc((r && r.error) || "Couldn't reach Radar.") + "</p>"; return; }
  box.innerHTML = view === "profile"
    ? window.RadarHome.renderProfile(r.data, { radarUrl: r.radarUrl })
    : window.RadarHome.render(r.data, { radarUrl: r.radarUrl, popup: true });
  window.RadarHome.fixAvatars(box);
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.getAttribute("data-act");
  if (act === "profile") { view = view === "profile" ? "home" : "profile"; load(); return; }
  if (act === "signin") { chrome.runtime.sendMessage({ type: "signIn" }); window.close(); return; }
  if (act === "signout") {
    if (!confirm("Sign this browser out of Radar? You can sign in again any time.")) return;
    await chrome.runtime.sendMessage({ type: "signOut" });
    view = "home"; signedOut();
    return;
  }
  if (act === "key-revoke") {
    const r = await chrome.runtime.sendMessage({ type: "api", method: "DELETE", path: "/keys/" + encodeURIComponent(b.getAttribute("data-id")) });
    if (!r || !r.ok) alert((r && r.error) || "Couldn't disconnect it.");
    load();
  }
});
load();
document.getElementById("reload").addEventListener("click", load);
document.getElementById("open").addEventListener("click", () => { chrome.tabs.create({ url: radarUrl + "/" }); window.close(); });
document.getElementById("settings").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
