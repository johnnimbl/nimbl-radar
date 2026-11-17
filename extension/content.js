// Nimbl Radar panel on LinkedIn.
// Reads only the page that is open (a profile or a conversation), shows that person's Radar record,
// fills drafts into LinkedIn's own message boxes and logs touches. It never clicks Send, Connect or
// anything else on LinkedIn, and never visits pages by itself.
(() => {
  if (window.__nimblRadar) return;
  window.__nimblRadar = true;

  const CONN_LIMIT = 200;
  const TOUCH_LABEL = { 1: "Connection note", 2: "First message", 3: "Follow-up", 4: "Value add", 5: "Last note" };

  // ---------- shadow-root panel ----------
  const host = document.createElement("div");
  host.id = "nimbl-radar-host";
  const root = host.attachShadow({ mode: "open" });
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = chrome.runtime.getURL("panel.css");
  const wrap = document.createElement("div");
  wrap.className = "rp";
  root.append(css, wrap);
  (document.body || document.documentElement).appendChild(host);

  const S = {
    open: true, page: null, key: "", loading: false, error: "", needsKey: false, radarUrl: "",
    person: null,          // what we read from the page: {slug, linkedin, name, title, location, company}
    contact: null,         // Radar contact (with lead, drafts, activities)
    companies: [],         // Radar companies matching the page's company
    chosenLead: null, search: "", searchResults: null,
    edits: {},             // draft id -> edited text
    lastInserted: null,    // {contactId, text, touch}
    replyOpen: false, replyText: "", flash: null, busy: false,
  };
  chrome.storage.local.get({ panelOpen: true }).then((v) => { S.open = v.panelOpen; render(); });

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = (method, path, body) => chrome.runtime.sendMessage({ type: "api", method, path, body });
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const slugOf = (href) => { const m = /\/in\/([^/?#]+)/.exec(href || ""); return m ? decodeURIComponent(m[1]).toLowerCase() : ""; };

  // ---------- reading LinkedIn ----------
  function pageType() {
    const p = location.pathname;
    if (/^\/in\/[^/]+/.test(p)) return { type: "profile", slug: slugOf(p) };
    if (/^\/messaging\/thread\//.test(p)) return { type: "messaging", key: p };
    return null;
  }

  function readProfile(slug) {
    const main = document.querySelector("main") || document;
    const h1 = main.querySelector("h1");
    const name = text(h1);
    if (!name) return null;
    const top = (h1 && (h1.closest("section") || h1.parentElement && h1.parentElement.parentElement)) || main;
    const title = text(top.querySelector(".text-body-medium.break-words, .text-body-medium")) || "";
    const location = text(top.querySelector("span.text-body-small.inline.t-black--light.break-words, .pv-text-details__left-panel .text-body-small")) || "";
    let company = "";
    const cur = main.querySelector('button[aria-label^="Current company"], a[aria-label^="Current company"], [aria-label^="Current company"]');
    if (cur) company = (cur.getAttribute("aria-label") || "").replace(/^Current company:?\s*/i, "").replace(/\.\s*Click.*$/i, "").trim();
    if (!company) { const m = /(?:\bat\b|@)\s+([^|,·•]+)/i.exec(title); if (m) company = m[1].trim(); }
    return { slug, linkedin: "https://www.linkedin.com/in/" + slug + "/", name, title, location, company };
  }

  function ownSlug() {
    const me = document.querySelector('.global-nav__me a[href*="/in/"], a.global-nav__me-link[href*="/in/"], .feed-identity-module a[href*="/in/"]');
    return me ? slugOf(me.getAttribute("href")) : "";
  }

  function readConversation() {
    const scope = document.querySelector(".msg-thread, .msg-convo-wrapper, main") || document;
    const mine = ownSlug();
    const links = [...scope.querySelectorAll('a[href*="/in/"]')];
    const counts = {};
    let firstName = "";
    links.forEach((a) => {
      const s = slugOf(a.getAttribute("href"));
      if (!s || s === mine) return;
      counts[s] = (counts[s] || 0) + (a.closest(".msg-entity-lockup, .msg-thread__link-to-profile, header") ? 5 : 1);
    });
    const slug = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "";
    const titleEl = scope.querySelector(".msg-entity-lockup__entity-title, h2.msg-entity-lockup__entity-title, .msg-thread__link-to-profile");
    firstName = text(titleEl);
    if (!slug && !firstName) return null;
    return { slug, linkedin: slug ? "https://www.linkedin.com/in/" + slug + "/" : "", name: firstName, title: "", location: "", company: "" };
  }

  function lastReplyFromThem(otherName) {
    const sel = String(window.getSelection() || "").trim();
    if (sel && !host.contains(document.activeElement)) return sel;
    const msgs = [];
    let sender = "";
    document.querySelectorAll(".msg-s-message-list__event, li.msg-s-message-list__event").forEach((li) => {
      const n = li.querySelector(".msg-s-message-group__name, .msg-s-message-group__profile-link");
      if (n) sender = text(n);
      li.querySelectorAll(".msg-s-event-listitem__body").forEach((b) => {
        msgs.push({ sender, text: (b.innerText || "").trim(), other: !!b.closest(".msg-s-event-listitem--other") });
      });
    });
    const first = (otherName || "").split(" ")[0].toLowerCase();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.other || (first && m.sender.toLowerCase().startsWith(first))) return m.text;
    }
    return "";
  }

  // ---------- writing into LinkedIn's boxes (never sends) ----------
  let lastEditable = null;
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t && t !== host && (t.isContentEditable || t.tagName === "TEXTAREA")) lastEditable = t;
  }, true);

  function findBox() {
    const modal = document.querySelector('.artdeco-modal textarea[name="message"], .artdeco-modal #custom-message, .artdeco-modal textarea');
    const editors = [...document.querySelectorAll('.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]')].reverse();
    return [modal, lastEditable, ...editors].find((el) => el && visible(el)) || null;
  }

  function fillBox(el, value) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand("insertText", false, value); } catch (e) { ok = false; }
    if (!ok || !(el.innerText || "").trim()) {
      el.textContent = "";
      value.split("\n").forEach((line) => {
        const p = document.createElement("p");
        if (line) p.textContent = line; else p.appendChild(document.createElement("br"));
        el.appendChild(p);
      });
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
  }

  async function copy(value) {
    try { await navigator.clipboard.writeText(value); return true; } catch (e) { return false; }
  }

  // ---------- data ----------
  let loadSeq = 0;
  async function refresh() {
    const seq = ++loadSeq;
    const pg = S.page;
    S.contact = null; S.companies = []; S.chosenLead = null; S.searchResults = null; S.search = ""; S.replyOpen = false;
    S.error = ""; S.needsKey = false; S.flash = null; S.person = null;
    if (!pg) { render(); return; }
    S.loading = true; render();
    // LinkedIn renders profiles after load; give it a few seconds.
    let person = null;
    for (let i = 0; i < 20 && !person; i++) {
      person = pg.type === "profile" ? readProfile(pg.slug) : readConversation();
      if (!person) await new Promise((r) => setTimeout(r, 300));
      if (seq !== loadSeq) return;
    }
    S.person = person;
    if (!person) { S.loading = false; render(); return; }
    const q = new URLSearchParams({ linkedin: person.linkedin || "", name: person.name || "", company: person.company || "" });
    const r = await api("GET", "/lookup?" + q.toString());
    if (seq !== loadSeq) return;
    S.loading = false;
    if (!r || !r.ok) { S.error = (r && r.error) || "Couldn't reach Radar."; S.needsKey = !!(r && r.needsKey); render(); return; }
    S.radarUrl = r.radarUrl;
    S.contact = r.data.contact;
    S.companies = r.data.companies || [];
    if (!S.contact && S.companies.length === 1) S.chosenLead = S.companies[0];
    render();
  }

  async function doSearch() {
    const r = await api("GET", "/leads?q=" + encodeURIComponent(S.search));
    if (r && r.ok) { S.searchResults = r.data.items; S.radarUrl = r.radarUrl; render(); }
  }

  function draftText(d) { return S.edits[d.id] != null ? S.edits[d.id] : d.body; }
  function nextTouch(c) { return Math.min(5, (c.step || 0) + 1); }
  function followLabel(iso) {
    if (!iso) return "";
    const days = Math.round((Date.parse(iso + "T00:00:00") - Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00")) / 86400000);
    if (days < 0) return "follow-up overdue " + -days + "d";
    if (days === 0) return "follow-up due today";
    return "next follow-up in " + days + "d";
  }

  // ---------- render ----------
  function render() {
    const pg = S.page;
    host.style.display = pg ? "" : "none";
    if (!pg) { wrap.innerHTML = ""; return; }
    if (!S.open) {
      wrap.innerHTML = '<button type="button" class="tab" data-act="open" aria-label="Open the Nimbl Radar panel">' +
        (S.contact ? '<span class="dot" aria-hidden="true"></span>' : "") + "Radar</button>";
      return;
    }
    let body = "";
    if (S.loading) body = '<p class="muted">Looking this person up in Radar…</p>';
    else if (S.needsKey) body = '<p>Connect the extension to Radar first.</p><div class="row"><button type="button" class="btn btn-primary" data-act="options">Open settings</button></div>';
    else if (S.error) body = '<div class="msg err">' + esc(S.error) + '</div><div class="row"><button type="button" class="btn" data-act="retry">Try again</button></div>';
    else if (!S.person) body = pg.type === "messaging" ? '<p class="muted">Open a conversation to see that person in Radar.</p>' : '<p class="muted">Couldn\'t read this profile.</p><div class="row"><button type="button" class="btn" data-act="retry">Try again</button></div>';
    else if (S.contact) body = renderContact(S.contact);
    else body = renderAdd(S.person);
    if (S.flash) body = '<div class="msg ' + (S.flash.ok ? "ok" : "err") + '" role="status">' + esc(S.flash.text) + "</div>" + body;
    wrap.innerHTML =
      '<section class="panel" aria-label="Nimbl Radar">' +
        '<div class="head"><img src="' + chrome.runtime.getURL("icons/icon32.png") + '" alt=""><strong>Nimbl Radar</strong>' +
          '<button type="button" class="icon-btn" data-act="retry" title="Refresh" aria-label="Refresh">↻</button>' +
          '<button type="button" class="icon-btn" data-act="close" title="Hide panel" aria-label="Hide panel">–</button></div>' +
        '<div class="body">' + body + "</div>" +
      "</section>";
  }

  function renderContact(c) {
    const lead = c.lead || {};
    const radarLink = S.radarUrl ? (lead.inCrm ? S.radarUrl + "/#crm/" + encodeURIComponent(lead.id) : S.radarUrl + "/") : "";
    const stageCls = c.stage === "Replied" || c.stage === "Meeting booked" ? "good" : c.stage === "Not contacted" ? "warn" : "teal";
    let h = '<div class="sec"><div class="row"><span class="name">' + esc(c.name) + '</span><span class="chip ' + stageCls + '">' + esc(c.stage) + "</span></div>" +
      (c.title ? '<div class="sub">' + esc(c.title) + "</div>" : "") +
      '<div class="row sub">' + esc(lead.company || "") + (radarLink ? ' · <a href="' + esc(radarLink) + '" target="_blank" rel="noopener">Open in Radar ↗</a>' : "") + "</div>" +
      '<div class="sub">Touch ' + (c.step || 0) + " of 5" + (c.nextFollowUp ? " · " + esc(followLabel(c.nextFollowUp)) : "") + "</div></div>";
    if (c.agentFound) {
      h += '<div class="warnbox"><strong>Found by the agent.</strong><span>Check that the title on this profile still matches before you reach out.</span>' +
        '<div class="row"><button type="button" class="btn" data-act="checked">Title looks right</button></div></div>';
    }
    const drafts = c.drafts || [];
    h += '<div class="sec"><h3>Drafts</h3>';
    if (!drafts.length) h += '<p class="note">No draft waiting. Ask Claude in chat to draft touch ' + nextTouch(c) + " for " + esc(c.name.split(" ")[0]) + ".</p>";
    drafts.forEach((d) => {
      const t = draftText(d);
      const isConn = d.kind === "message" && d.touch === 1;
      const label = d.kind === "reengage" ? "New role" : "Touch " + d.touch + " · " + (TOUCH_LABEL[d.touch] || "Message");
      h += '<div class="card"><div class="row"><strong>' + esc(label) + "</strong></div>" +
        '<textarea data-draft="' + esc(d.id) + '" aria-label="' + esc(label) + '" rows="' + (isConn ? 4 : 7) + '">' + esc(t) + "</textarea>" +
        (isConn ? '<div class="count' + (t.length > CONN_LIMIT ? " over" : "") + '" data-count="' + esc(d.id) + '">' + t.length + " / " + CONN_LIMIT + "</div>" : "") +
        (d.why ? '<div class="why">' + esc(d.why) + "</div>" : "") +
        '<div class="row"><button type="button" class="btn btn-primary" data-act="insert" data-id="' + esc(d.id) + '">Insert into LinkedIn</button>' +
        '<button type="button" class="btn" data-act="copy" data-id="' + esc(d.id) + '">Copy</button></div></div>';
    });
    h += "</div>";
    h += '<div class="sec"><h3>Log what you did</h3><div class="row">';
    if ((c.step || 0) < 1) h += '<button type="button" class="btn" data-act="log-connection">I sent the connection request</button>';
    h += '<button type="button" class="btn" data-act="log-message">I sent a message' + ((c.step || 0) >= 1 ? " (touch " + Math.max(2, nextTouch(c)) + ")" : "") + "</button>";
    h += '<button type="button" class="btn" data-act="reply-open">They replied…</button></div>';
    if (S.replyOpen) {
      h += '<div class="card"><label for="rp-reply">Their reply (edit if needed)<textarea id="rp-reply" data-reply rows="5">' + esc(S.replyText) + "</textarea></label>" +
        '<div class="row"><button type="button" class="btn btn-primary" data-act="log-reply">Save reply to Radar</button><button type="button" class="btn" data-act="reply-cancel">Cancel</button></div></div>';
    }
    h += '<p class="note">Logging a touch updates the stage and next follow-up in Radar. You always press Send on LinkedIn yourself.</p></div>';
    const acts = c.activities || [];
    if (acts.length) {
      h += '<div class="sec"><h3>Recent</h3><ul class="acts">' + acts.slice(0, 3).map((a) =>
        "<li><div class=\"meta\">" + esc(a.date) + " · " + esc(a.type) + (a.direction === "Inbound" ? " · from them" : "") + "</div>" + esc((a.summary || "").slice(0, 160)) + (a.summary && a.summary.length > 160 ? "…" : "") + "</li>").join("") + "</ul></div>";
    }
    return h;
  }

  function renderAdd(p) {
    const list = S.searchResults || S.companies;
    let h = '<div class="sec"><div class="row"><span class="name">' + esc(p.name || "This person") + '</span><span class="chip warn">Not in Radar</span></div></div>';
    if (S.page.type === "messaging" && !p.slug) return h + '<p class="note">Open their profile to add them to Radar.</p>';
    h += '<div class="sec"><label for="rp-name">Name<input type="text" id="rp-name" value="' + esc(p.name) + '"></label>' +
      '<label for="rp-title">Title<input type="text" id="rp-title" value="' + esc(p.title) + '"></label>' +
      '<label for="rp-loc">Location<input type="text" id="rp-loc" value="' + esc(p.location) + '"></label></div>';
    h += '<div class="sec"><h3>Company in Radar</h3>' +
      '<input type="search" id="rp-search" aria-label="Search companies in Radar" placeholder="Search companies…" value="' + esc(S.search || "") + '">';
    if (list && list.length) {
      h += list.map((l) => '<button type="button" class="pick" data-act="pick" data-id="' + esc(l.id) + '" aria-pressed="' + (S.chosenLead && S.chosenLead.id === l.id) + '">' +
        esc(l.company) + "<small>" + (l.inCrm ? "CRM · " : "") + esc(l.status) + "</small></button>").join("");
    } else {
      h += '<p class="note">' + (p.company && !S.searchResults ? "No company called “" + esc(p.company) + "” in Radar. Search above, or add the company in Radar first." : "Search for the company above.") + "</p>";
    }
    h += '</div><div class="row"><button type="button" class="btn btn-primary" data-act="save-contact"' + (S.chosenLead ? "" : " disabled") + ">Save to Radar" + (S.chosenLead ? " · " + esc(S.chosenLead.company) : "") + "</button></div>";
    return h;
  }

  // ---------- actions ----------
  function flash(textValue, ok) { S.flash = { text: textValue, ok }; render(); clearTimeout(flash.t); flash.t = setTimeout(() => { S.flash = null; render(); }, 5000); }

  async function log(what, extra) {
    const c = S.contact;
    if (!c || S.busy) return;
    const touch = what === "connection" ? 1 : what === "message" ? Math.max(2, nextTouch(c)) : 0;
    let summary = extra || "";
    if (!summary && S.lastInserted && S.lastInserted.contactId === c.id && (what !== "message" || S.lastInserted.touch !== 1)) summary = S.lastInserted.text;
    if (!summary) { const d = (c.drafts || []).find((x) => x.touch === touch); if (d) summary = draftText(d); }
    if (!summary) summary = what === "connection" ? "Connection request sent on LinkedIn" : "Message sent on LinkedIn";
    S.busy = true;
    const r = await api("POST", "/activities", { contactId: c.id, what, touch, summary });
    S.busy = false;
    if (r && r.ok) {
      S.contact = r.data; S.replyOpen = false; S.lastInserted = null;
      flash(what === "reply" ? "Reply saved. " + c.name.split(" ")[0] + " is now marked Replied." : "Logged. Next follow-up updated in Radar.", true);
    } else flash((r && r.error) || "Couldn't log it.", false);
  }

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.getAttribute("data-act");
    const id = b.getAttribute("data-id");
    if (act === "close") { S.open = false; chrome.storage.local.set({ panelOpen: false }); render(); return; }
    if (act === "open") { S.open = true; chrome.storage.local.set({ panelOpen: true }); render(); return; }
    if (act === "retry") { refresh(); return; }
    if (act === "options") { chrome.runtime.sendMessage({ type: "openOptions" }); return; }
    if (act === "insert" || act === "copy") {
      const d = (S.contact.drafts || []).find((x) => x.id === id);
      if (!d) return;
      const value = draftText(d);
      const copied = await copy(value);
      if (act === "copy") { flash(copied ? "Copied." : "Couldn't copy: select the text and copy it.", copied); return; }
      const box = findBox();
      if (!box) {
        flash((copied ? "Copied to your clipboard. " : "") + (d.touch === 1 ? "Click Connect → Add a note, then press Insert again (or paste)." : "Open the message box on LinkedIn, then press Insert again (or paste)."), !!copied);
        return;
      }
      fillBox(box, value);
      S.lastInserted = { contactId: S.contact.id, text: value, touch: d.touch };
      flash("Inserted. Check it, press Send on LinkedIn, then log it here.", true);
      return;
    }
    if (act === "checked") {
      const r = await api("POST", "/contacts/" + encodeURIComponent(S.contact.id) + "/checked");
      if (r && r.ok) { S.contact = r.data; flash("Marked as checked in Radar.", true); } else flash((r && r.error) || "Couldn't update.", false);
      return;
    }
    if (act === "log-connection") { log("connection"); return; }
    if (act === "log-message") { log("message"); return; }
    if (act === "reply-open") { S.replyText = lastReplyFromThem(S.contact && S.contact.name); S.replyOpen = true; render(); const t = root.getElementById("rp-reply"); if (t) t.focus(); return; }
    if (act === "reply-cancel") { S.replyOpen = false; render(); return; }
    if (act === "log-reply") {
      const v = (root.getElementById("rp-reply") || {}).value || "";
      if (!v.trim()) { flash("Paste or type their reply first.", false); return; }
      log("reply", v.trim());
      return;
    }
    if (act === "pick") {
      const list = S.searchResults || S.companies;
      S.chosenLead = list.find((l) => l.id === id) || null;
      // keep what was typed in the form
      ["name", "title", "loc"].forEach((k) => { const el = root.getElementById("rp-" + k); if (el && S.person) S.person[k === "loc" ? "location" : k] = el.value; });
      render();
      return;
    }
    if (act === "save-contact") {
      if (!S.chosenLead || S.busy) return;
      const v = (k) => ((root.getElementById("rp-" + k) || {}).value || "").trim();
      S.busy = true;
      const r = await api("POST", "/contacts", { leadId: S.chosenLead.id, name: v("name"), title: v("title"), location: v("loc"), linkedin: S.person.linkedin });
      S.busy = false;
      if (r && r.ok) { S.contact = r.data; flash("Saved to " + S.chosenLead.company + " in Radar.", true); }
      else flash((r && r.error) || "Couldn't save.", false);
    }
  });

  let searchTimer = null;
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.matches("textarea[data-draft]")) {
      const id = t.getAttribute("data-draft");
      S.edits[id] = t.value;
      const cnt = root.querySelector('[data-count="' + CSS.escape(id) + '"]');
      if (cnt) { cnt.textContent = t.value.length + " / " + CONN_LIMIT; cnt.classList.toggle("over", t.value.length > CONN_LIMIT); }
    } else if (t.matches("textarea[data-reply]")) {
      S.replyText = t.value;
    } else if (t.id === "rp-search") {
      S.search = t.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        await doSearch();
        const el = root.getElementById("rp-search");
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      }, 300);
    }
  });
  // Keep LinkedIn's keyboard shortcuts from firing while typing in the panel.
  ["keydown", "keyup", "keypress"].forEach((ev) => root.addEventListener(ev, (e) => e.stopPropagation()));

  // ---------- follow LinkedIn's in-page navigation ----------
  let lastKey = "";
  function tick() {
    const pg = pageType();
    const key = pg ? pg.type + ":" + (pg.slug || pg.key) : "";
    if (key !== lastKey) {
      lastKey = key;
      S.page = pg;
      S.edits = {};
      refresh();
    } else if (pg && pg.type === "messaging" && !S.person && !S.loading) {
      refresh(); // conversation content arrived late
    }
  }
  setInterval(tick, 800);
  tick();
})();
