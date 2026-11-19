// Nimbl Radar extension: talks to Radar on behalf of the LinkedIn panel, the popup and the
// "Add to Radar" page. The Radar key never leaves chrome.storage and this worker.
const DEFAULT_URL = "https://nimbl-radar-app.onrender.com";

async function settings() {
  const s = await chrome.storage.sync.get({ radarUrl: DEFAULT_URL, key: "" });
  s.radarUrl = String(s.radarUrl || DEFAULT_URL).replace(/\/+$/, "");
  return s;
}

async function api(method, path, body) {
  const s = await settings();
  if (!s.key) return { ok: false, needsKey: true, error: "Add your Radar key in the extension settings." };
  let res;
  try {
    res = await fetch(s.radarUrl + "/api/ext" + path, {
      method,
      headers: Object.assign({ Authorization: "Bearer " + s.key }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: "Can't reach Radar. If it has been idle it may take up to a minute to wake up, then try again." };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) return { ok: false, status: res.status, needsKey: res.status === 401, error: (data && data.error) || ("Radar answered " + res.status) };
  return { ok: true, data, radarUrl: s.radarUrl };
}

// Fetch a job description PDF with the Radar key and save it through Chrome's downloads.
async function downloadJd(id, title) {
  const s = await settings();
  if (!s.key) return { ok: false, error: "Add your Radar key in the extension settings." };
  let res;
  try { res = await fetch(s.radarUrl + "/api/ext/job-descriptions/" + encodeURIComponent(id) + "/pdf", { headers: { Authorization: "Bearer " + s.key } }); }
  catch (e) { return { ok: false, error: "Can't reach Radar. Try again in a moment." }; }
  if (!res.ok) return { ok: false, error: "Radar couldn't build the PDF (" + res.status + ")." };
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const name = ("Nimbl.ai - " + String(title || "Job description")).replace(/[\\/:*?"<>|]+/g, " ").trim() + ".pdf";
  await chrome.downloads.download({ url: "data:application/pdf;base64," + btoa(bin), filename: name, saveAs: false });
  return { ok: true };
}

// "Sign in with Google": open Radar's connect page; after the person signs in and clicks Connect,
// the page sends the new key back here (see onMessageExternal below).
async function startSignIn() {
  const s = await settings();
  await chrome.tabs.create({ url: s.radarUrl + "/ext/connect?ext=" + chrome.runtime.id });
  return { ok: true };
}

// Sign out: revoke this browser's key in Radar, then forget it here.
async function signOut() {
  const r = await api("DELETE", "/key");
  await chrome.storage.sync.set({ key: "" });
  await chrome.storage.local.remove(["me", "photo"]);
  return { ok: true, revoked: !!(r && r.ok) };
}

const RADAR_ORIGINS = ["https://nimbl-radar-app.onrender.com", "https://radar.nimbl.ai"];
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  (async () => {
    if (!msg || msg.type !== "radar-connect") return reply({ ok: false, error: "unknown message" });
    const s = await settings();
    const origin = sender.origin || (sender.url ? new URL(sender.url).origin : "");
    if (!RADAR_ORIGINS.includes(origin) && origin !== s.radarUrl) return reply({ ok: false, error: "not from Radar" });
    const key = String(msg.key || "");
    if (!/^rk_[A-Za-z0-9_-]{20,}$/.test(key)) return reply({ ok: false, error: "bad key" });
    const old = s.key;
    await chrome.storage.sync.set({ radarUrl: origin, key });
    await chrome.storage.local.remove(["me", "photo"]);
    // The old key from this browser is no longer needed: revoke it (best effort).
    if (old && old !== key) {
      fetch(origin + "/api/ext/key", { method: "DELETE", headers: { Authorization: "Bearer " + old } }).catch(() => {});
    }
    reply({ ok: true });
  })();
  return true;
});

// The signed-in person's Google photo as a data: URL (cached for a day per account), or "".
async function photo(email) {
  const c = (await chrome.storage.local.get({ photo: null })).photo;
  if (c && c.email === email && Date.now() - c.at < 86400000) return c.data;
  const s = await settings();
  if (!s.key) return "";
  let data = "";
  try {
    const res = await fetch(s.radarUrl + "/api/ext/photo", { headers: { Authorization: "Bearer " + s.key } });
    const type = res.headers.get("content-type") || "";
    if (res.ok && /^image\//.test(type)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      data = "data:" + type.split(";")[0] + ";base64," + btoa(bin);
    }
  } catch (e) { /* offline: initials */ }
  await chrome.storage.local.set({ photo: { email, data, at: Date.now() } });
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "photo") { photo(String(msg.email || "")).then(reply); return true; }
  if (msg && msg.type === "signIn") { startSignIn().then(reply); return true; }
  if (msg && msg.type === "signOut") { signOut().then(reply); return true; }
  if (msg && msg.type === "api") { api(msg.method || "GET", msg.path, msg.body).then(reply); return true; }
  if (msg && msg.type === "settings") { settings().then((s) => reply({ radarUrl: s.radarUrl, hasKey: !!s.key })); return true; }
  if (msg && msg.type === "downloadJd") { downloadJd(msg.id, msg.title).then(reply); return true; }
  if (msg && msg.type === "openOptions") { chrome.runtime.openOptionsPage(); reply({ ok: true }); return false; }
  if (msg && msg.type === "openTab") { chrome.tabs.create({ url: msg.url }); reply({ ok: true }); return false; }
  return false;
});

// Right-click selected text anywhere -> "Add to Radar…" (note or job description posting).
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: "radar-add", title: "Add to Radar…", contexts: ["selection"] });
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "radar-add") return;
  // selectionText loses line breaks, so read the selection from the page when we can.
  let text = info.selectionText || "";
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId || 0] }, func: () => String(window.getSelection() || "") });
    if (r && r.result && r.result.trim()) text = r.result;
  } catch (e) { /* some pages can't be scripted; keep selectionText */ }
  await chrome.storage.session.set({ capture: { text, url: (tab && tab.url) || info.pageUrl || "", title: (tab && tab.title) || "" } });
  chrome.windows.create({ url: chrome.runtime.getURL("capture.html"), type: "popup", width: 440, height: 620 });
});
