// Nimbl Radar extension: the Home screen, shared by the LinkedIn panel (content.js) and the toolbar
// popup (popup.js). Pure rendering: takes the /api/ext/home data and returns HTML.
// Numbers cover the whole team. Styles live in home.css.
(() => {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TOUCH = { 1: "Connection note", 2: "First message", 3: "Follow-up", 4: "Value add", 5: "Last note" };
  const first = (n) => String(n || "").split(" ")[0];
  const fmtDay = (iso) => {
    if (!iso) return "";
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  };

  // ctx: { radarUrl, popup }  popup = true opens every link in a new tab.
  function links(ctx) {
    const radar = (p) => (ctx.radarUrl || "") + "/" + (p.inCrm ? "#crm/" + encodeURIComponent(p.leadId) : "");
    const person = (p, label) => {
      const href = p.linkedin || radar(p);
      const sameTab = !ctx.popup && !!p.linkedin; // on LinkedIn, open the profile right here
      return '<a href="' + esc(href) + '"' + (sameTab ? "" : ' target="_blank" rel="noopener"') + ">" + label + "</a>";
    };
    const company = (p) => '<a href="' + esc(radar(p)) + '" target="_blank" rel="noopener">' + esc(p.company) + "</a>";
    return { radar, person, company };
  }

  function todo(d, ctx) {
    const L = links(ctx);
    const t = d.todo;
    const fu = t.followUps;
    const over = fu.filter((f) => f.daysOver > 0).length;
    const tiles =
      '<div class="hm-tiles">' +
        tile(fu.length, d.scope === "me" ? "Your follow-ups due" : "Follow-ups due", over ? over + " overdue" : "", fu.length ? "hot" : "") +
        tile(t.drafts.count, "Drafts ready", t.drafts.people.length ? t.drafts.people.length + " people" : "", "") +
        tile(t.titleChecks.length, "Titles to check", "found by the scan", "") +
      "</div>";
    const rows = [];
    const cap = ctx.wide ? 10 : 8;
    fu.slice(0, cap - 2).forEach((f) => rows.push(
      '<li><span class="hm-due' + (f.daysOver > 0 ? " over" : "") + '">' + (f.daysOver > 0 ? f.daysOver + "d late" : "Today") + "</span>" +
      '<span class="hm-main"><span>' + L.person(f, esc(f.name)) + ' <span class="hm-sub">· ' + esc(f.company) + "</span></span>" +
      '<span class="hm-why">' + esc(TOUCH[f.touch] || "Follow-up") + " · " + esc(f.stage) + "</span></span></li>"));
    t.drafts.people.slice(0, Math.max(0, cap - rows.length)).forEach((p) => rows.push(
      '<li><span class="hm-due draft">Draft</span><span class="hm-main"><span>' + (p.contactId ? L.person(p, esc(p.name)) : L.company(p)) +
      (p.contactId ? ' <span class="hm-sub">· ' + esc(p.company) + "</span>" : "") + "</span>" +
      '<span class="hm-why">' + (p.kind === "reengage" ? "New role message" : esc(TOUCH[p.touch] || "Message")) + " ready to send</span></span></li>"));
    t.titleChecks.slice(0, 4).forEach((p) => rows.push(
      '<li><span class="hm-due check">Check</span><span class="hm-main"><span>' + L.person(p, esc(p.name)) + ' <span class="hm-sub">· ' + esc(p.company) + "</span></span>" +
      '<span class="hm-why">' + esc(p.title || "No title saved") + "</span></span></li>"));
    const more = fu.length + t.drafts.people.length + t.titleChecks.length - rows.length;
    return '<section class="hm-sec" aria-label="Today"><h3>Today</h3>' + tiles +
      (rows.length ? '<ul class="hm-list">' + rows.join("") + "</ul>" : '<p class="hm-empty">Nothing due. Nice.</p>') +
      (more > 0 ? '<a class="hm-more" href="' + esc((ctx.radarUrl || "") + "/#pipeline") + '" target="_blank" rel="noopener">' + more + " more in Radar ↗</a>" : "") +
      "</section>";
  }

  function tile(n, label, sub, cls) {
    return '<div class="hm-tile ' + (cls || "") + '"><div class="hm-num">' + n + '</div><div class="hm-lbl">' + esc(label) + "</div>" +
      (sub ? '<div class="hm-tsub">' + esc(sub) + "</div>" : "") + "</div>";
  }

  function delta(now, before, period) {
    const diff = now - before;
    period = period || "week";
    if (!diff) return '<span class="hm-delta">same as last ' + period + "</span>";
    return '<span class="hm-delta ' + (diff > 0 ? "up" : "down") + '">' + (diff > 0 ? "▲ " : "▼ ") + Math.abs(diff) + " vs last " + period + "</span>";
  }

  function gauge(pct, label) {
    const len = Math.PI * 40;
    const fill = Math.max(0, Math.min(1, pct)) * len;
    return '<svg class="hm-gauge" viewBox="0 0 100 58" role="img" aria-label="' + esc(label) + '">' +
      '<path d="M10 50 A40 40 0 0 1 90 50" class="trk"/>' +
      (fill > 0 ? '<path d="M10 50 A40 40 0 0 1 90 50" class="val" stroke-dasharray="' + fill.toFixed(1) + " " + len.toFixed(1) + '"/>' : "") +
      '<text x="50" y="48" text-anchor="middle">' + Math.round(pct * 100) + "%</text></svg>";
  }

  function outreach(d) {
    const a = d.dials.thisWeek, b = d.dials.lastWeek, r = d.dials.replyRate;
    const pct = r.contacted ? r.replied / r.contacted : 0;
    const dial = (k, label) => '<div class="hm-dial"><div class="hm-num">' + a[k] + '</div><div class="hm-lbl">' + label + "</div>" + delta(a[k], b[k]) + "</div>";
    const mine = d.scope === "me";
    return '<section class="hm-sec" aria-label="Outreach"><h3>Outreach · last 7 days <span class="hm-team">' + (mine ? "you" : "whole team") + "</span></h3>" +
      '<div class="hm-dials">' + dial("connections", "Connection requests") + dial("messages", "Messages and emails") +
        dial("replies", "Replies") + dial("meetings", "Meetings") + "</div>" +
      '<div class="hm-rate">' + gauge(pct, "Reply rate " + Math.round(pct * 100) + "%") +
        '<div><div class="hm-lbl">Reply rate, last 30 days</div><div class="hm-sub">' + r.replied + " of " + r.contacted +
        (r.contacted === 1 ? " person" : " people") + (mine ? " you" : " the team") + " reached out to replied</div></div></div></section>";
  }

  function fresh(d, ctx) {
    const L = links(ctx);
    const nl = d.fresh.newLeads, nr = d.fresh.newRoles;
    const roleRow = (a) => '<li><span class="hm-due role">Role</span><span class="hm-main">' +
      (a.url ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.jobTitle) + "</a>" : esc(a.jobTitle)) +
      '<span class="hm-why">' + esc(a.company) + " · found " + esc(fmtDay(a.found)) + "</span></span></li>";
    const leadRow = (l) => '<li><span class="hm-due' + (l.priority === "High" ? " high" : "") + '">' + esc(l.priority) + "</span>" +
      '<span class="hm-main">' + L.company({ leadId: l.id, company: l.company, inCrm: l.inCrm }) +
      '<span class="hm-why">' + esc(l.jobTitle) + " · added " + esc(fmtDay(l.dateAdded)) + "</span></span></li>";
    const rolesTile = tile(nr.length, "New roles", "at your CRM companies", nr.length ? "hot" : "");
    const leadsTile = tile(nl.length, "New companies", "last 7 days", "");
    const list = (rows) => (rows.length ? '<ul class="hm-list">' + rows.join("") + "</ul>" : "");
    const moreLink = (n, hash) => (n > 0 ? '<a class="hm-more" href="' + esc((ctx.radarUrl || "") + "/" + hash) + '" target="_blank" rel="noopener">' + n + " more in Radar ↗</a>" : "");
    const foot = '<p class="hm-foot">Last morning scan: ' + (d.lastScanned ? esc(fmtDay(d.lastScanned)) : "not yet") + "</p>";
    if (ctx.wide) {
      // Full width: new roles on the left, new companies on the right, each with its own list.
      const R = 8;
      return '<section class="hm-sec hm-full" aria-label="New"><h3>New this week</h3><div class="hm-pair">' +
        '<div class="hm-col">' + rolesTile + list(nr.slice(0, R).map(roleRow)) + moreLink(nr.length - R, "#crm") + "</div>" +
        '<div class="hm-col">' + leadsTile + list(nl.slice(0, R).map(leadRow)) + moreLink(nl.length - R, "#leads") + "</div>" +
        "</div>" + foot + "</section>";
    }
    return '<section class="hm-sec" aria-label="New"><h3>New this week</h3>' +
      '<div class="hm-tiles two">' + leadsTile + rolesTile + "</div>" +
      list(nr.slice(0, 4).map(roleRow).concat(nl.slice(0, 5).map(leadRow))) + foot + "</section>";
  }

  function pipeline(d) {
    const p = d.pipeline;
    const max = Math.max(1, ...p.stages.map((s) => s.count));
    const bars = p.stages.map((s) =>
      '<li><span class="hm-blbl">' + esc(s.status) + '</span><span class="hm-bar"><span style="width:' + (s.count ? Math.max(4, (s.count / max) * 100) : 0) + '%"></span></span>' +
      '<span class="hm-bnum">' + s.count + "</span></li>").join("");
    return '<section class="hm-sec" aria-label="Pipeline"><h3>CRM companies by status</h3><ul class="hm-bars">' + bars + "</ul>" +
      '<div class="hm-facts">' +
        "<span><b>" + p.jds.ready + "</b> job description" + (p.jds.ready === 1 ? "" : "s") + " ready" + (p.jds.waiting ? " · " + p.jds.waiting + " waiting" : "") + "</span>" +
        "<span><b>" + p.candidates.inProgress + "</b> candidate" + (p.candidates.inProgress === 1 ? "" : "s") + " in progress · " + p.candidates.placed + " placed</span>" +
        "<span><b>" + p.totals.crm + "</b> compan" + (p.totals.crm === 1 ? "y" : "ies") + " in the CRM · " + p.totals.leads + " leads in Radar" + (p.closed ? " · " + p.closed + " closed" : "") + "</span>" +
      "</div></section>";
  }

  // Me / Team switch at the top of Home. "Me" covers follow-ups and outreach you logged yourself.
  function scopeSwitch(d) {
    const mine = d.scope === "me";
    const b = (v, label) => '<button type="button" role="tab" data-act="scope" data-scope="' + v + '" aria-selected="' + ((v === "me") === mine) + '">' + label + "</button>";
    return '<div class="hm-scope"><div class="hm-seg" role="tablist" aria-label="Whose numbers">' + b("team", "Team") + b("me", "Me") + "</div>" +
      '<span class="hm-sub">' + (mine
        ? "Your follow-ups and outreach" + (d.trackedSince ? ", from what you've logged since " + esc(fmtDay(d.trackedSince)) : "")
        : "Everyone's follow-ups and outreach") + "</span></div>";
  }

  function render(d, ctx) {
    ctx = ctx || {};
    return ctx.wide
      ? '<div class="hm">' + scopeSwitch(d) + '<div class="hm-wide"><div class="hm-col">' + todo(d, ctx) + '</div><div class="hm-col">' + outreach(d) + pipeline(d) + "</div></div>" + fresh(d, ctx) + "</div>"
      : '<div class="hm">' + scopeSwitch(d) + todo(d, ctx) + outreach(d) + fresh(d, ctx) + pipeline(d) + "</div>";
  }

  const initials = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  // ctx.photos: extension pages can show the Google photo; on LinkedIn we use initials.
  // ctx.photoUrl: the person's Google photo as a data: URL (from the extension's background).
  // If it's missing or fails to load, initials show instead (see fixAvatars).
  function avatar(u, ctx, size) {
    const st = size ? ' style="width:' + size + "px;height:" + size + 'px"' : "";
    const ini = esc(initials(u.name || u.email));
    return ctx && ctx.photoUrl
      ? '<img class="me-av" src="' + esc(ctx.photoUrl) + '" alt="" data-ini="' + ini + '"' + st + ">"
      : '<span class="me-av me-ini"' + st + ">" + ini + "</span>";
  }
  // Swap any photo that fails to load (e.g. blocked by the page) for initials.
  function fixAvatars(root) {
    root.querySelectorAll("img.me-av").forEach((img) => {
      const swap = () => {
        const s = document.createElement("span");
        s.className = "me-av me-ini"; s.textContent = img.getAttribute("data-ini") || "?";
        if (img.style.width) { s.style.width = img.style.width; s.style.height = img.style.height; }
        img.replaceWith(s);
      };
      if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener("error", swap, { once: true });
    });
  }
  // The small "who's signed in" button for headers.
  function chip(u, ctx, active) {
    if (!u) return "";
    return '<button type="button" class="me-chip" data-act="profile" aria-pressed="' + !!active + '" title="Signed in as ' + esc(u.name) + " (" + esc(u.email) + ')" aria-label="Your profile: ' + esc(u.name) + '">' +
      avatar(u, ctx) + '<span class="me-name">' + esc(first(u.name)) + "</span></button>";
  }

  function renderProfile(p, ctx) {
    ctx = ctx || {};
    const u = p.user, a = p.thisMonth, b = p.lastMonth, r = p.replyRate;
    const pct = r.contacted ? r.replied / r.contacted : 0;
    const dial = (k, label) => '<div class="hm-dial"><div class="hm-num">' + a[k] + '</div><div class="hm-lbl">' + label + "</div>" + delta(a[k], b[k], "month") + "</div>";
    const keys = p.keys.map((k) => '<li><span class="hm-main"><span>' + esc(k.label || "Chrome extension") + ' <span class="hm-sub mono">' + esc(k.prefix) + "…</span></span>" +
      '<span class="hm-why">Connected ' + esc(fmtDay(k.createdAt)) + (k.lastUsedAt ? " · last used " + esc(fmtDay(k.lastUsedAt)) : "") + "</span></span>" +
      (k.current ? '<span class="hm-due">This browser</span>' : '<button type="button" class="pf-link" data-act="key-revoke" data-id="' + esc(k.id) + '">Disconnect</button>') + "</li>").join("");
    return '<div class="hm pf">' +
      '<div class="pf-head">' + avatar(u, ctx, 32) + '<div class="pf-id"><strong>' + esc(u.name) + '</strong> <span class="hm-sub">' + esc(u.email) +
        " · " + (u.isOwner ? "Owner" : "Team member") + "</span></div></div>" +
      '<section class="hm-sec" aria-label="Your numbers"><h3>Your month <span class="hm-team">vs last month</span></h3>' +
        '<div class="hm-dials three">' + dial("connections", "Connection requests") + dial("messages", "Messages and emails") + dial("replies", "Replies") +
          dial("meetings", "Meetings") + dial("contactsAdded", "Contacts added") + dial("savedToCrm", "Saved to the CRM") + "</div>" +
        '<div class="hm-rate">' + gauge(pct, "Your reply rate " + Math.round(pct * 100) + "%") +
          '<div><div class="hm-lbl">Your reply rate, last 30 days</div><div class="hm-sub">' + r.replied + " of " + r.contacted + (r.contacted === 1 ? " person" : " people") + " you reached out to replied</div></div></div>" +
        '<div class="hm-facts"><span><b>' + p.placements + "</b> placement" + (p.placements === 1 ? "" : "s") + " recorded by you</span></div>" +
        (p.trackedSince ? '<p class="hm-foot">Counts what you have logged since ' + esc(fmtDay(p.trackedSince)) + ", when Radar started recording who did what.</p>" : "") +
      "</section>" +
      '<section class="hm-sec" aria-label="Browsers"><h3>Browsers connected to your account</h3>' +
        (keys ? '<ul class="hm-list">' + keys + "</ul>" : '<p class="hm-empty">None.</p>') + "</section>" +
      '<div class="pf-actions"><a class="pf-btn" href="' + esc((ctx.radarUrl || "") + "/") + '" target="_blank" rel="noopener">Open Radar ↗</a>' +
        '<button type="button" class="pf-btn" data-act="signout">Sign out of this browser</button></div>' +
    "</div>";
  }

  const api = { render, renderProfile, chip, avatar, fixAvatars, first };
  if (typeof window !== "undefined") window.RadarHome = api;
})();
