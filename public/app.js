
(function () {
  "use strict";


  var PRIORITIES = ["High", "Medium", "Low"];
  var STATUSES = ["Not Started", "Researching", "Contacted", "Replied", "Meeting Booked", "Proposal Sent", "Won", "Lost", "Not a Fit"];
  var ACTIVE_STATUSES = ["Contacted", "Replied", "Meeting Booked", "Proposal Sent"];
  var DEAD_STATUSES = ["Lost", "Not a Fit"];
  var CONTACT_ROLES = ["Admin", "Accounting", "HR", "Signatory", "Technical", "Billing"];
  var CANDIDATE_STAGES = ["Identified", "Call booked", "Screen Approved", "Presented", "Interviewing", "Pre-Approved", "Placed", "Not Placed"];
  var PAGE_SIZE_STEP = 8;

  var state = { lastScanned: "", roleTypes: [], leads: [] };
  var filters = { roleType: "All", priority: "All", status: "All", q: "" };
  var expandedId = null;
  var pageSize = PAGE_SIZE_STEP;
  var readOnly = false;

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

  function daysSince(iso) {
    if (!iso) return null;
    var posted = new Date(iso + "T00:00:00Z");
    if (isNaN(posted.getTime())) return null;
    var today = new Date("2026-08-31T00:00:00Z");
    var diff = Math.round((today.getTime() - posted.getTime()) / 86400000);
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

  function renderContactCard(l, c) {
    var d = readOnly ? " disabled" : "";
    var rolesPills = CONTACT_ROLES.map(function (r) {
      var active = c.roles && c.roles.indexOf(r) !== -1;
      return '<button type="button" class="role-pill' + (active ? ' active' : '') + '" data-action="toggle-contact-role" data-id="' + l.id + '" data-cid="' + c.id + '" data-role="' + r + '"' + d + '>' + r + '</button>';
    }).join("");
    return '' +
      '<div class="contact-card">' +
        '<div class="contact-head">' +
          '<div class="avatar">' + escapeHtml(initialsOf(c.name)) + '</div>' +
          '<div class="ct-name-wrap"><input class="ct-name-input" type="text" value="' + escapeHtml(c.name) + '" placeholder="Contact name" data-action="edit-contact" data-field="name" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          (readOnly ? "" : '<button class="btn btn-ghost btn-sm" type="button" data-action="remove-contact" data-id="' + l.id + '" data-cid="' + c.id + '" aria-label="Remove contact">✕</button>') +
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
          '<h4>Communication log</h4>' +
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
        '<td><div class="company-cell"><div><div class="nm">' + escapeHtml(l.company) + (l.status === "Won" ? '<span class="client-badge">Client</span>' : '') + '</div><span class="role-tag">' + escapeHtml(l.jobTitle) + '</span></div></div></td>' +
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

  function render() {
    var html = '' +
      '<div class="topbar">' +
        '<div class="brand">' +
          '<img class="brand-logo" src="/img/nimbl-logo.png" alt="nimbl.ai" width="901" height="214">' +
          '<div><h1>Radar</h1><div class="tag">Nearshore LATAM staffing · lead CRM</div></div>' +
        '</div>' +
        '<div class="topbar-right">' +
          '<div class="scan-meta">Last scanned<br><span class="mono">' + fmtDate(state.lastScanned) + '</span></div>' +
          '<button class="btn" type="button" data-action="refresh-scan">↻ Refresh</button>' +
          (readOnly ? "" : '<button class="btn btn-primary" type="button" data-action="open-add">+ Add lead</button>') +
        '</div>' +
      '</div>' +
      (readOnly ? '<div class="readonly-note">This view is read-only — open the artifact in claude.ai as its owner to edit statuses, notes, and contacts.</div>' : '') +
      renderNewBanner() +
      renderStats() +
      renderCaptureBar() +
      renderPriorities() +
      renderAddForm() +
      renderFilters() +
      renderTable() +
      '<p class="help" style="margin-top:14px">New roles show up here after Claude runs a scan for you in chat — use the Refresh button above to copy a ready-made scan prompt, or just ask, e.g. "scan for new Salesforce Developer, Salesforce BA, and Databricks Data Engineer roles."</p>';
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

  var saveTimer = null;
  function persist() {
    render();
    if (readOnly) { toast("Read-only view — changes aren't saved."); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state)
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then(function (freshState) {
        state = freshState;
        render();
      }).catch(function (err) {
        toast("Couldn't save: " + (err && err.message ? err.message : "unknown error"));
      });
    }, 300);
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
    l.contacts.push({ id: "c" + Date.now().toString(36), name: "", title: "", email: "", phone: "", linkedin: "", roles: [] });
    persist();
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

  function refreshScan() {
    var roles = state.roleTypes.join(", ");
    var prompt = "Scan for new job openings at companies (ideally under 500 employees) for these roles: " + roles + ". Cross-check against the leads already in Nimbl Radar (avoid duplicates), and for any new company found, add it to the dashboard with a company profile, required skills, and a nearshore-fit assessment, matching the existing lead format.";
    var done = function () { toast("Scan prompt copied to clipboard — paste it to Claude in chat to search for new leads."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(prompt).then(done).catch(function () {
        toast('Couldn\'t copy automatically — ask Claude in chat: "' + prompt + '"');
      });
    } else {
      toast('Ask Claude in chat: "' + prompt + '"');
    }
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
    if (action === "refresh-scan") { refreshScan(); return; }
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
    if (action === "filter-status") { filters.status = t.value; pageSize = PAGE_SIZE_STEP; render(); return; }
    if (action === "edit-contact") {
      var l = findLead(id);
      var c = findContact(l, cid);
      if (c) { c[t.getAttribute("data-field")] = t.value.trim(); persist(); }
      return;
    }
    if (action === "edit-candidate-field") {
      var l2 = findLead(id);
      var c2 = findCandidate(l2, cid);
      if (c2) { setDeep(c2, t.getAttribute("data-field"), t.value.trim()); persist(); }
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
    if (e.target.getAttribute("data-action") === "search") {
      filters.q = e.target.value;
      pageSize = PAGE_SIZE_STEP;
      render();
      var input = document.querySelector('input[data-action="search"]');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  });

  document.getElementById("app").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var id = e.target.id;
    if (id === "cap-role-name") { e.preventDefault(); addRoleType(); }
    else if (id === "ql-url" || id === "ql-company") { e.preventDefault(); quickAdd(); }
    else if (id && id.indexOf("doc-input-") === 0) { e.preventDefault(); addDocument(id.slice("doc-input-".length)); }
  });

  function loadState() {
    document.getElementById("app").innerHTML = '<div class="empty">Loading Nimbl Radar…</div>';
    fetch("/api/state").then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (loaded) {
      state = loaded;
      render();
    }).catch(function (err) {
      document.getElementById("app").innerHTML =
        '<div class="empty">Couldn\'t load data from the server: ' + escapeHtml(err.message) + '. Is the API running and DATABASE_URL configured?</div>';
    });
  }

  document.title = "Nimbl Radar";
  loadState();
}());
