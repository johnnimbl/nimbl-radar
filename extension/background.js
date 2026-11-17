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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "api") { api(msg.method || "GET", msg.path, msg.body).then(reply); return true; }
  if (msg && msg.type === "settings") { settings().then((s) => reply({ radarUrl: s.radarUrl, hasKey: !!s.key })); return true; }
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
