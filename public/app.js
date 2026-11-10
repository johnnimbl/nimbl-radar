
(function () {
  "use strict";


  var PRIORITIES = ["High", "Medium", "Low"];
  var STATUSES = ["Not Started", "Researching", "Contacted", "Replied", "Meeting Booked", "Proposal Sent", "Won", "Lost", "Not a Fit"];
  var ACTIVE_STATUSES = ["Contacted", "Replied", "Meeting Booked", "Proposal Sent"];
  var DEAD_STATUSES = ["Lost", "Not a Fit"];
  var CONTACT_ROLES = ["Admin", "Accounting", "HR", "Signatory", "Technical", "Billing"];
  var CONTACT_STAGES = ["Not contacted", "Connection sent", "Connected", "Message sent", "Replied", "Meeting booked", "Not interested", "No response"];
  var ACTIVITY_TYPES = ["LinkedIn connection", "LinkedIn message", "Email", "Call", "Meeting", "Note"];
  // How far along a contact is. "Not interested" outranks everything so it is never auto-suggested away.
  var STAGE_RANK = { "Not contacted": 0, "No response": 0, "Connection sent": 1, "Connected": 2, "Message sent": 3, "Replied": 4, "Meeting booked": 5, "Not interested": 99 };
  // Company status a contact's stage pulls the lead up to (forward only).
  var STAGE_TO_STATUS = { "Connection sent": "Contacted", "Connected": "Contacted", "Message sent": "Contacted", "Replied": "Replied", "Meeting booked": "Meeting Booked" };
  var AUTO_ADVANCE_FROM = ["Not Started", "Researching", "Contacted", "Replied", "Meeting Booked"];
  var FOLLOWUP_WINDOW_DAYS = 7;
  // Days until the next nudge once a contact reaches this stage. Edit these to change your rhythm.
  var CADENCE_DAYS = { "Connection sent": 4, "Connected": 2, "Message sent": 5, "Replied": 2, "No response": 14 };
  var BOARD_STAGES = ["Not contacted", "Connection sent", "Connected", "Message sent", "Replied", "Meeting booked", "No response", "Not interested"];
  var CANDIDATE_STAGES = ["Identified", "Call booked", "Screen Approved", "Presented", "Interviewing", "Pre-Approved", "Placed", "Not Placed"];
  var PAGE_SIZE_STEP = 8;

  var state = { lastScanned: "", roleTypes: [], leads: [] };
  var filters = { roleType: "All", priority: "All", status: "All", q: "" };
  var expandedId = null;
  var view = window.location.hash === "#crm" ? "crm" : "leads";
  var crmQuery = "";
  var activityForm = null; // the open "Log activity" form, if any (kept outside the DOM so re-renders do not lose it)
  var pageSize = PAGE_SIZE_STEP;
  var readOnly = false;
  var currentUser = null; // { email, name, photo } when Google sign-in is on; null otherwise

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var parts = iso.split("-");
    if (parts.length !== 3) return iso;
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var m = parseInt(parts[1], 10) - 1;
    return months[m] + " " + parseInt(parts[2], 10) + ", " + parts[0];
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  // Today in the viewer's local calendar, as YYYY-MM-DD.
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function isIsoDate(iso) { return typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso); }

  function dayNum(iso) {
    var p = iso.split("-");
    return Math.round(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)) / 86400000);
  }

  // a - b, in whole days
  function diffDays(a, b) { return dayNum(a) - dayNum(b); }

  function addDays(iso, n) {
    var p = iso.split("-");
    var d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + n));
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  function daysSince(iso) {
    if (!isIsoDate(iso)) return null;
    var diff = diffDays(todayStr(), iso);
    return diff >= 0 ? diff : null;
  }

  function statusClass(st) {
    if (ACTIVE_STATUSES.indexOf(st) !== -1) return "st-active";
    if (st === "Won" || st === "Replied") return "st-good";
    if (DEAD_STATUSES.indexOf(st) !== -1) return "st-dead";
    return "";
  }

  function priorityClass(p) {
    return "pill-" + p.toLowerCase();
  }

  function priorityRank(p) {
    return p === "High" ? 0 : p === "Medium" ? 1 : 2;
  }

  function initialsOf(name) {
    var s = (name || "").trim();
    if (!s) return "?";
    var parts = s.split(/\s+/);
    var out = parts[0].charAt(0);
    if (parts.length > 1) out += parts[parts.length - 1].charAt(0);
    return out.toUpperCase();
  }

  function setDeep(obj, path, value) {
    var parts = path.split(".");
    var o = obj;
    for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = value;
  }

  function newRolesCount() {
    var n = 0;
    for (var i = 0; i < state.leads.length; i++) if (state.leads[i].isNew) n++;
    return n;
  }

  function activeOutreachCount() {
    var n = 0;
    for (var i = 0; i < state.leads.length; i++) if (ACTIVE_STATUSES.indexOf(state.leads[i].status) !== -1) n++;
    return n;
  }

  function highPriorityCount() {
    var n = 0;
    for (var i = 0; i < state.leads.length; i++) if (state.leads[i].priority === "High") n++;
    return n;
  }

  function filteredLeads() {
    return state.leads.filter(function (l) {
      if (filters.roleType !== "All" && l.roleType !== filters.roleType) return false;
      if (filters.priority !== "All" && l.priority !== filters.priority) return false;
      if (filters.status !== "All" && l.status !== filters.status) return false;
      if (filters.q) {
        var hay = (l.company + " " + l.jobTitle + " " + l.requiredSkills).toLowerCase();
        if (hay.indexOf(filters.q.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }

  function priorityLeads() {
    return state.leads.filter(function (l) {
      return DEAD_STATUSES.indexOf(l.status) === -1 && l.status !== "Won";
    }).sort(function (a, b) {
      var pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      return (b.dateAdded || "").localeCompare(a.dateAdded || "");
    }).slice(0, 5);
  }

  function findLead(id) {
    for (var i = 0; i < state.leads.length; i++) if (state.leads[i].id === id) return state.leads[i];
    return null;
  }

  function findContact(l, cid) {
    if (!l || !l.contacts) return null;
    for (var i = 0; i < l.contacts.length; i++) if (l.contacts[i].id === cid) return l.contacts[i];
    return null;
  }

  /* ---------------- CRM helpers ---------------- */

  // Every scheduled follow-up on a live lead, soonest first.
  function allFollowUps() {
    var today = todayStr();
    var out = [];
    state.leads.forEach(function (l) {
      if (DEAD_STATUSES.indexOf(l.status) !== -1) return;
      (l.contacts || []).forEach(function (c) {
        if (!isIsoDate(c.nextFollowUp) || c.stage === "Not interested") return;
        out.push({ lead: l, contact: c, days: diffDays(c.nextFollowUp, today) });
      });
    });
    out.sort(function (a, b) {
      if (a.days !== b.days) return a.days - b.days;
      return a.lead.company.localeCompare(b.lead.company);
    });
    return out;
  }

  function dueNowCount() {
    return allFollowUps().filter(function (f) { return f.days <= 0; }).length;
  }

  function leadDueCount(l) {
    var today = todayStr();
    if (DEAD_STATUSES.indexOf(l.status) !== -1) return 0;
    return (l.contacts || []).filter(function (c) {
      return isIsoDate(c.nextFollowUp) && c.stage !== "Not interested" && diffDays(c.nextFollowUp, today) <= 0;
    }).length;
  }

  function notContactedCount() {
    var n = 0;
    state.leads.forEach(function (l) {
      if (DEAD_STATUSES.indexOf(l.status) !== -1) return;
      (l.contacts || []).forEach(function (c) { if (!c.stage || c.stage === "Not contacted") n++; });
    });
    return n;
  }

  function dueLabel(days) {
    if (days < 0) return "Overdue " + (-days) + "d";
    if (days === 0) return "Due today";
    if (days === 1) return "Tomorrow";
    return "In " + days + "d";
  }

  function dueClass(days) {
    return days < 0 ? "due-overdue" : days === 0 ? "due-today" : "due-soon";
  }

  // Which stage would logging this touch move the contact to? "" = leave as is (never moves backward).
  function suggestStage(type, direction, current) {
    var s = "";
    if (type === "LinkedIn connection") s = direction === "Inbound" ? "Connected" : "Connection sent";
    else if (type === "LinkedIn message" || type === "Email" || type === "Call") s = direction === "Inbound" ? "Replied" : "Message sent";
    else if (type === "Meeting") s = "Meeting booked";
    if (!s) return "";
    var cur = STAGE_RANK[current];
    if (cur === undefined) cur = 0;
    return STAGE_RANK[s] > cur ? s : "";
  }

  // Pull the company's status forward when a contact progresses. Never moves backward and never
  // touches Proposal Sent / Won / Lost / Not a Fit.
  function autoAdvanceLead(l, stage) {
    var target = STAGE_TO_STATUS[stage];
    if (!target) return;
    if (AUTO_ADVANCE_FROM.indexOf(l.status) === -1) return;
    if (STATUSES.indexOf(target) > STATUSES.indexOf(l.status)) {
      l.status = target;
      toast(l.company + " moved to " + target + ".");
    }
  }

  function latestTouchDate(c) {
    var best = "";
    (c.activities || []).forEach(function (a) {
      if (a.type !== "Note" && a.date && a.date > best) best = a.date;
    });
    return best;
  }

  function findCandidate(l, cid) {
    if (!l || !l.candidates) return null;
    for (var i = 0; i < l.candidates.length; i++) if (l.candidates[i].id === cid) return l.candidates[i];
    return null;
  }

  function candidateFunnelCounts(l) {
    var counts = {};
    CANDIDATE_STAGES.forEach(function (s) { counts[s] = 0; });
    (l.candidates || []).forEach(function (c) { if (counts.hasOwnProperty(c.stage)) counts[c.stage]++; });
    return counts;
  }

  function cadenceFollowUp(stage, baseIso) {
    var n = CADENCE_DAYS[stage];
    return n ? addDays(baseIso, n) : "";
  }

  function newActId() {
    return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function setView(v) {
    view = v === "crm" ? "crm" : "leads";
    activityForm = null;
    try { window.history.replaceState(null, "", view === "crm" ? "#crm" : window.location.pathname); } catch (e) { /* ignore */ }
  }

  /* ---------------- rendering ---------------- */

  function renderChip(label, group, value, current) {
    var pressed = current === value ? "true" : "false";
    return '<button class="chip" type="button" aria-pressed="' + pressed + '" data-action="filter" data-group="' + group + '" data-value="' + escapeHtml(value) + '">' + escapeHtml(label) + "</button>";
  }

  function renderStats() {
    var nn = newRolesCount();
    return '' +
      '<div class="stats">' +
        '<div class="stat"><div class="num mono">' + state.leads.length + '</div><div class="lbl">Total leads</div></div>' +
        '<div class="stat' + (nn > 0 ? " stat-highlight" : "") + '"><div class="num mono">' + nn + '</div><div class="lbl">New roles found</div></div>' +
        '<div class="stat"><div class="num mono">' + highPriorityCount() + '</div><div class="lbl">High priority</div></div>' +
        '<div class="stat"><div class="num mono">' + activeOutreachCount() + '</div><div class="lbl">In active outreach</div></div>' +
        '<div class="stat' + (dueNowCount() > 0 ? " stat-highlight" : "") + '"><div class="num mono">' + dueNowCount() + '</div><div class="lbl">Follow-ups due</div></div>' +
      '</div>';
  }

  function renderNewBanner() {
    var nn = newRolesCount();
    if (nn === 0) return "";
    return '' +
      '<div class="new-banner">' +
        '<span class="new-dot pulse"></span>' +
        '<span><strong>' + nn + ' new role' + (nn === 1 ? "" : "s") + '</strong> found since your last visit.</span>' +
        '<button class="btn btn-sm" type="button" style="margin-left:auto" data-action="mark-all-seen">Mark all as seen</button>' +
      '</div>';
  }

  function renderCaptureBar() {
    var roleChips = state.roleTypes.map(function (r) {
      return '<span class="role-chip">' + escapeHtml(r) + (readOnly ? "" : ' <button type="button" data-action="remove-role" data-role="' + escapeHtml(r) + '" aria-label="Stop tracking ' + escapeHtml(r) + '">×</button>') + '</span>';
    }).join("");
    var roleOpts = state.roleTypes.map(function (r) { return '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>'; }).join("");
    return '' +
      '<div class="capture-bar">' +
        '<div class="capture-row">' +
          '<span class="lbl">Tracking</span>' + roleChips +
          (readOnly ? "" : '<input type="text" id="cap-role-name" placeholder="Add a role to track…" style="width:180px"><button class="btn btn-sm" type="button" data-action="add-role">+ Track role</button>') +
        '</div>' +
        (readOnly ? "" : (
        '<div class="capture-row">' +
          '<span class="lbl">Quick add</span>' +
          '<input type="text" id="ql-url" placeholder="Paste a LinkedIn or job-posting URL…" style="flex:1;min-width:220px">' +
          '<input type="text" id="ql-company" placeholder="Company (optional)" style="width:180px">' +
          '<select id="ql-roletype">' + roleOpts + '</select>' +
          '<button class="btn btn-sm btn-primary" type="button" data-action="quick-add">+ Add to Radar</button>' +
        '</div>')) +
        '<p class="help">Paste a link from LinkedIn (or any job board) to capture a lead in one click — it lands in the table below so you or Claude can fill in the rest.</p>' +
      '</div>';
  }

  function renderFollowUps() {
    var all = allFollowUps().filter(function (f) { return f.days <= FOLLOWUP_WINDOW_DAYS; });
    var shown = all.slice(0, 8);
    var body;
    if (shown.length) {
      body = shown.map(function (f) {
        var c = f.contact;
        var who = c.name || "(unnamed contact)";
        return '' +
          '<div class="fu-card ' + dueClass(f.days) + '" data-action="goto-lead" data-id="' + f.lead.id + '">' +
            '<span class="due-badge ' + dueClass(f.days) + '">' + dueLabel(f.days) + '</span>' +
            '<div class="pc-main"><div class="nm">' + escapeHtml(who) + ' <span class="fu-co">· ' + escapeHtml(f.lead.company) + '</span></div>' +
            '<div class="rt">' + escapeHtml(c.title || "") + (c.title ? " · " : "") + escapeHtml(c.stage || "Not contacted") + ' · follow up ' + fmtDate(c.nextFollowUp) + '</div></div>' +
            (readOnly ? "" : '<button class="btn btn-sm" type="button" data-action="followup-log" data-id="' + f.lead.id + '" data-cid="' + c.id + '">Log activity</button>') +
          '</div>';
      }).join("");
      if (all.length > shown.length) body += '<div class="help">+ ' + (all.length - shown.length) + ' more in the next ' + FOLLOWUP_WINDOW_DAYS + ' days — open a company to see them.</div>';
    } else {
      var nc = notContactedCount();
      body = '<div class="priority-empty">Nothing due in the next ' + FOLLOWUP_WINDOW_DAYS + ' days. Log an activity on a contact and set a next follow-up date to see it here.' +
        (nc > 0 ? ' ' + nc + ' saved contact' + (nc === 1 ? " hasn't" : "s haven't") + ' been contacted yet.' : '') + '</div>';
    }
    return '<div class="priorities followups"><h3>Follow-ups due <button class="btn-link" type="button" data-action="set-view" data-view="crm" style="margin-left:8px">Open CRM →</button></h3><div class="priority-list">' + body + '</div></div>';
  }

  function renderPriorities() {
    var items = priorityLeads();
    var body = items.length ? items.map(function (l) {
      return '' +
        '<button type="button" class="priority-card" data-action="goto-lead" data-id="' + l.id + '">' +
          '<span class="pill ' + priorityClass(l.priority) + '">' + l.priority + '</span>' +
          '<div class="pc-main"><div class="nm">' + escapeHtml(l.company) + (l.isNew ? ' <span class="newtag" style="margin-left:6px">NEW</span>' : '') + '</div><div class="rt">' + escapeHtml(l.roleType) + ' · ' + escapeHtml(l.jobTitle) + '</div></div>' +
          '<span class="pill status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status) + '</span>' +
        '</button>';
    }).join("") : '<div class="priority-empty">Nothing urgent right now — all high-signal leads are either contacted or resolved.</div>';
    return '<div class="priorities"><h3>Top priorities</h3><div class="priority-list">' + body + '</div></div>';
  }

  function renderFilters() {
    var roleChips = renderChip("All roles", "roleType", "All", filters.roleType) +
      state.roleTypes.map(function (r) { return renderChip(r, "roleType", r, filters.roleType); }).join("");
    var statusOpts = '<option value="All"' + (filters.status === "All" ? " selected" : "") + '>All statuses</option>' +
      STATUSES.map(function (s) { return '<option value="' + escapeHtml(s) + '"' + (filters.status === s ? " selected" : "") + '>' + escapeHtml(s) + '</option>'; }).join("");
    var prioChips = renderChip("All priority", "priority", "All", filters.priority) +
      PRIORITIES.map(function (p) { return renderChip(p, "priority", p, filters.priority); }).join("");
    return '' +
      '<div class="filters">' +
        '<div class="chipset">' + roleChips + '</div>' +
        '<div class="chipset">' + prioChips + '</div>' +
        '<select class="mini" data-action="filter-status" aria-label="Filter by outreach status">' + statusOpts + '</select>' +
        '<div class="search">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
          '<input type="text" placeholder="Search company or skill" value="' + escapeHtml(filters.q) + '" data-action="search">' +
        '</div>' +
      '</div>';
  }

  function dueBadgeFor(c) {
    if (!isIsoDate(c.nextFollowUp) || c.stage === "Not interested") return "";
    var days = diffDays(c.nextFollowUp, todayStr());
    if (days > FOLLOWUP_WINDOW_DAYS) return "";
    return '<span class="due-badge ' + dueClass(days) + '">' + dueLabel(days) + '</span>';
  }

  function renderActivity(l, c, a) {
    var inbound = a.direction === "Inbound";
    return '' +
      '<div class="activity">' +
        '<div class="act-top">' +
          '<span class="act-type">' + escapeHtml(a.type) + '</span>' +
          (a.type === "Note" ? "" : '<span class="act-dir ' + (inbound ? "act-in" : "act-out") + '">' + (inbound ? "↙ In" : "↗ Out") + '</span>') +
          '<span class="act-date">' + fmtDate(a.date) + '</span>' +
          (readOnly ? "" : '<button type="button" class="act-del" data-action="remove-activity" data-id="' + l.id + '" data-cid="' + c.id + '" data-aid="' + escapeHtml(a.id) + '" aria-label="Delete activity">✕</button>') +
        '</div>' +
        (a.summary ? '<div class="act-sum">' + escapeHtml(a.summary) + '</div>' : '') +
      '</div>';
  }

  function renderActivityForm(l, c) {
    var f = activityForm;
    function af(field) { return 'data-action="af-field" data-field="' + field + '"'; }
    var typeOpts = ACTIVITY_TYPES.map(function (t) { return '<option value="' + t + '"' + (f.type === t ? " selected" : "") + '>' + t + '</option>'; }).join("");
    var dirOpts = ["Outbound", "Inbound"].map(function (t) { return '<option value="' + t + '"' + (f.direction === t ? " selected" : "") + '>' + t + '</option>'; }).join("");
    var stageOpts = '<option value=""' + (!f.moveStage ? " selected" : "") + '>Keep: ' + escapeHtml(c.stage || "Not contacted") + '</option>' +
      CONTACT_STAGES.filter(function (s) { return s !== (c.stage || "Not contacted"); }).map(function (s) {
        return '<option value="' + s + '"' + (f.moveStage === s ? " selected" : "") + '>' + s + '</option>';
      }).join("");
    return '' +
      '<div class="activity-form">' +
        '<div class="af-grid">' +
          '<div><label>What happened</label><select ' + af("type") + '>' + typeOpts + '</select></div>' +
          '<div><label>Direction</label><select ' + af("direction") + '>' + dirOpts + '</select></div>' +
          '<div><label>Date</label><input type="date" value="' + escapeHtml(f.date) + '" ' + af("date") + '></div>' +
        '</div>' +
        '<div><label>Summary</label><textarea placeholder="e.g. Sent connection request with the nearshore intro note" ' + af("summary") + '>' + escapeHtml(f.summary) + '</textarea></div>' +
        '<div class="af-grid af-grid-2">' +
          '<div><label>Move contact to stage</label><select ' + af("moveStage") + '>' + stageOpts + '</select></div>' +
          '<div><label>Next follow-up</label><input type="date" value="' + escapeHtml(f.followUp) + '" ' + af("followUp") + '></div>' +
        '</div>' +
        '<div class="af-quick"><span>Follow up in</span>' +
          '<button type="button" class="chip" data-action="af-followup-quick" data-days="3">3 days</button>' +
          '<button type="button" class="chip" data-action="af-followup-quick" data-days="7">1 week</button>' +
          '<button type="button" class="chip" data-action="af-followup-quick" data-days="14">2 weeks</button>' +
          '<button type="button" class="chip" data-action="af-followup-quick" data-days="">No follow-up</button>' +
          (f.followUp && !f.followTouched ? '<span class="af-hint">Suggested from the stage cadence</span>' : '') +
        '</div>' +
        '<div class="row-actions">' +
          '<button type="button" class="btn btn-sm" data-action="cancel-activity">Cancel</button>' +
          '<button type="button" class="btn btn-sm btn-primary" data-action="submit-activity" data-id="' + l.id + '" data-cid="' + c.id + '">Save activity</button>' +
        '</div>' +
      '</div>';
  }

  function renderContactCard(l, c) {
    var d = readOnly ? " disabled" : "";
    var stage = c.stage || "Not contacted";
    var rolesPills = CONTACT_ROLES.map(function (r) {
      var active = c.roles && c.roles.indexOf(r) !== -1;
      return '<button type="button" class="role-pill' + (active ? ' active' : '') + '" data-action="toggle-contact-role" data-id="' + l.id + '" data-cid="' + c.id + '" data-role="' + r + '"' + d + '>' + r + '</button>';
    }).join("");
    var formOpen = view === "leads" && activityForm && activityForm.leadId === l.id && activityForm.cid === c.id;
    var acts = (c.activities || []).map(function (a, i) { return { a: a, i: i }; }).sort(function (x, y) {
      var dc = (y.a.date || "").localeCompare(x.a.date || "");
      return dc !== 0 ? dc : y.i - x.i;
    });
    var timeline = acts.length
      ? '<div class="activity-list">' + acts.map(function (x) { return renderActivity(l, c, x.a); }).join("") + '</div>'
      : '<div class="act-empty">No activity logged yet.</div>';
    var linkedinOk = /^https?:\/\//.test(c.linkedin || "");
    return '' +
      '<div class="contact-card">' +
        '<div class="contact-head">' +
          '<div class="avatar">' + escapeHtml(initialsOf(c.name)) + '</div>' +
          '<div class="ct-name-wrap"><input class="ct-name-input" type="text" value="' + escapeHtml(c.name) + '" placeholder="Contact name" data-action="edit-contact" data-field="name" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<select class="mini ct-stage" data-action="set-contact-stage" data-id="' + l.id + '" data-cid="' + c.id + '" aria-label="Outreach stage"' + d + '>' +
            CONTACT_STAGES.map(function (s) { return '<option value="' + s + '"' + (stage === s ? " selected" : "") + '>' + s + '</option>'; }).join("") +
          '</select>' +
          (readOnly ? "" : '<button class="btn btn-ghost btn-sm" type="button" data-action="remove-contact" data-id="' + l.id + '" data-cid="' + c.id + '" aria-label="Remove contact">✕</button>') +
        '</div>' +
        '<div class="ct-crm">' +
          '<div class="ct-meta">' +
            '<span>Last contacted: <strong>' + (c.lastContacted ? fmtDate(c.lastContacted) : "never") + '</strong></span>' +
            '<label>Next follow-up <input type="date" value="' + escapeHtml(c.nextFollowUp || "") + '" data-action="set-followup" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></label>' +
            dueBadgeFor(c) +
            (linkedinOk ? '<a href="' + escapeHtml(c.linkedin) + '" target="_blank" rel="noopener">LinkedIn ↗</a>' : '') +
          '</div>' +
          (formOpen ? renderActivityForm(l, c) : (readOnly ? "" : '<div><button class="btn btn-sm" type="button" data-action="open-activity-form" data-id="' + l.id + '" data-cid="' + c.id + '">+ Log activity</button></div>')) +
          timeline +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Title</label><input type="text" value="' + escapeHtml(c.title) + '" data-action="edit-contact" data-field="title" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<div><label>Phone</label><input type="text" value="' + escapeHtml(c.phone) + '" data-action="edit-contact" data-field="phone" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Email</label><input type="email" value="' + escapeHtml(c.email) + '" data-action="edit-contact" data-field="email" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<div><label>LinkedIn</label><input type="text" value="' + escapeHtml(c.linkedin) + '" data-action="edit-contact" data-field="linkedin" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
        '</div>' +
        '<div class="role-pills">' + rolesPills + '</div>' +
      '</div>';
  }

  function renderContactsPanel(l) {
    var body = l.contacts.length ? l.contacts.map(function (c) { return renderContactCard(l, c); }).join("") : '<p style="color:var(--ink-soft);margin:4px 0">No contacts yet.</p>';
    return '<h4>Contacts</h4>' + body + (readOnly ? "" : '<button class="btn btn-sm" type="button" data-action="add-contact" data-id="' + l.id + '">+ Add contact</button>');
  }

  function renderClientInfoPanel(l) {
    var d = readOnly ? " disabled" : "";
    return '' +
      '<h4>Client info</h4>' +
      '<div class="field-row">' +
        '<div><label>Billing address</label><input type="text" id="ci-address-' + l.id + '" value="' + escapeHtml(l.clientInfo.address) + '"' + d + '></div>' +
        '<div><label>Phone</label><input type="text" id="ci-phone-' + l.id + '" value="' + escapeHtml(l.clientInfo.phone) + '"' + d + '></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div><label>Tax ID</label><input type="text" id="ci-taxid-' + l.id + '" value="' + escapeHtml(l.clientInfo.taxId) + '"' + d + '></div>' +
        '<div><label>Currency</label><input type="text" id="ci-currency-' + l.id + '" value="' + escapeHtml(l.clientInfo.currency) + '"' + d + '></div>' +
      '</div>' +
      (readOnly ? "" : '<div class="row-actions"><button class="btn btn-sm" type="button" data-action="save-client-info" data-id="' + l.id + '">Save client info</button></div>');
  }

  function renderDocumentsPanel(l) {
    var docsHtml = l.documents.length ? l.documents.map(function (doc) {
      return '<div class="doc-item"><span>' + escapeHtml(doc.name) + '</span>' + (readOnly ? "" : '<button type="button" data-action="remove-document" data-id="' + l.id + '" data-did="' + doc.id + '" aria-label="Remove document">✕</button>') + '</div>';
    }).join("") : '<p style="color:var(--ink-soft);margin:4px 0">No documents logged yet.</p>';
    return '<h4>Documents</h4><div>' + docsHtml + '</div>' +
      (readOnly ? "" : '<div class="add-note"><input type="text" id="doc-input-' + l.id + '" placeholder="Document name, e.g. SOW pertains to client" style="flex:1;border:1px solid var(--ink);background:var(--paper);color:var(--ink);border-radius:8px;padding:6px 9px;font-size:.8rem;font-family:inherit;"><button class="btn btn-sm" type="button" data-action="add-document" data-id="' + l.id + '">Add</button></div>');
  }

  function renderContractorPanel(l, c) {
    var d = readOnly ? " disabled" : "";
    var k = c.contractor;
    var docsHtml = (c.documents || []).length ? c.documents.map(function (doc) {
      return '<div class="doc-item"><span>' + escapeHtml(doc.name) + '</span>' + (readOnly ? "" : '<button type="button" data-action="remove-candidate-document" data-id="' + l.id + '" data-cid="' + c.id + '" data-did="' + doc.id + '" aria-label="Remove document">✕</button>') + '</div>';
    }).join("") : '<p style="color:var(--ink-soft);margin:4px 0">No documents logged yet.</p>';
    function f(field) { return 'data-action="edit-candidate-field" data-field="' + field + '" data-id="' + l.id + '" data-cid="' + c.id + '"' + d; }
    function opts(list, current) {
      return list.map(function (v) { return '<option value="' + v + '"' + (current === v ? " selected" : "") + '>' + (v || "—") + '</option>'; }).join("");
    }
    return '' +
      '<div class="contractor-panel">' +
        '<h5>Contractor onboarding</h5>' +
        '<div class="field-row">' +
          '<div><label>First name</label><input type="text" value="' + escapeHtml(k.firstName) + '" ' + f("contractor.firstName") + '></div>' +
          '<div><label>Middle name</label><input type="text" value="' + escapeHtml(k.middleName) + '" ' + f("contractor.middleName") + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Last name</label><input type="text" value="' + escapeHtml(k.lastName) + '" ' + f("contractor.lastName") + '></div>' +
          '<div><label>Gender</label><select ' + f("contractor.gender") + '>' + opts(["", "Male", "Female", "Other", "Prefer not to say"], k.gender) + '</select></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Pay method</label><select ' + f("contractor.payMethod") + '>' + opts(["", "Revolut", "Wise", "Bank transfer", "PayPal", "Payoneer"], k.payMethod) + '</select></div>' +
          '<div><label>Job title</label><input type="text" value="' + escapeHtml(k.jobTitle) + '" ' + f("contractor.jobTitle") + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="full" style="grid-column:1/-1"><label>Payment reference template</label><input type="text" placeholder="Leave empty for default" value="' + escapeHtml(k.paymentRefTemplate) + '" ' + f("contractor.paymentRefTemplate") + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="full" style="grid-column:1/-1"><label>Main task</label><input type="text" value="' + escapeHtml(k.mainTask) + '" ' + f("contractor.mainTask") + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Company name</label><input type="text" value="' + escapeHtml(k.companyName) + '" ' + f("contractor.companyName") + '></div>' +
          '<div><label>Company Tax ID</label><input type="text" value="' + escapeHtml(k.companyTaxId) + '" ' + f("contractor.companyTaxId") + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Company address</label><input type="text" value="' + escapeHtml(k.companyAddress) + '" ' + f("contractor.companyAddress") + '></div>' +
          '<div><label>Company type</label><select ' + f("contractor.companyType") + '>' + opts(["", "Self employed", "LLC", "Corporation", "Freelancer"], k.companyType) + '</select></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Birthdate</label><input type="date" value="' + escapeHtml(k.birthdate) + '" ' + f("contractor.birthdate") + '></div>' +
          '<div><label>Start date</label><input type="date" value="' + escapeHtml(k.startDate) + '" ' + f("contractor.startDate") + '></div>' +
        '</div>' +
        '<h5>Contractor documents</h5>' +
        '<div>' + docsHtml + '</div>' +
        (readOnly ? "" : '<div class="add-note"><input type="text" id="cdoc-input-' + l.id + '-' + c.id + '" placeholder="Document name, e.g. SOW pertains to contractor" style="flex:1;border:1px solid var(--ink);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 9px;font-size:.8rem;font-family:inherit;"><button class="btn btn-sm" type="button" data-action="add-candidate-document" data-id="' + l.id + '" data-cid="' + c.id + '">Add</button></div>') +
      '</div>';
  }

  function renderCandidateCard(l, c) {
    var d = readOnly ? " disabled" : "";
    var isPlaced = c.stage === "Placed";
    var notesHtml = (c.notes || []).slice().reverse().map(function (n) {
      return '<div class="note"><div class="d">' + fmtDate(n.date) + '</div>' + escapeHtml(n.text) + '</div>';
    }).join("") || '<div class="note" style="color:var(--ink-soft)">No messages logged yet.</div>';
    return '' +
      '<div class="candidate-card">' +
        '<div class="contact-head">' +
          '<div class="avatar">' + escapeHtml(initialsOf(c.name)) + '</div>' +
          '<div class="ct-name-wrap"><input class="ct-name-input" type="text" value="' + escapeHtml(c.name) + '" placeholder="Candidate name" data-action="edit-candidate-field" data-field="name" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<select class="mini" data-action="set-candidate-stage" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '>' +
            CANDIDATE_STAGES.map(function (s) { return '<option value="' + s + '"' + (c.stage === s ? " selected" : "") + '>' + s + '</option>'; }).join("") +
          '</select>' +
          (readOnly ? "" : '<button class="btn btn-ghost btn-sm" type="button" data-action="remove-candidate" data-id="' + l.id + '" data-cid="' + c.id + '" aria-label="Remove candidate">✕</button>') +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Role / title</label><input type="text" value="' + escapeHtml(c.jobTitle) + '" data-action="edit-candidate-field" data-field="jobTitle" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<div><label>LinkedIn</label><input type="text" placeholder="https://linkedin.com/in/…" value="' + escapeHtml(c.linkedin) + '" data-action="edit-candidate-field" data-field="linkedin" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Email</label><input type="email" value="' + escapeHtml(c.email) + '" data-action="edit-candidate-field" data-field="email" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<div><label>Phone</label><input type="text" value="' + escapeHtml(c.phone) + '" data-action="edit-candidate-field" data-field="phone" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Country</label><input type="text" value="' + escapeHtml(c.country) + '" data-action="edit-candidate-field" data-field="country" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<div style="display:flex;align-items:flex-end">' + (c.linkedin ? '<a class="btn btn-sm" href="' + escapeHtml(c.linkedin) + '" target="_blank" rel="noopener">Open LinkedIn ↗</a>' : '') + '</div>' +
        '</div>' +
        '<h5>Messages &amp; notes</h5>' +
        '<div class="notes-list" style="max-height:120px">' + notesHtml + '</div>' +
        (readOnly ? "" : '<div class="add-note"><textarea id="cnote-input-' + l.id + '-' + c.id + '" placeholder="Log a message, call, or reminder…"></textarea><button class="btn btn-sm btn-primary" type="button" data-action="add-candidate-note" data-id="' + l.id + '" data-cid="' + c.id + '">Add</button></div>') +
        (isPlaced ? renderContractorPanel(l, c) : "") +
      '</div>';
  }

  function renderCandidatesPanel(l) {
    var counts = candidateFunnelCounts(l);
    var strip = '<div class="funnel-strip">' + CANDIDATE_STAGES.map(function (s) {
      var n = counts[s];
      var cls = s === "Placed" && n > 0 ? " funnel-good" : (s === "Not Placed" && n > 0 ? " funnel-bad" : "");
      return '<div class="funnel-cell' + cls + '"><div class="funnel-lbl">' + s + '</div><div class="funnel-num mono">' + n + '</div></div>';
    }).join("") + '</div>';
    var cards = (l.candidates || []).length ? l.candidates.map(function (c) { return renderCandidateCard(l, c); }).join("") : '<p style="color:var(--ink-soft)">No candidates in the pipeline for this role yet.</p>';
    return '' +
      '<div class="candidate-pipeline">' +
        '<h4>Candidate pipeline</h4>' +
        strip +
        cards +
        (readOnly ? "" : '<button class="btn btn-sm" type="button" data-action="add-candidate" data-id="' + l.id + '">+ Add candidate</button>') +
      '</div>';
  }

  function renderDetail(l) {
    var primary = l.contacts && l.contacts.length ? l.contacts[0] : null;
    var mailto = primary && primary.email ? '<a href="mailto:' + escapeHtml(primary.email) + '">Email ' + escapeHtml(primary.name || l.company) + ' ↗</a>' : "";
    var notesHtml = l.notes.slice().reverse().map(function (n) {
      return '<div class="note"><div class="d">' + fmtDate(n.date) + '</div>' + escapeHtml(n.text) + '</div>';
    }).join("") || '<div class="note" style="color:var(--ink-soft)">No notes yet.</div>';
    var isWon = l.status === "Won";
    var d = readOnly ? " disabled" : "";

    var grid = '' +
      '<div class="detail">' +
        '<div>' +
          '<h4>Company profile</h4><p>' + escapeHtml(l.companyProfile || "—") + '</p>' +
          '<h4>Required skills</h4><p>' + escapeHtml(l.requiredSkills || "—") + '</p>' +
          '<h4>End client</h4><p>' + escapeHtml(l.endClient || "—") + '</p>' +
          '<h4>Nearshore fit assessment</h4><p>' + escapeHtml(l.nearshoreFit || "—") + '</p>' +
          '<h4>Links</h4>' +
          '<div class="links">' +
            (l.jobUrl ? '<a href="' + escapeHtml(l.jobUrl) + '" target="_blank" rel="noopener">Job posting ↗</a>' : "") +
            (l.website ? '<a href="' + escapeHtml(l.website) + '" target="_blank" rel="noopener">Company site ↗</a>' : "") +
            mailto +
          '</div>' +
          '<p class="help">To reach out, ask Claude in chat — e.g. "Draft outreach to ' + escapeHtml(l.company) + '." Claude will use these notes to write the email and create a Gmail draft for you to review before anything is sent.</p>' +
          (isWon ? renderDocumentsPanel(l) : "") +
        '</div>' +
        '<div>' +
          '<h4>Priority &amp; status</h4>' +
          '<div class="field-row">' +
            '<div><label>Priority tier</label><select data-action="set-priority" data-id="' + l.id + '"' + d + '>' +
              PRIORITIES.map(function (p) { return '<option value="' + p + '"' + (l.priority === p ? " selected" : "") + '>' + p + '</option>'; }).join("") +
            '</select></div>' +
            '<div><label>Outreach status</label><select data-action="set-status" data-id="' + l.id + '"' + d + '>' +
              STATUSES.map(function (s) { return '<option value="' + escapeHtml(s) + '"' + (l.status === s ? " selected" : "") + '>' + escapeHtml(s) + '</option>'; }).join("") +
            '</select></div>' +
          '</div>' +
          renderContactsPanel(l) +
          (isWon ? renderClientInfoPanel(l) : "") +
          '<h4>Company notes</h4>' +
          '<div class="notes-list">' + notesHtml + '</div>' +
          (readOnly ? "" : '<div class="add-note"><textarea id="note-input-' + l.id + '" placeholder="Log a call, reply, or reminder…"></textarea><button class="btn btn-sm btn-primary" type="button" data-action="add-note" data-id="' + l.id + '">Add</button></div>') +
        '</div>' +
      '</div>';

    return grid + (isWon ? renderCandidatesPanel(l) : "");
  }

  function renderRow(l) {
    var expanded = expandedId === l.id;
    var d = daysSince(l.datePosted);
    var rows = '' +
      '<tr class="lead-row" data-expanded="' + expanded + '" data-action="toggle-row" data-id="' + l.id + '">' +
        '<td>' + (l.isNew ? '<span class="newtag">NEW</span>' : '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>') + '</td>' +
        '<td><div class="company-cell"><div><div class="nm">' + escapeHtml(l.company) + (l.status === "Won" ? '<span class="client-badge">Client</span>' : '') + (leadDueCount(l) > 0 ? '<span class="due-badge due-today" style="margin-left:6px">Follow-up due</span>' : '') + '</div><span class="role-tag">' + escapeHtml(l.jobTitle) + '</span></div></div></td>' +
        '<td>' + escapeHtml(l.roleType) + '</td>' +
        '<td><span class="pill ' + priorityClass(l.priority) + '">' + l.priority + '</span></td>' +
        '<td class="mono">' + escapeHtml(l.estSize) + '</td>' +
        '<td><span class="pill status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status) + '</span></td>' +
        '<td class="mono">' + (d === null ? "—" : d + "d") + '</td>' +
      '</tr>';
    if (expanded) {
      rows += '<tr class="detail-row"><td colspan="7">' + renderDetail(l) + '</td></tr>';
    }
    return rows;
  }

  function renderTable() {
    var all = filteredLeads();
    if (all.length === 0) {
      return '<div class="table-wrap"><div class="empty">No leads match these filters.</div></div>';
    }
    var leads = all.slice(0, pageSize);
    var rows = leads.map(renderRow).join("");
    var remaining = all.length - leads.length;
    return '' +
      '<div class="table-wrap"><table>' +
        '<thead><tr>' +
          '<th></th><th>Company</th><th>Role type</th><th>Priority</th><th>Est. size</th><th>Status</th><th>Days live</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      (remaining > 0 ? '<div class="show-more-wrap"><button class="btn" type="button" data-action="show-more">Show more (' + remaining + ' more)</button></div>' : '');
  }

  function renderAddForm() {
    var roleOpts = state.roleTypes.map(function (r) { return '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>'; }).join("");
    var prioOpts = PRIORITIES.map(function (p) { return '<option value="' + p + '"' + (p === "Medium" ? " selected" : "") + '>' + p + '</option>'; }).join("");
    return '' +
      '<div class="panel" id="add-panel" hidden>' +
        '<h3>Add a lead</h3>' +
        '<div class="grid2">' +
          '<div class="field"><label>Company name *</label><input type="text" id="af-company"></div>' +
          '<div class="field"><label>Website</label><input type="text" id="af-website" placeholder="https://…"></div>' +
          '<div class="field"><label>Role type *</label><select id="af-roletype">' + roleOpts + '</select></div>' +
          '<div class="field"><label>Job title / signal *</label><input type="text" id="af-jobtitle"></div>' +
          '<div class="field"><label>Job posting URL</label><input type="text" id="af-joburl" placeholder="https://…"></div>' +
          '<div class="field"><label>Date posted</label><input type="date" id="af-dateposted"></div>' +
          '<div class="field"><label>Employment type</label><input type="text" id="af-emptype" placeholder="Full-time, Remote"></div>' +
          '<div class="field"><label>Est. company size</label><input type="text" id="af-size" placeholder="~50-100"></div>' +
          '<div class="field"><label>Priority tier</label><select id="af-priority">' + prioOpts + '</select></div>' +
          '<div class="field"><label>End client (if any)</label><input type="text" id="af-endclient"></div>' +
          '<div class="field full"><label>Company profile</label><textarea id="af-profile"></textarea></div>' +
          '<div class="field full"><label>Required skills</label><textarea id="af-skills"></textarea></div>' +
          '<div class="field full"><label>Nearshore fit assessment</label><textarea id="af-fit"></textarea></div>' +
        '</div>' +
        '<div class="panel-actions">' +
          '<button class="btn" type="button" data-action="cancel-add">Cancel</button>' +
          '<button class="btn btn-primary" type="button" data-action="submit-add">Add lead</button>' +
        '</div>' +
      '</div>';
  }

  function renderViewTabs() {
    var due = dueNowCount();
    function tab(v, label, extra) {
      return '<button type="button" class="viewtab" role="tab" aria-selected="' + (view === v) + '" data-action="set-view" data-view="' + v + '">' + label + (extra || "") + '</button>';
    }
    return '<div class="viewtabs" role="tablist">' + tab("leads", "Leads") + tab("crm", "CRM", due > 0 ? ' <span class="tab-count">' + due + '</span>' : "") + '</div>';
  }

  function crmContacts() {
    var q = crmQuery.trim().toLowerCase();
    var out = [];
    state.leads.forEach(function (l) {
      if (DEAD_STATUSES.indexOf(l.status) !== -1) return;
      (l.contacts || []).forEach(function (c) {
        if (q && ((c.name || "") + " " + (c.title || "") + " " + l.company).toLowerCase().indexOf(q) === -1) return;
        out.push({ lead: l, contact: c, stage: c.stage || "Not contacted" });
      });
    });
    return out;
  }

  function renderActionRow(lead, c, badge, logLabel) {
    var who = c.name || "(unnamed contact)";
    return '' +
      '<div class="ar">' +
        '<div class="ar-main"><div class="nm">' + escapeHtml(who) + '</div>' +
        '<div class="rt">' + escapeHtml(lead.company) + ' · ' + escapeHtml(c.stage || "Not contacted") + (c.lastContacted ? ' · last touch ' + fmtDate(c.lastContacted) : '') + '</div></div>' +
        badge +
        (readOnly ? "" : '<button class="btn btn-sm btn-primary" type="button" data-action="crm-log" data-id="' + lead.id + '" data-cid="' + c.id + '">' + logLabel + '</button>') +
        '<button class="btn btn-sm" type="button" data-action="goto-lead" data-id="' + lead.id + '">Open</button>' +
      '</div>';
  }

  function renderActionGroup(title, cls, rows, total, emptyText) {
    return '' +
      '<div class="ag ' + cls + '">' +
        '<div class="ag-head"><h4>' + title + '</h4><span class="mono">' + total + '</span></div>' +
        (rows.length ? rows.join("") : '<div class="ag-empty">' + emptyText + '</div>') +
      '</div>';
  }

  function renderBoardCard(l, c) {
    var who = c.name || "(unnamed contact)";
    var stage = c.stage || "Not contacted";
    var badge = dueBadgeFor(c) || (isIsoDate(c.nextFollowUp) && stage !== "Not interested" ? '<span class="kb-next">Next ' + fmtDate(c.nextFollowUp) + '</span>' : "");
    return '' +
      '<div class="kb-card"' + (readOnly ? "" : ' draggable="true" data-drag="' + l.id + '|' + c.id + '"') + '>' +
        '<div class="kb-name">' + escapeHtml(who) + '</div>' +
        '<div class="kb-co">' + escapeHtml(l.company) + (c.title ? ' · ' + escapeHtml(c.title) : '') + '</div>' +
        '<div class="kb-meta">' + (c.lastContacted ? 'Last ' + fmtDate(c.lastContacted) : 'No contact yet') + (badge ? ' ' + badge : '') + '</div>' +
        '<div class="kb-actions">' +
          (readOnly ? "" : '<button class="btn btn-sm" type="button" data-action="crm-log" data-id="' + l.id + '" data-cid="' + c.id + '">Log</button>') +
          '<button class="btn btn-sm" type="button" data-action="goto-lead" data-id="' + l.id + '">Open</button>' +
          (readOnly ? "" : '<select class="mini kb-move" data-action="set-contact-stage" data-id="' + l.id + '" data-cid="' + c.id + '" aria-label="Move ' + escapeHtml(who) + ' to stage">' +
            BOARD_STAGES.map(function (s) { return '<option value="' + s + '"' + (stage === s ? " selected" : "") + '>' + s + '</option>'; }).join("") + '</select>') +
        '</div>' +
      '</div>';
  }

  function renderBoard(items) {
    var cols = BOARD_STAGES.map(function (stage) {
      var cards = items.filter(function (i) { return i.stage === stage; }).sort(function (a, b) {
        var fa = isIsoDate(a.contact.nextFollowUp) ? a.contact.nextFollowUp : "9999-12-31";
        var fb = isIsoDate(b.contact.nextFollowUp) ? b.contact.nextFollowUp : "9999-12-31";
        if (fa !== fb) return fa.localeCompare(fb);
        return (a.contact.name || "").localeCompare(b.contact.name || "");
      });
      return '' +
        '<div class="board-col" data-stage="' + stage + '">' +
          '<div class="board-head"><span>' + stage + '</span><span class="mono">' + cards.length + '</span></div>' +
          '<div class="board-body">' + (cards.length ? cards.map(function (i) { return renderBoardCard(i.lead, i.contact); }).join("") : '<div class="board-empty">' + (readOnly ? "—" : "Drop a contact here") + '</div>') + '</div>' +
        '</div>';
    }).join("");
    return '<div class="board">' + cols + '</div>';
  }

  function renderRecentActivity() {
    var all = [];
    state.leads.forEach(function (l) {
      (l.contacts || []).forEach(function (c) {
        (c.activities || []).forEach(function (a, i) { all.push({ lead: l, contact: c, a: a, i: i }); });
      });
    });
    all.sort(function (x, y) {
      var dc = (y.a.date || "").localeCompare(x.a.date || "");
      return dc !== 0 ? dc : y.i - x.i;
    });
    var rows = all.slice(0, 10).map(function (r) {
      var inbound = r.a.direction === "Inbound";
      return '' +
        '<div class="ra" data-action="goto-lead" data-id="' + r.lead.id + '">' +
          '<span class="ra-date">' + fmtDate(r.a.date) + '</span>' +
          '<span class="ra-main"><strong>' + escapeHtml(r.contact.name || "(unnamed contact)") + '</strong> · ' + escapeHtml(r.lead.company) +
            ' — ' + escapeHtml(r.a.type) + (r.a.type === "Note" ? "" : (inbound ? " ↙ in" : " ↗ out")) +
            (r.a.summary ? ': ' + escapeHtml(r.a.summary.length > 110 ? r.a.summary.slice(0, 107) + "…" : r.a.summary) : '') + '</span>' +
        '</div>';
    }).join("");
    return '<div class="crm-section"><h3>Recent communication</h3>' + (rows || '<div class="ag-empty">Nothing logged yet. Use "Log" on any contact to record a LinkedIn message, email, call or meeting.</div>') + '</div>';
  }

  function renderCrm() {
    var items = crmContacts();
    var today = todayStr();
    var scheduled = items.filter(function (i) { return isIsoDate(i.contact.nextFollowUp) && i.stage !== "Not interested"; }).map(function (i) {
      return { lead: i.lead, contact: i.contact, days: diffDays(i.contact.nextFollowUp, today) };
    }).sort(function (a, b) { return a.days - b.days || a.lead.company.localeCompare(b.lead.company); });
    var overdue = scheduled.filter(function (x) { return x.days < 0; });
    var dueToday = scheduled.filter(function (x) { return x.days === 0; });
    var week = scheduled.filter(function (x) { return x.days >= 1 && x.days <= FOLLOWUP_WINDOW_DAYS; });
    var start = items.filter(function (i) { return i.stage === "Not contacted" && !isIsoDate(i.contact.nextFollowUp); }).sort(function (a, b) {
      return priorityRank(a.lead.priority) - priorityRank(b.lead.priority) || a.lead.company.localeCompare(b.lead.company);
    });
    var inConversation = items.filter(function (i) { return i.stage === "Replied" || i.stage === "Meeting booked"; }).length;

    function rowsFor(list, limit, logLabel) {
      return list.slice(0, limit).map(function (x) {
        return renderActionRow(x.lead, x.contact, '<span class="due-badge ' + dueClass(x.days) + '">' + dueLabel(x.days) + '</span>', logLabel);
      });
    }
    var startRows = start.slice(0, 6).map(function (i) {
      return renderActionRow(i.lead, i.contact, '<span class="due-badge due-soon">Not started</span>', "Start");
    });

    var stats = '' +
      '<div class="stats">' +
        '<div class="stat"><div class="num mono">' + items.length + '</div><div class="lbl">Contacts</div></div>' +
        '<div class="stat"><div class="num mono">' + items.filter(function (i) { return i.stage === "Not contacted"; }).length + '</div><div class="lbl">Not contacted yet</div></div>' +
        '<div class="stat"><div class="num mono">' + inConversation + '</div><div class="lbl">In conversation</div></div>' +
        '<div class="stat' + (overdue.length + dueToday.length > 0 ? " stat-highlight" : "") + '"><div class="num mono">' + (overdue.length + dueToday.length) + '</div><div class="lbl">Contact now</div></div>' +
      '</div>';

    var cadenceText = Object.keys(CADENCE_DAYS).map(function (k) { return k + " → " + CADENCE_DAYS[k] + "d"; }).join(" · ");

    return '' +
      stats +
      '<div class="crm-toolbar">' +
        '<div class="search crm-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
        '<input type="text" placeholder="Search contact or company" value="' + escapeHtml(crmQuery) + '" data-action="crm-search"></div>' +
      '</div>' +
      '<div class="crm-section"><h3>Who to contact</h3>' +
        '<div class="crm-actions">' +
          renderActionGroup("Overdue", "ag-overdue", rowsFor(overdue, 6, "Log"), overdue.length, "Nothing overdue.") +
          renderActionGroup("Today", "ag-today", rowsFor(dueToday, 6, "Log"), dueToday.length, "Nothing due today.") +
          renderActionGroup("Next 7 days", "ag-week", rowsFor(week, 6, "Log"), week.length, "Nothing scheduled this week.") +
          renderActionGroup("Start outreach", "ag-start", startRows, start.length, "Every saved contact has been reached out to.") +
        '</div>' +
        '<p class="help">Follow-up dates are suggested from the stage when you log activity or move a contact: ' + escapeHtml(cadenceText) + '. You can always change a date.</p>' +
      '</div>' +
      '<div class="crm-section"><h3>Pipeline</h3>' + renderBoard(items) +
        '<p class="help">' + (readOnly ? "" : "Drag a card to a new column, or use its menu, to move a contact. ") + 'Contacts at companies marked Lost or Not a Fit are hidden.</p></div>' +
      renderRecentActivity();
  }

  function renderCrmModal() {
    if (!activityForm) return "";
    var l = findLead(activityForm.leadId);
    var c = findContact(l, activityForm.cid);
    if (!c) return "";
    return '' +
      '<div class="modal-backdrop" data-action="modal-backdrop">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="Log activity">' +
          '<h3>Log activity</h3>' +
          '<p class="help" style="margin:0 0 10px">' + escapeHtml(c.name || "(unnamed contact)") + ' · ' + escapeHtml(l.company) + ' · currently <strong>' + escapeHtml(c.stage || "Not contacted") + '</strong></p>' +
          renderActivityForm(l, c) +
        '</div>' +
      '</div>';
  }

  function render() {
    var html = '' +
      '<div class="topbar">' +
        '<div class="brand">' +
          '<img class="brand-logo" src="/img/nimbl-logo.png" alt="nimbl.ai" width="901" height="214">' +
          '<div><h1>Radar</h1><div class="tag">Nearshore LATAM staffing · lead CRM</div></div>' +
        '</div>' +
        '<div class="topbar-right">' +
          (currentUser ?
            '<div class="user-chip" title="' + escapeHtml(currentUser.email) + '">' +
              (currentUser.photo ? '<img src="' + escapeHtml(currentUser.photo) + '" alt="">' : '') +
              '<span>' + escapeHtml(currentUser.name || currentUser.email) + '</span>' +
              '<button class="btn-link" type="button" data-action="logout">Log out</button>' +
            '</div>' : '') +
          '<div class="scan-meta" title="A scan for new roles runs automatically every day">Last scanned<br><span class="mono">' + fmtDate(state.lastScanned) + '</span></div>' +
          '<button class="btn" type="button" data-action="refresh-scan" title="Load the newest leads from the daily scan">↻ Refresh</button>' +
          (readOnly ? "" : '<button class="btn btn-primary" type="button" data-action="open-add">+ Add lead</button>') +
        '</div>' +
      '</div>' +
      (readOnly ? '<div class="readonly-note">This view is read-only — open the artifact in claude.ai as its owner to edit statuses, notes, and contacts.</div>' : '') +
      renderViewTabs() +
      (view === "crm" ? renderCrm() : (
      renderNewBanner() +
      renderStats() +
      renderFollowUps() +
      renderCaptureBar() +
      renderPriorities() +
      renderAddForm() +
      renderFilters() +
      renderTable() +
      '<p class="help" style="margin-top:14px">New roles are found automatically by a daily scan and appear here with the NEW tag — use ↻ Refresh to load the latest. To change which roles are searched, edit the Tracking list above.</p>'
      )) +
      (view === "crm" ? renderCrmModal() : "");
    document.getElementById("app").innerHTML = html;
  }

  /* ---------------- persistence ---------------- */


  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  // Saving works like this: every edit marks the data "dirty" and schedules a save. Only ONE save is
  // ever in flight; edits made while it is running are sent in the next save, and an older server
  // response is never allowed to overwrite newer edits that are still on screen.
  var saveTimer = null;
  var saveInFlight = false;
  var dirty = false;
  var pendingSave = false; // true while there are unsaved edits or a save is running

  function userIsEditing() {
    var a = document.activeElement;
    var app = document.getElementById("app");
    return !!(a && app && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  // opts.noRender: the screen already shows the change (e.g. a text box the user just typed in),
  // so don't rebuild the page — that would steal focus and swallow the click they're about to make.
  function persist(opts) {
    if (!(opts && opts.noRender)) render();
    if (readOnly) { toast("Read-only view — changes aren't saved."); return; }
    dirty = true;
    pendingSave = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }

  function flushSave() {
    if (saveInFlight || !dirty) return;
    dirty = false;
    saveInFlight = true;
    fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (freshState) {
      saveInFlight = false;
      if (dirty) { flushSave(); return; } // newer edits exist: save those next, keep what's on screen
      pendingSave = false;
      state = freshState;
      if (!userIsEditing()) render();
    }).catch(function (err) {
      saveInFlight = false;
      dirty = true; // keep the edits; they go out with the next save
      toast("Couldn't save: " + (err && err.message ? err.message : "unknown error") + ". Retrying…");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSave, 5000);
    });
  }

  /* ---------------- actions ---------------- */

  function setStatus(id, val) {
    var l = findLead(id);
    if (!l) return;
    l.status = val;
    persist();
  }

  function setPriority(id, val) {
    var l = findLead(id);
    if (!l) return;
    l.priority = val;
    persist();
  }

  function addContact(id) {
    var l = findLead(id);
    if (!l) return;
    l.contacts.push({ id: "c" + Date.now().toString(36), name: "", title: "", email: "", phone: "", linkedin: "", roles: [], stage: "Not contacted", nextFollowUp: "", lastContacted: "", activities: [] });
    var newId = l.contacts[l.contacts.length - 1].id;
    persist();
    var box = document.querySelector('.ct-name-input[data-cid="' + newId + '"]');
    if (box) box.focus();
  }

  function removeContact(id, cid) {
    var l = findLead(id);
    if (!l) return;
    l.contacts = l.contacts.filter(function (c) { return c.id !== cid; });
    persist();
  }

  function toggleContactRole(id, cid, role) {
    var l = findLead(id);
    var c = findContact(l, cid);
    if (!c) return;
    if (!c.roles) c.roles = [];
    var idx = c.roles.indexOf(role);
    if (idx === -1) c.roles.push(role); else c.roles.splice(idx, 1);
    persist();
  }

  /* ---- CRM actions ---- */

  function defaultFollowUp(f, c) {
    var existing = c.nextFollowUp || "";
    if (f.type === "Note") return existing;
    var stageAfter = f.moveStage || c.stage || "Not contacted";
    var base = isIsoDate(f.date) ? f.date : todayStr();
    var cadence = cadenceFollowUp(stageAfter, base);
    if (cadence) return cadence;
    // No cadence for this stage (e.g. Meeting booked): drop a stale date, keep a future one.
    return existing && existing > todayStr() ? existing : "";
  }

  function applyFormDefaults(c) {
    var f = activityForm;
    if (!f.stageTouched) f.moveStage = suggestStage(f.type, f.direction, c.stage || "Not contacted");
    if (!f.followTouched) f.followUp = defaultFollowUp(f, c);
  }

  function openActivityForm(id, cid) {
    var l = findLead(id);
    var c = findContact(l, cid);
    if (!c) return;
    var stage = c.stage || "Not contacted";
    activityForm = {
      leadId: id, cid: cid,
      type: stage === "Not contacted" ? "LinkedIn connection" : "LinkedIn message",
      direction: "Outbound", date: todayStr(), summary: "", moveStage: "", followUp: "",
      stageTouched: false, followTouched: false
    };
    applyFormDefaults(c);
  }

  function submitActivity(id, cid) {
    var f = activityForm;
    var l = findLead(id);
    var c = findContact(l, cid);
    if (!f || !c) return;
    if (!c.activities) c.activities = [];
    var date = isIsoDate(f.date) ? f.date : todayStr();
    c.activities.push({
      id: newActId(),
      type: f.type, direction: f.direction, date: date, summary: (f.summary || "").trim()
    });
    c.lastContacted = latestTouchDate(c);
    if (f.moveStage) c.stage = f.moveStage;
    c.nextFollowUp = isIsoDate(f.followUp) ? f.followUp : "";
    if (c.stage === "Not interested") c.nextFollowUp = "";
    activityForm = null;
    autoAdvanceLead(l, c.stage);
    persist();
  }

  function removeActivity(id, cid, aid) {
    var l = findLead(id);
    var c = findContact(l, cid);
    if (!c) return;
    c.activities = (c.activities || []).filter(function (a) { return a.id !== aid; });
    c.lastContacted = latestTouchDate(c);
    persist();
  }

  function setContactStage(id, cid, stage) {
    var l = findLead(id);
    var c = findContact(l, cid);
    if (!c) return;
    var prev = c.stage || "Not contacted";
    if (prev === stage) { render(); return; }
    var today = todayStr();
    c.stage = stage;
    if (stage === "Not interested") {
      c.nextFollowUp = "";
    } else {
      var due = !isIsoDate(c.nextFollowUp) || c.nextFollowUp <= today; // nothing scheduled, or already due
      var cadence = cadenceFollowUp(stage, today);
      if (cadence && due) c.nextFollowUp = cadence;
      else if (!cadence && due) c.nextFollowUp = "";
    }
    if (!c.activities) c.activities = [];
    c.activities.push({ id: newActId(), type: "Note", direction: "Outbound", date: today, summary: "Stage changed: " + prev + " → " + stage });
    autoAdvanceLead(l, stage);
    persist();
  }

  function setFollowUp(id, cid, value) {
    var c = findContact(findLead(id), cid);
    if (!c) return;
    c.nextFollowUp = isIsoDate(value) ? value : "";
    persist();
  }

  function saveClientInfo(id) {
    var l = findLead(id);
    if (!l) return;
    l.clientInfo = {
      address: document.getElementById("ci-address-" + id).value.trim(),
      phone: document.getElementById("ci-phone-" + id).value.trim(),
      taxId: document.getElementById("ci-taxid-" + id).value.trim(),
      currency: document.getElementById("ci-currency-" + id).value.trim() || "USD"
    };
    persist();
    toast("Client info saved.");
  }

  function addDocument(id) {
    var l = findLead(id);
    if (!l) return;
    var el = document.getElementById("doc-input-" + id);
    var name = el.value.trim();
    if (!name) return;
    l.documents.push({ id: "d" + Date.now().toString(36), name: name });
    persist();
  }

  function removeDocument(id, did) {
    var l = findLead(id);
    if (!l) return;
    l.documents = l.documents.filter(function (doc) { return doc.id !== did; });
    persist();
  }

  function addCandidate(id) {
    var l = findLead(id);
    if (!l) return;
    l.candidates.push({
      id: "cd" + Date.now().toString(36), name: "", jobTitle: l.jobTitle || "", linkedin: "", email: "", phone: "", country: "", stage: "Identified",
      notes: [],
      contractor: { firstName: "", middleName: "", lastName: "", gender: "", payMethod: "", jobTitle: "", paymentRefTemplate: "", mainTask: "", companyName: "", companyTaxId: "", companyAddress: "", companyType: "", birthdate: "", startDate: "" },
      documents: []
    });
    persist();
  }

  function removeCandidate(id, cid) {
    var l = findLead(id);
    if (!l) return;
    l.candidates = l.candidates.filter(function (c) { return c.id !== cid; });
    persist();
  }

  function addCandidateNote(id, cid) {
    var l = findLead(id);
    var c = findCandidate(l, cid);
    if (!c) return;
    var el = document.getElementById("cnote-input-" + id + "-" + cid);
    var text = el.value.trim();
    if (!text) return;
    if (!c.notes) c.notes = [];
    c.notes.push({ date: new Date().toISOString().slice(0, 10), text: text });
    persist();
  }

  function addCandidateDocument(id, cid) {
    var l = findLead(id);
    var c = findCandidate(l, cid);
    if (!c) return;
    var el = document.getElementById("cdoc-input-" + id + "-" + cid);
    var name = el.value.trim();
    if (!name) return;
    c.documents.push({ id: "cd" + Date.now().toString(36), name: name });
    persist();
  }

  function removeCandidateDocument(id, cid, did) {
    var l = findLead(id);
    var c = findCandidate(l, cid);
    if (!c) return;
    c.documents = c.documents.filter(function (doc) { return doc.id !== did; });
    persist();
  }

  function addRoleType() {
    var el = document.getElementById("cap-role-name");
    var v = el.value.trim();
    if (!v) return;
    if (state.roleTypes.indexOf(v) !== -1) { toast(v + " is already tracked."); return; }
    state.roleTypes.push(v);
    el.value = "";
    persist();
    toast("Now tracking " + v + ".");
  }

  function removeRoleType(r) {
    var idx = state.roleTypes.indexOf(r);
    if (idx === -1) return;
    state.roleTypes.splice(idx, 1);
    if (filters.roleType === r) filters.roleType = "All";
    persist();
  }

  // Pull the latest leads from the server (the daily scan adds new ones straight to the database).
  // silent=true is the background refresh used when the tab regains focus.
  function refreshData(silent) {
    if (pendingSave) { if (!silent) toast("Saving your changes first — try again in a moment."); return; }
    var before = state.leads.length;
    var beforeNew = newRolesCount();
    fetch("/api/state").then(function (res) {
      if (res.status === 401) { window.location.href = "/auth/login"; return null; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (fresh) {
      if (!fresh || pendingSave) return;
      var typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      var changed = JSON.stringify(fresh) !== JSON.stringify(state);
      if (silent && (typing || activityForm)) return; // don't disturb something being edited
      if (changed) { state = fresh; render(); }
      if (silent) return;
      var added = state.leads.length - before;
      toast(added > 0
        ? added + " new lead" + (added === 1 ? "" : "s") + " since you last looked. Last scan: " + fmtDate(state.lastScanned) + "."
        : "Up to date. Last scan: " + fmtDate(state.lastScanned) + " — new scans run automatically every day.");
    }).catch(function (err) {
      if (!silent) toast("Couldn't refresh: " + (err && err.message ? err.message : "unknown error"));
    });
  }

  function quickAdd() {
    var urlEl = document.getElementById("ql-url");
    var companyEl = document.getElementById("ql-company");
    var url = urlEl.value.trim();
    var company = companyEl.value.trim();
    var roleType = document.getElementById("ql-roletype").value;
    if (!url && !company) { toast("Paste a job URL or enter a company name first."); return; }
    if (!company) {
      try {
        var host = url.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
        var base = host.split(".")[0];
        company = base.charAt(0).toUpperCase() + base.slice(1);
      } catch (e) { company = "New lead"; }
    }
    var id = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Date.now().toString(36);
    var lead = {
      id: id, company: company, website: "", roleType: roleType, jobTitle: "(fill in from posting)",
      jobUrl: url, datePosted: "", dateAdded: new Date().toISOString().slice(0, 10),
      employmentType: "", estSize: "", priority: "Medium", endClient: "", companyProfile: "",
      requiredSkills: "", nearshoreFit: "",
      contacts: [], clientInfo: { address: "", phone: "", taxId: "", currency: "USD" }, documents: [], candidates: [],
      status: "Researching", isNew: false,
      notes: [{ date: new Date().toISOString().slice(0, 10), text: "Quick-added from a LinkedIn/job link. Ask Claude in chat to research and fill in the company details." }]
    };
    state.leads.unshift(lead);
    urlEl.value = "";
    companyEl.value = "";
    filters = { roleType: "All", priority: "All", status: "All", q: "" };
    expandedId = id;
    pageSize = Math.max(pageSize, 1);
    persist();
    toast("Added — ask Claude in chat to research " + company + " and fill in the details.");
  }

  function gotoLead(id) {
    if (view !== "leads") setView("leads");
    filters = { roleType: "All", priority: "All", status: "All", q: "" };
    expandedId = id;
    var idx = filteredLeads().map(function (l) { return l.id; }).indexOf(id);
    if (idx !== -1) pageSize = Math.max(pageSize, idx + 1);
    render();
    var rowEl = document.querySelector('tr[data-id="' + id + '"]');
    if (rowEl && typeof rowEl.scrollIntoView === "function") rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showMore() {
    pageSize += PAGE_SIZE_STEP;
    render();
  }

  function addNote(id) {
    var l = findLead(id);
    if (!l) return;
    var el = document.getElementById("note-input-" + id);
    var text = el.value.trim();
    if (!text) return;
    var today = new Date().toISOString().slice(0, 10);
    l.notes.push({ date: today, text: text });
    persist();
  }

  function markSeen(id) {
    var l = findLead(id);
    if (!l) return;
    l.isNew = false;
    persist();
  }

  function markAllSeen() {
    for (var i = 0; i < state.leads.length; i++) state.leads[i].isNew = false;
    persist();
  }

  function submitAdd() {
    var company = document.getElementById("af-company").value.trim();
    var jobTitle = document.getElementById("af-jobtitle").value.trim();
    if (!company || !jobTitle) { toast("Company name and job title are required."); return; }
    var id = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Date.now().toString(36);
    var lead = {
      id: id,
      company: company,
      website: document.getElementById("af-website").value.trim(),
      roleType: document.getElementById("af-roletype").value,
      jobTitle: jobTitle,
      jobUrl: document.getElementById("af-joburl").value.trim(),
      datePosted: document.getElementById("af-dateposted").value,
      dateAdded: new Date().toISOString().slice(0, 10),
      employmentType: document.getElementById("af-emptype").value.trim(),
      estSize: document.getElementById("af-size").value.trim(),
      priority: document.getElementById("af-priority").value,
      endClient: document.getElementById("af-endclient").value.trim(),
      companyProfile: document.getElementById("af-profile").value.trim(),
      requiredSkills: document.getElementById("af-skills").value.trim(),
      nearshoreFit: document.getElementById("af-fit").value.trim(),
      contacts: [], clientInfo: { address: "", phone: "", taxId: "", currency: "USD" }, documents: [], candidates: [],
      status: "Not Started",
      isNew: false,
      notes: [{ date: new Date().toISOString().slice(0, 10), text: "Added manually via dashboard." }]
    };
    state.leads.unshift(lead);
    var panel = document.getElementById("add-panel");
    if (panel) panel.hidden = true;
    persist();
    toast("Lead added.");
  }

  /* ---------------- events ---------------- */

  document.getElementById("app").addEventListener("click", function (e) {
    var t = e.target.closest("[data-action]");
    if (!t) return;
    var action = t.getAttribute("data-action");
    var id = t.getAttribute("data-id");
    var cid = t.getAttribute("data-cid");

    if (action === "toggle-row") {
      expandedId = expandedId === id ? null : id;
      activityForm = null;
      if (expandedId && findLead(id) && findLead(id).isNew) markSeen(id);
      else render();
      return;
    }
    if (action === "filter") {
      var group = t.getAttribute("data-group");
      filters[group] = t.getAttribute("data-value");
      pageSize = PAGE_SIZE_STEP;
      render();
      return;
    }
    if (action === "goto-lead") { gotoLead(id); return; }
    if (action === "show-more") { showMore(); return; }
    if (action === "mark-all-seen") { markAllSeen(); return; }
    if (action === "add-note") { addNote(id); return; }
    if (action === "add-contact") { addContact(id); return; }
    if (action === "remove-contact") { removeContact(id, cid); return; }
    if (action === "set-view") { setView(t.getAttribute("data-view")); render(); return; }
    if (action === "crm-log") { openActivityForm(id, cid); render(); return; }
    if (action === "modal-backdrop") { if (e.target === t) { activityForm = null; render(); } return; }
    if (action === "open-activity-form") { openActivityForm(id, cid); render(); return; }
    if (action === "cancel-activity") { activityForm = null; render(); return; }
    if (action === "submit-activity") { submitActivity(id, cid); return; }
    if (action === "remove-activity") { removeActivity(id, cid, t.getAttribute("data-aid")); return; }
    if (action === "af-followup-quick") {
      if (activityForm) {
        var n = t.getAttribute("data-days");
        activityForm.followUp = n ? addDays(todayStr(), parseInt(n, 10)) : "";
        activityForm.followTouched = true;
        render();
      }
      return;
    }
    if (action === "followup-log") { openActivityForm(id, cid); gotoLead(id); return; }
    if (action === "toggle-contact-role") { toggleContactRole(id, cid, t.getAttribute("data-role")); return; }
    if (action === "save-client-info") { saveClientInfo(id); return; }
    if (action === "add-document") { addDocument(id); return; }
    if (action === "remove-document") { removeDocument(id, t.getAttribute("data-did")); return; }
    if (action === "add-candidate") { addCandidate(id); return; }
    if (action === "remove-candidate") { removeCandidate(id, cid); return; }
    if (action === "add-candidate-note") { addCandidateNote(id, cid); return; }
    if (action === "add-candidate-document") { addCandidateDocument(id, cid); return; }
    if (action === "remove-candidate-document") { removeCandidateDocument(id, cid, t.getAttribute("data-did")); return; }
    if (action === "add-role") { addRoleType(); return; }
    if (action === "remove-role") { removeRoleType(t.getAttribute("data-role")); return; }
    if (action === "refresh-scan") { refreshData(false); return; }
    if (action === "logout") {
      fetch("/auth/logout", { method: "POST" }).then(function () { window.location.href = "/auth/login"; });
      return;
    }
    if (action === "quick-add") { quickAdd(); return; }
    if (action === "open-add") {
      var p = document.getElementById("add-panel");
      if (p) { p.hidden = false; if (typeof p.scrollIntoView === "function") p.scrollIntoView({ behavior: "smooth", block: "center" }); }
      return;
    }
    if (action === "cancel-add") {
      var p2 = document.getElementById("add-panel");
      if (p2) p2.hidden = true;
      return;
    }
    if (action === "submit-add") { submitAdd(); return; }
  });

  document.getElementById("app").addEventListener("change", function (e) {
    var t = e.target;
    var action = t.getAttribute("data-action");
    if (!action) return;
    var id = t.getAttribute("data-id");
    var cid = t.getAttribute("data-cid");
    if (action === "set-status") { setStatus(id, t.value); return; }
    if (action === "set-priority") { setPriority(id, t.value); return; }
    if (action === "set-contact-stage") { setContactStage(id, cid, t.value); return; }
    if (action === "set-followup") { setFollowUp(id, cid, t.value); return; }
    if (action === "af-field") {
      var f = activityForm;
      if (!f) return;
      var field = t.getAttribute("data-field");
      f[field] = t.value;
      var fc = findContact(findLead(f.leadId), f.cid);
      if (field === "moveStage") { f.stageTouched = true; if (fc) { applyFormDefaults(fc); render(); } return; }
      if (field === "date") { if (fc) { applyFormDefaults(fc); render(); } return; }
      if (field === "followUp") { f.followTouched = true; return; }
      if ((field === "type" || field === "direction") && fc) { applyFormDefaults(fc); render(); }
      return;
    }
    if (action === "filter-status") { filters.status = t.value; pageSize = PAGE_SIZE_STEP; render(); return; }
    if (action === "edit-contact") {
      var l = findLead(id);
      var c = findContact(l, cid);
      if (c) { c[t.getAttribute("data-field")] = t.value.trim(); persist({ noRender: true }); }
      return;
    }
    if (action === "edit-candidate-field") {
      var l2 = findLead(id);
      var c2 = findCandidate(l2, cid);
      if (c2) { setDeep(c2, t.getAttribute("data-field"), t.value.trim()); persist({ noRender: true }); }
      return;
    }
    if (action === "set-candidate-stage") {
      var l3 = findLead(id);
      var c3 = findCandidate(l3, cid);
      if (c3) { c3.stage = t.value; persist(); }
      return;
    }
  });

  document.getElementById("app").addEventListener("input", function (e) {
    if (e.target.getAttribute("data-action") === "crm-search") {
      crmQuery = e.target.value;
      render();
      var ci = document.querySelector('input[data-action="crm-search"]');
      if (ci) { ci.focus(); ci.setSelectionRange(ci.value.length, ci.value.length); }
      return;
    }
    if (e.target.getAttribute("data-action") === "af-field" && activityForm) {
      activityForm[e.target.getAttribute("data-field")] = e.target.value;
      return;
    }
    if (e.target.getAttribute("data-action") === "search") {
      filters.q = e.target.value;
      pageSize = PAGE_SIZE_STEP;
      render();
      var input = document.querySelector('input[data-action="search"]');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  });

  document.getElementById("app").addEventListener("keydown", function (e) {
    if (e.key === "Escape" && view === "crm" && activityForm) { activityForm = null; render(); return; }
    if (e.key !== "Enter") return;
    var id = e.target.id;
    if (id === "cap-role-name") { e.preventDefault(); addRoleType(); }
    else if (id === "ql-url" || id === "ql-company") { e.preventDefault(); quickAdd(); }
    else if (id && id.indexOf("doc-input-") === 0) { e.preventDefault(); addDocument(id.slice("doc-input-".length)); }
  });

  // Drag a pipeline card onto another column to change that contact's stage.
  var appEl = document.getElementById("app");
  appEl.addEventListener("dragstart", function (e) {
    var card = e.target.closest ? e.target.closest("[data-drag]") : null;
    if (!card || !e.dataTransfer) return;
    e.dataTransfer.setData("text/plain", card.getAttribute("data-drag"));
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  appEl.addEventListener("dragend", function () {
    Array.prototype.forEach.call(appEl.querySelectorAll(".dragging, .drop"), function (el) { el.classList.remove("dragging", "drop"); });
  });
  appEl.addEventListener("dragover", function (e) {
    var col = e.target.closest ? e.target.closest(".board-col") : null;
    if (!col) return;
    e.preventDefault();
    col.classList.add("drop");
  });
  appEl.addEventListener("dragleave", function (e) {
    var col = e.target.closest ? e.target.closest(".board-col") : null;
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drop");
  });
  appEl.addEventListener("drop", function (e) {
    var col = e.target.closest ? e.target.closest(".board-col") : null;
    if (!col || !e.dataTransfer) return;
    e.preventDefault();
    var parts = (e.dataTransfer.getData("text/plain") || "").split("|");
    if (parts.length !== 2) { render(); return; }
    setContactStage(parts[0], parts[1], col.getAttribute("data-stage"));
  });

  function loadState() {
    document.getElementById("app").innerHTML = '<div class="empty">Loading Nimbl Radar…</div>';
    fetch("/auth/me").then(function (res) {
      if (res.status === 401) { window.location.href = "/auth/login"; return null; }
      return res.ok ? res.json() : { enabled: false };
    }).then(function (who) {
      if (!who) return; // redirecting to login
      currentUser = who.user || null;
      return fetch("/api/state").then(function (res) {
        if (res.status === 401) { window.location.href = "/auth/login"; return null; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }).then(function (loaded) {
      if (!loaded) return; // redirecting to login
      state = loaded;
      render();
    }).catch(function (err) {
      document.getElementById("app").innerHTML =
        '<div class="empty">Couldn\'t load data from the server: ' + escapeHtml(err.message) + '. Is the API running and DATABASE_URL configured?</div>';
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.leads.length) refreshData(true);
  });

  document.title = "Nimbl Radar";
  loadState();
}());
