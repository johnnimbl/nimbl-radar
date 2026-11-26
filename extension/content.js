// Nimbl Radar panel on LinkedIn.
// Reads only the page that is open (a profile or a conversation), shows that person's Radar record,
// fills drafts into LinkedIn's own message boxes and logs touches. It never clicks Send, Connect or
// anything else on LinkedIn, and never visits pages by itself.
(() => {
  if (window.__nimblRadar) return;
  window.__nimblRadar = true;

  const CONN_LIMIT = 300; // LinkedIn Premium connection notes
  const HOME_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 7.2 8 2l6 5.2V14H9.7v-4H6.3v4H2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const TOUCH_LABEL = { 1: "Connection note", 2: "First message", 3: "Follow-up", 4: "Value add", 5: "Last note" };

  // ---------- shadow-root panel ----------
  const host = document.createElement("div");
  host.id = "nimbl-radar-host";
  const root = host.attachShadow({ mode: "open" });
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = chrome.runtime.getURL("panel.css");
  const css2 = document.createElement("link");
  css2.rel = "stylesheet";
  css2.href = chrome.runtime.getURL("home.css");
  const wrap = document.createElement("div");
  wrap.className = "rp";
  root.append(css, css2, wrap);
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
    view: "person",        // "person" (the profile or conversation) or "home" (the dashboard)
    otherOpen: false,      // panel open on other LinkedIn pages (feed, search…): closed until you open it
    home: null, homeLoading: false, homeError: "", homeAt: 0,
    scope: "team",         // Home numbers: "team" or "me"
    me: null,              // who the extension is signed in as {email, name, photo, isOwner}
    prof: null, profLoading: false, profError: "",
  };
  chrome.storage.local.get({ panelOpen: true, panelWide: false }).then((v) => { S.open = v.panelOpen; S.wide = v.panelWide; render(); });

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // "kai@nimbl.ai" -> " · by Kai" (who logged it in Radar; older entries have no author)
  const byWho = (e) => { e = String(e || ""); if (!e) return ""; const n = e.includes("@") ? e.split("@")[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : e; return " · by " + esc(n); };
  const api = (method, path, body) => chrome.runtime.sendMessage({ type: "api", method, path, body });
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const slugOf = (href) => { const m = /\/in\/([^/?#]+)/.exec(href || ""); return m ? decodeURIComponent(m[1]).toLowerCase() : ""; };

  // ---------- reading LinkedIn ----------
  function pageType() {
    const p = location.pathname;
    if (/^\/in\/[^/]+/.test(p)) return { type: "profile", slug: slugOf(p) };
    if (/^\/messaging\/thread\//.test(p)) return { type: "messaging", key: p };
    return { type: "other", key: "other" };
  }

  // LinkedIn's profile markup changes often (2026: obfuscated class names, the name in an <h2>), so
  // this leans on things that rarely change: the page title, the heading text, the order of the
  // lines under the name, "View company:" / "Current company:" labels and the "Contact info" link.
  function readProfile(slug) {
    const main = document.querySelector("main") || document.body;
    let name = (document.title || "").replace(/^\(\d+\)\s*/, "").split(" | ")[0].trim();
    if (/^linkedin$/i.test(name)) name = "";
    const heads = [...main.querySelectorAll("h1, h2")];
    // The heading can differ from the page title: "Jenny (Solomon) Chiczewski", "Ana Souza, PMP", emoji.
    const words = (s) => s.replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{M}\s'-]/gu, " ").toLowerCase().split(/\s+/).filter(Boolean);
    const nameWords = words(name);
    let head = heads.find((h) => name && text(h) === name) ||
      heads.find((h) => { const hw = words(text(h)); return nameWords.length > 0 && hw.length <= nameWords.length + 4 && nameWords.every((w) => hw.includes(w)); }) ||
      main.querySelector("h1");
    if (!name && head) name = text(head);
    if (!name || !head) return null;
    // the top card: the nearest ancestor that also holds the "Contact info" link (or a few lines of text)
    let card = head;
    for (let i = 0; i < 10 && card.parentElement; i++) {
      card = card.parentElement;
      if (card.querySelector('a[href*="contact-info"]') || card.querySelectorAll("p, .text-body-medium").length >= 4) break;
    }
    const lines = [...card.querySelectorAll("p, div.text-body-medium, span.text-body-small")]
      .filter((e) => !e.querySelector("p"))
      .map((e) => text(e))
      .filter((t, i, a) => t && a.indexOf(t) === i)
      .filter((t) => t !== name && t !== text(head) && !/^·?\s*(1st|2nd|3rd\+?|3rd)$/i.test(t) && t !== "·" && !/^contact info$/i.test(t) &&
        !/connections?$/i.test(t) && !/mutual connection/i.test(t) && !/^\(?(he|she|they|ze|xe)\/\w+\)?$/i.test(t));
    const title = lines[0] || "";
    const location = lines.slice(1).find((t) => /,/.test(t) && t.length < 80) || "";
    // Under the headline LinkedIn shows "Current company · School"; otherwise use the labels.
    let company = "";
    const second = lines[1] || "";
    if (second && second !== location && !/,/.test(second)) company = second.split(" · ")[0].trim();
    if (!company) {
      const coEl = card.querySelector('[aria-label^="Current company"], a[aria-label^="View company:"]');
      if (coEl) company = (coEl.getAttribute("aria-label") || "").replace(/^(Current company|View company):?\s*/i, "").replace(/\.\s*Click.*$/i, "").trim();
    }
    if (!company) { const m = /(?:\bat\b|@)\s+([^|,·•]+)/i.exec(title); if (m) company = m[1].trim(); }
    // The current company's LinkedIn page (Radar saves it on the company when it has none).
    const coLink = card.querySelector('a[aria-label^="Current company"][href*="/company/"], a[aria-label^="View company:"][href*="/company/"]') ||
      (card.querySelector('[aria-label^="Current company"], [aria-label^="View company:"]') || { closest: () => null }).closest('a[href*="/company/"]');
    const companyUrl = coLink ? coLink.href.split("?")[0] : "";
    return { slug, linkedin: "https://www.linkedin.com/in/" + slug + "/", name, title, location, company, companyUrl };
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
    const headerLink = scope.querySelector('.msg-thread__link-to-profile[href*="/in/"], .msg-entity-lockup a[href*="/in/"]');
    const slug = (headerLink && slugOf(headerLink.getAttribute("href"))) || Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "";
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
    const modal = document.querySelector('.artdeco-modal textarea[name="message"], .artdeco-modal #custom-message, .artdeco-modal textarea, [role="dialog"] textarea');
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
    if (pg.type === "other") { S.view = "home"; render(); if (S.otherOpen) loadHome(); return; }
    S.view = "person";
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
    const q = new URLSearchParams({ linkedin: person.linkedin || "", name: person.name || "", company: person.company || "", location: person.location || "", companyUrl: person.companyUrl || "" });
    const r = await api("GET", "/lookup?" + q.toString());
    if (seq !== loadSeq) return;
    S.loading = false;
    if (!r || !r.ok) { S.error = (r && r.error) || "Couldn't reach Radar."; S.needsKey = !!(r && r.needsKey); render(); return; }
    S.radarUrl = r.radarUrl;
    S.contact = r.data.contact;
    S.companies = r.data.companies || [];
    if (!S.contact && S.companies.length === 1) S.chosenLead = S.companies[0];
    render();
    loadHome(); // keeps the Home count in the switch current (cached for a minute)
    loadMe();
  }

  // Home dashboard data (cached for a minute; ↻ reloads it).
  async function loadHome(force) {
    if (S.homeLoading || (!force && S.home && S.home.scope === S.scope && Date.now() - S.homeAt < 60000)) { render(); return; }
    S.homeLoading = true; S.homeError = ""; render();
    loadMe();
    const r = await api("GET", "/home?scope=" + S.scope);
    S.homeLoading = false;
    if (r && r.ok) { S.home = r.data; S.homeAt = Date.now(); S.radarUrl = r.radarUrl; }
    else { S.homeError = (r && r.error) || "Couldn't reach Radar."; S.needsKey = !!(r && r.needsKey); }
    render();
  }
  // Who the extension is signed in as (cached for 10 minutes).
  async function loadMe(force) {
    if (!force && S.me) return;
    const c = (await chrome.storage.local.get({ me: null })).me;
    if (!force && c && Date.now() - c.at < 600000) { S.me = c.user; render(); return; }
    const r = await api("GET", "/me");
    if (r && r.ok) { S.me = r.data; chrome.storage.local.set({ me: { user: r.data, at: Date.now() } }); render(); }
  }
  async function loadProfile() {
    S.profLoading = true; S.profError = ""; render();
    const r = await api("GET", "/profile");
    S.profLoading = false;
    if (r && r.ok) { S.prof = r.data; S.me = r.data.user; S.radarUrl = r.radarUrl; }
    else { S.profError = (r && r.error) || "Couldn't reach Radar."; S.needsKey = !!(r && r.needsKey); }
    render();
  }
  function onPersonPage() { return !!(S.page && S.page.type !== "other"); }
  // Signed in or out from the settings page or Radar: start fresh.
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "sync" || !ch.key) return;
    S.me = null; S.prof = null; S.home = null; S.needsKey = !ch.key.newValue;
    if (ch.key.newValue) { loadMe(true); if (S.view === "home") loadHome(true); else if (S.view === "profile") loadProfile(); else refresh(); }
    else render();
  });
  function isOpen() { return S.page && S.page.type === "other" ? S.otherOpen : S.open; }

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
    if (!isOpen()) {
      wrap.innerHTML = '<button type="button" class="tab" data-act="open" aria-label="Open the Nimbl Radar panel">' +
        (S.contact ? '<span class="dot" aria-hidden="true"></span>' : "") + "Radar</button>";
      return;
    }
    const onPerson = pg.type !== "other";
    const homeView = S.view === "home";
    const profView = S.view === "profile";
    let body = "";
    if (profView) {
      if (S.needsKey) body = '<p>You are signed out.</p><div class="row"><button type="button" class="btn btn-primary" data-act="signin">Sign in with Google</button></div>';
      else if (S.profError) body = '<div class="msg err">' + esc(S.profError) + '</div><div class="row"><button type="button" class="btn" data-act="retry">Try again</button></div>';
      else if (!S.prof) body = '<p class="muted">Loading your profile…</p>';
      else body = window.RadarHome.renderProfile(S.prof, { radarUrl: S.radarUrl });
    } else if (homeView) {
      if (S.needsKey) body = '<p>Sign in to connect the extension to your Radar account.</p><div class="row"><button type="button" class="btn btn-primary" data-act="signin">Sign in with Google</button></div>';
      else if (S.homeError) body = '<div class="msg err">' + esc(S.homeError) + '</div><div class="row"><button type="button" class="btn" data-act="retry">Try again</button></div>';
      else if (!S.home) body = '<p class="muted">Loading your Radar numbers…</p>';
      else body = window.RadarHome.render(S.home, { radarUrl: S.radarUrl, wide: S.wide });
    } else if (S.loading) body = '<p class="muted">Looking this person up in Radar…</p>';
    else if (S.needsKey) body = '<p>Sign in to connect the extension to your Radar account.</p><div class="row"><button type="button" class="btn btn-primary" data-act="signin">Sign in with Google</button></div>';
    else if (S.error) body = '<div class="msg err">' + esc(S.error) + '</div><div class="row"><button type="button" class="btn" data-act="retry">Try again</button></div>';
    else if (!S.person) body = pg.type === "messaging" ? '<p class="muted">Open a conversation to see that person in Radar.</p>' : '<p class="muted">Couldn\'t read this profile.</p><div class="row"><button type="button" class="btn" data-act="retry">Try again</button></div>';
    else if (S.contact) body = renderContact(S.contact);
    else body = renderAdd(S.person);
    if (S.flash) body = '<div class="msg ' + (S.flash.ok ? "ok" : "err") + '" role="status">' + esc(S.flash.text) + "</div>" + body;
    wrap.innerHTML =
      '<section class="panel' + (S.wide ? " wide" : "") + '" aria-label="Nimbl Radar">' +
        '<div class="top"><div class="head"><img src="' + chrome.runtime.getURL("icons/icon32.png") + '" alt=""><strong>Nimbl Radar</strong>' +
          (S.me ? window.RadarHome.chip(S.me, {}, profView) : "") +
          '<button type="button" class="icon-btn" data-act="wide" title="' + (S.wide ? "Show less" : (homeView ? "Wider dashboard" : "Show the full client card")) + '" aria-label="' + (S.wide ? "Show less" : "Show more") + '" aria-pressed="' + !!S.wide + '">' + (S.wide ? "⇥" : "⇤") + "</button>" +
          '<button type="button" class="icon-btn" data-act="retry" title="Refresh" aria-label="Refresh">↻</button>' +
          '<button type="button" class="icon-btn" data-act="close" title="Hide panel" aria-label="Hide panel">–</button></div>' +
          renderSwitch(onPerson, homeView) + "</div>" +
        '<div class="body">' + body + "</div>" +
      "</section>";
    window.RadarHome.fixAvatars(wrap);
  }

  // Two-part switch under the header: [ person ] [ Home · follow-ups due ]. Always visible (sticky).
  function renderSwitch(onPerson, homeView) {
    const due = S.home ? S.home.todo.followUps.length : 0;
    const name = (S.contact && S.contact.name) || (S.person && S.person.name) || "";
    const who = name ? String(name).split(" ")[0] : (S.page && S.page.type === "messaging" ? "Conversation" : "Profile");
    const tab = (view, label, sel) => '<button type="button" role="tab" data-act="view" data-view="' + view + '" aria-selected="' + sel + '">' + label + "</button>";
    const home = HOME_ICON + "<span>Home</span>" + (due ? '<span class="sw-count" title="Follow-ups due">' + due + "</span>" : "");
    return '<div class="switch" role="tablist" aria-label="Panel view">' +
      (onPerson ? tab("person", '<span class="who">' + esc(who) + "</span>", S.view === "person") : "") + tab("home", home, homeView) + "</div>";
  }

  function renderContact(c) {
    const lead = c.lead || {};
    // Radar opens the company wherever it lives (CRM card or Leads row) and scrolls to this person.
    const radarLink = S.radarUrl ? S.radarUrl + "/#lead/" + encodeURIComponent(lead.id) + (c.id ? "/" + encodeURIComponent(c.id) : "") : "";
    const stageCls = c.stage === "Replied" || c.stage === "Meeting booked" ? "good" : c.stage === "Not contacted" ? "warn" : "teal";
    let h = '<div class="sec"><div class="row"><span class="name">' + esc(c.name) + '</span><span class="chip ' + stageCls + '">' + esc(c.stage) + "</span></div>" +
      (c.title || c.location ? '<div class="sub">' + esc([c.title, c.location].filter(Boolean).join(" · ")) + "</div>" : "") +
      '<div class="row sub">' + esc(lead.company || "") + (radarLink ? ' · <a href="' + esc(radarLink) + '" target="_blank" rel="noopener">Open in Radar ↗</a>' : "") + "</div>" +
      '<div class="sub">Touch ' + (c.step || 0) + " of 5" + (c.nextFollowUp ? " · " + esc(followLabel(c.nextFollowUp)) : "") + "</div></div>";
    if (c.agentFound) {
      h += '<div class="warnbox"><strong>Found by the agent.</strong><span>Check that the title on this profile still matches before you reach out.</span>' +
        '<div class="row"><button type="button" class="btn" data-act="checked">Title looks right</button></div></div>';
    }
    if (c.owner) {
      h += '<div class="warnbox"><strong>' + esc(c.owner) + "'s contact.</strong><span>" + esc(c.owner) + " looks after " + esc(c.name.split(" ")[0]) +
        ", so Radar doesn't draft messages for them. Check with " + esc(c.owner) + " before reaching out.</span></div>";
    }
    const drafts = c.owner ? [] : c.drafts || [];
    h += c.owner ? '<div class="sec" hidden>' : '<div class="sec"><h3>Drafts</h3>';
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
    const timeline = acts.length
      ? '<div class="sec"><h3>' + (S.wide ? "Timeline with " + esc(c.name.split(" ")[0]) : "Recent") + '</h3><ul class="acts">' + acts.slice(0, S.wide ? 25 : 3).map((a) => {
          const full = S.wide ? (a.summary || "") : (a.summary || "").slice(0, 160) + (a.summary && a.summary.length > 160 ? "…" : "");
          return '<li><div class="meta">' + esc(a.date) + " · " + esc(a.type) + (a.direction === "Inbound" ? " · from them" : "") + byWho(a.author) + '</div><div class="act-text">' + esc(full) + "</div></li>";
        }).join("") + "</ul></div>"
      : "";
    if (!S.wide) {
      h += renderRole(c) + timeline;
      if (c.card) h += '<div class="row"><button type="button" class="btn" data-act="wide">Show the full client card ⇤</button></div>';
      return h;
    }
    return '<div class="cols"><div class="col">' + h + timeline + '</div><div class="col">' + renderRole(c) + renderCard(c) + "</div></div>";
  }

  // The open role (and any newer ones) with its job descriptions: open the posting, preview or
  // download the Nimbl PDF, or save the posting for Claude to write up.
  function renderRole(c) {
    const lead = c.lead || {};
    const card = c.card || {};
    const jds = card.jobDescriptions || [];
    const roles = (card.roles || []).filter((r) => r.url && r.url !== card.jobUrl);
    if (!lead.jobTitle && !jds.length && !roles.length) return "";
    let h = '<div class="sec"><h3>Open role</h3><div class="card">';
    if (lead.jobTitle) {
      h += '<div><strong>' + esc(lead.jobTitle) + "</strong>" + (card.employmentType ? '<div class="sub">' + esc(card.employmentType) + (card.datePosted ? " · posted " + esc(card.datePosted) : "") + "</div>" : "") + "</div>";
      if (card.jobUrl) h += '<div class="row"><a href="' + esc(card.jobUrl) + '" target="_blank" rel="noopener">Open the job posting ↗</a></div>';
    }
    jds.forEach((j) => {
      h += '<div class="jd-line"><span>' + esc(j.title) + "</span>" + (j.status === "ready"
        ? '<span class="row"><button type="button" class="btn btn-primary" data-act="jd-download" data-id="' + esc(j.id) + '" data-title="' + esc(j.title) + '">Download PDF</button>' +
          (S.radarUrl ? '<a href="' + esc(S.radarUrl + "/api/job-descriptions/" + encodeURIComponent(j.id) + "/pdf") + '" target="_blank" rel="noopener">Preview ↗</a>' : "") + "</span>"
        : '<span class="chip warn">Waiting for Claude</span>') + "</div>";
    });
    if (!jds.length && card.jobUrl) {
      h += '<div class="row"><button type="button" class="btn" data-act="jd-new">Make a Nimbl job description</button></div>' +
        '<p class="note">Saves this posting in Radar; then ask Claude in chat to write it up on the letterhead.</p>';
    }
    if (roles.length) {
      h += '<div class="sub">Also posted:</div><ul class="plain">' + roles.map((r) => '<li><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.title || "Job posting") + " ↗</a>" + (r.date ? ' <span class="muted">' + esc(r.date) + "</span>" : "") + "</li>").join("") + "</ul>";
    }
    return h + "</div></div>";
  }

  // The bigger view: the company around this person, like Radar's client card.
  function renderCard(c) {
    const lead = c.lead || {};
    const card = c.card;
    if (!card) return "";
    const pri = lead.priority === "High" ? "good" : lead.priority === "Low" ? "" : "warn";
    let h = '<div class="sec"><h3>Company</h3><div class="card">' +
      '<div class="row"><strong>' + esc(lead.company) + '</strong><span class="chip teal">' + esc(lead.status || "") + "</span>" + (lead.priority ? '<span class="chip ' + pri + '">' + esc(lead.priority) + "</span>" : "") + "</div>" +
      (card.linkedinSummary ? '<div class="sub">' + esc(card.linkedinSummary) + "</div>" : card.estSize ? '<div class="sub">' + esc(card.estSize) + "</div>" : "") +
      '<div class="row">' + (card.website ? '<a href="' + esc(card.website) + '" target="_blank" rel="noopener">Website ↗</a>' : "") +
        (card.linkedin ? '<a href="' + esc(card.linkedin) + '" target="_blank" rel="noopener">Company LinkedIn ↗</a>' : "") + "</div>" +
      (card.nearshoreFit ? '<details><summary>Nearshore fit</summary><p class="note">' + esc(card.nearshoreFit) + "</p></details>" : "") +
      (card.companyProfile ? '<details><summary>About the company</summary><p class="note">' + esc(card.companyProfile) + "</p></details>" : "") +
      "</div></div>";
    const people = card.people || [];
    if (people.length) {
      h += '<div class="sec"><h3>People at ' + esc(lead.company) + '</h3><ul class="people">' + people.map((p) => {
        const me = p.id === c.id;
        const nm = p.linkedin && !me ? '<a href="' + esc(p.linkedin) + '">' + esc(p.name) + "</a>" : "<strong>" + esc(p.name) + "</strong>";
        return "<li>" + nm + (p.isPrimary ? ' <span class="chip good">First</span>' : "") + (me ? ' <span class="muted">(this profile)</span>' : "") +
          '<div class="sub">' + esc(p.title || "") + (p.title ? " · " : "") + esc(p.stage) + (p.nextFollowUp ? " · " + esc(followLabel(p.nextFollowUp)) : "") + "</div></li>";
      }).join("") + "</ul></div>";
    }
    const notes = card.notes || [];
    if (notes.length) {
      h += '<div class="sec"><h3>Notes</h3><ul class="acts">' + notes.map((n) => '<li><div class="meta">' + esc(n.date) + byWho(n.author) + '</div><div class="act-text">' + esc(n.text) + "</div></li>").join("") + "</ul></div>";
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
    const other = S.page && S.page.type === "other";
    if (act === "close") { if (other) S.otherOpen = false; else { S.open = false; chrome.storage.local.set({ panelOpen: false }); } render(); return; }
    if (act === "open") { if (other) { S.otherOpen = true; loadHome(); } else { S.open = true; chrome.storage.local.set({ panelOpen: true }); render(); } return; }
    if (act === "profile") { if (S.view === "profile") { S.view = onPersonPage() ? "person" : "home"; if (S.view === "home") loadHome(); else render(); } else { S.view = "profile"; loadProfile(); } return; }
    if (act === "signin") { chrome.runtime.sendMessage({ type: "signIn" }); return; }
    if (act === "signout") {
      if (!confirm("Sign this browser out of Radar? You can sign in again any time.")) return;
      await chrome.runtime.sendMessage({ type: "signOut" });
      S.me = null; S.prof = null; S.home = null; S.needsKey = true;
      render();
      return;
    }
    if (act === "key-revoke") {
      const r = await api("DELETE", "/keys/" + encodeURIComponent(id));
      if (r && r.ok) { flash("That browser is disconnected.", true); loadProfile(); } else flash((r && r.error) || "Couldn't disconnect it.", false);
      return;
    }
    if (act === "view") { const v = b.getAttribute("data-view"); if (v === S.view) return; S.view = v; if (v === "home") loadHome(); else render(); return; }
    if (act === "retry") { if (S.view === "home") loadHome(true); else if (S.view === "profile") loadProfile(); else refresh(); return; }
    if (act === "wide") { S.wide = !S.wide; chrome.storage.local.set({ panelWide: S.wide }); render(); return; }
    if (act === "jd-download") {
      b.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: "downloadJd", id, title: b.getAttribute("data-title") || "Job description" });
      b.disabled = false;
      flash(r && r.ok ? "Downloading the PDF." : (r && r.error) || "Couldn't download the PDF.", !!(r && r.ok));
      return;
    }
    if (act === "jd-new") {
      const lead = S.contact && S.contact.lead;
      if (!lead) return;
      const r = await api("POST", "/job-descriptions", { leadId: lead.id, sourceUrl: (S.contact.card && S.contact.card.jobUrl) || "" });
      if (r && r.ok) {
        S.contact.card.jobDescriptions = [{ id: r.data.id, title: lead.jobTitle || "Job description", status: "waiting" }];
        flash("Saved in Radar. Ask Claude in chat to do the job description for " + lead.company + ".", true);
      } else flash((r && r.error) || "Couldn't save.", false);
      return;
    }
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
