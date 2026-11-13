
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
  // The outreach plan every contact follows. "wait" = days after the previous touch (touch 2 counts from
  // the day they accept your connection request). Edit the text or timing here to change the plan.
  var SEQUENCE = [
    { n: 1, name: "Connection request", type: "LinkedIn connection", wait: 0, tip: "Send a LinkedIn connection request with a short note that mentions the role they are hiring for." },
    { n: 2, name: "First message", type: "LinkedIn message", wait: 2, tip: "Once they accept, name the open role you saw and offer 2–3 anonymized LATAM profiles." },
    { n: 3, name: "Email follow-up", type: "Email", altType: "LinkedIn message", wait: 5, tip: "Short email repeating the offer. No email on file? Send a second LinkedIn message instead." },
    { n: 4, name: "Value add", type: "LinkedIn message", wait: 5, tip: "Share something useful: a relevant profile, a rate comparison or a hiring tip. No hard ask." },
    { n: 5, name: "Last note", type: "LinkedIn message", wait: 6, tip: "Close the loop: ask if they are the right person (or who is), then stop." }
  ];
  var SEQUENCE_DONE_WAIT = 7; // days after touch 5 before you are nudged to close the contact out
  // If the contact is already past a stage, the earlier touches are counted as done.
  var STAGE_MIN_STEP = { "Connection sent": 1, "Connected": 1, "Message sent": 2 };
  var QUIET_DAYS = 7;            // days without a reply before the app suggests a second person at the company
  var DAILY_NEW_OUTREACH = 10;   // suggested cap for new LinkedIn connection requests per day
  var BOARD_STAGES = ["Not contacted", "Connection sent", "Connected", "Message sent", "Replied", "Meeting booked", "No response", "Not interested"];
  var CANDIDATE_STAGES = ["Identified", "Call booked", "Screen Approved", "Presented", "Interviewing", "Pre-Approved", "Placed", "Not Placed"];
  var PAGE_SIZE_STEP = 8;

  var state = { lastScanned: "", roleTypes: [], leads: [] };
  var filters = { roleType: "All", priority: "All", status: "All", q: "" };
  var expandedId = null;
  var VIEWS = ["leads", "pipeline", "crm", "playbook"];
  var crmLeadId = null;               // the prospect whose full client card is open (CRM tab), if any
  var clientQuery = "";               // CRM list search box
  var inClientCard = false;           // true while the full-page client card is being built (contact cards drop their own timeline)
  var files = [];                     // metadata of uploaded files (the bytes stay on the server)
  var uploading = {};                 // "leadId|contactId" -> number of uploads in flight
  var filesPending = 0;               // uploads/deletes in flight; a refresh must not overwrite them
  var FILE_EXTS = ["pdf", "png", "jpg", "jpeg", "webp", "gif", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf"];
  var FILE_MAX_BYTES = 10 * 1024 * 1024;
  var ctOpen = {};                    // client card: contact ids whose detail fields are expanded
  var crmFilter = "Active";           // CRM list filter: Active / Clients / Closed / All
  var cardMore = false;               // client card: show the full company text instead of the short version
  var tlLimit = 12;                   // client card: how many timeline entries are showing
  var view = "leads";
  (function readHash() {
    var h = (window.location.hash || "").replace(/^#/, "");
    var parts = h.split("/");
    if (VIEWS.indexOf(parts[0]) !== -1) { view = parts[0]; if (view === "crm" && parts[1]) crmLeadId = decodeURIComponent(parts[1]); }
  }());
  var playbook = [];                 // research notes, objection cheat sheet, templates (see server/playbook.js)
  var pbDraft = { body: "", tag: "Research" }; // the note being written/dictated (kept outside the DOM)
  var pbPending = 0;                 // playbook saves in flight
  var NOTE_TAGS = ["Research", "Concern", "Objection heard", "Prospect insight"];
  var TEMPLATE_TAGS = ["Touch 1 · Connection request", "Touch 2 · First message", "Touch 3 · Email", "Touch 4 · Value add", "Touch 5 · Last note", "Reply to an objection", "Other"];
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var dictation = { rec: null, on: false, lang: "en-US" };
  try { dictation.lang = window.localStorage.getItem("radar-dictation-lang") || "en-US"; } catch (e) { /* ignore */ }
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

  /* ---- outreach sequence ---- */

  function seqStep(c) {
    var n = parseInt(c.sequenceStep, 10);
    if (isNaN(n)) n = 0;
    n = Math.max(n, STAGE_MIN_STEP[c.stage] || 0); // contacts reached before this feature count as already started
    return Math.min(SEQUENCE.length, Math.max(0, n));
  }

  // Replies and meetings pause the plan; it also ends when all five touches are done.
  function seqPaused(c) {
    var st = c.stage || "Not contacted";
    return st === "Replied" || st === "Meeting booked" || st === "Not interested";
  }

  function seqDone(c) { return seqStep(c) >= SEQUENCE.length || (c.stage || "") === "No response"; }

  function nextTouch(c) {
    if (seqPaused(c) || seqDone(c)) return null;
    return SEQUENCE[seqStep(c)];
  }

  // The channel to use for a touch (touch 3 falls back to LinkedIn when there is no email).
  function touchType(c, t) {
    return t.altType && !(c.email || "").trim() ? t.altType : t.type;
  }

  function touchShort(c, t) {
    return "Touch " + t.n + " · " + t.name + " (" + (touchType(c, t) === "Email" ? "email" : "LinkedIn") + ")";
  }

  function seqStageFloor(c, stage) {
    var m = STAGE_MIN_STEP[stage || c.stage] || 0;
    return Math.max(seqStep(c), m);
  }

  // Days until the next touch, given where the contact will be after this change.
  function sequenceFollowUp(c, stage, step, baseIso) {
    if (stage === "Not interested") return "";
    if (stage === "Replied" || stage === "No response") return cadenceFollowUp(stage, baseIso);
    if (stage === "Meeting booked") return "";
    if (step <= 0) return "";
    if (step >= SEQUENCE.length) return addDays(baseIso, SEQUENCE_DONE_WAIT);
    var t = SEQUENCE[step];
    var wait = t.wait;
    if (t.n === 2) wait = stage === "Connected" ? 2 : 4; // 4 days to see whether they accepted
    return addDays(baseIso, wait);
  }

  function renderSequenceBlock(l, c) {
    var step = seqStep(c);
    var dots = SEQUENCE.map(function (t, i) {
      var cls = i < step ? "seq-dot done" : (i === step && !seqPaused(c) && !seqDone(c) ? "seq-dot now" : "seq-dot");
      return '<span class="' + cls + '" title="Touch ' + t.n + ': ' + escapeHtml(t.name) + '"></span>';
    }).join("");
    var head, body = "";
    var nt = nextTouch(c);
    if (seqPaused(c)) {
      head = (c.stage === "Not interested" ? "Sequence stopped" : "Sequence paused") + " · " + escapeHtml(c.stage);
      body = c.stage === "Not interested" ? "No more messages needed." : "They replied, so the automatic plan is on hold. Handle this one by hand.";
    } else if (seqDone(c)) {
      head = "Sequence complete · " + step + " of " + SEQUENCE.length + " touches";
      body = (c.stage === "No response" ? "Marked as no response." : "No reply after all five touches? Mark them No response and move to someone else at the company.");
    } else {
      head = "Touch " + nt.n + " of " + SEQUENCE.length + " · " + escapeHtml(nt.name);
      body = nt.tip;
      if (nt.n === 2 && (c.stage || "") === "Connection sent") body = "Waiting for them to accept. Set the stage to Connected when they do, or skip ahead if they never accept. " + nt.tip;
      if (nt.n === 3 && touchType(c, nt) !== nt.type) body = "No email on file, so send this as a second LinkedIn message. " + nt.tip;
    }
    var controls = "";
    if (!readOnly) {
      controls = '<div class="seq-controls">' +
        (nt ? '<button type="button" class="btn btn-sm" data-action="skip-touch" data-id="' + l.id + '" data-cid="' + c.id + '">Skip this touch</button>' : '') +
        '<label class="seq-set">Touches done <select class="mini" data-action="set-seq-step" data-id="' + l.id + '" data-cid="' + c.id + '">' +
          [0, 1, 2, 3, 4, 5].map(function (n) { return '<option value="' + n + '"' + (n === step ? " selected" : "") + '>' + n + '</option>'; }).join("") +
        '</select></label>' +
      '</div>';
    }
    return '<div class="seq"><div class="seq-top"><span class="seq-dots" aria-hidden="true">' + dots + '</span><strong>' + head + '</strong></div>' +
      '<div class="seq-tip">' + escapeHtml(body) + '</div>' + controls + '</div>';
  }

  /* ---- who to contact first ---- */

  // How likely this title is the right first call for a tech hire at a smaller company.
  function titleScore(title) {
    var t = (title || "").toLowerCase().trim();
    if (!t) return 0;
    if (/\b(cto|vp|vice president|head of|director|chief|engineering manager|eng manager|founder|co-?founder|ceo|owner|president)\b/.test(t) && !/recruit|talent|hr\b|people|human/.test(t)) return 3;
    if (/recruit|talent|people|human resources|\bhr\b|coo|operations|hiring/.test(t)) return 2;
    return 1;
  }

  function suggestedFirst(l) {
    var best = null, bestScore = -1;
    (l.contacts || []).forEach(function (c) {
      var sc = titleScore(c.title);
      if (sc > bestScore) { best = c; bestScore = sc; }
    });
    return best;
  }

  // The first contact: the one you flagged, otherwise the best fit by title.
  function firstContact(l) {
    var flagged = (l.contacts || []).filter(function (c) { return c.isPrimary; })[0];
    return flagged || suggestedFirst(l);
  }

  function setPrimary(id, cid) {
    var l = findLead(id);
    if (!l) return;
    var target = findContact(l, cid);
    if (!target) return;
    var turningOff = !!target.isPrimary;
    (l.contacts || []).forEach(function (c) { c.isPrimary = false; });
    target.isPrimary = !turningOff;
    persist();
  }

  function lastTouchDays(c) {
    var d = c.lastContacted || latestTouchDate(c);
    return isIsoDate(d) ? diffDays(todayStr(), d) : null;
  }

  // Companies where everyone you have contacted has gone quiet: suggest the next person.
  function secondContactPrompts() {
    var out = [];
    state.leads.forEach(function (l) {
      if (DEAD_STATUSES.indexOf(l.status) !== -1) return;
      var contacts = l.contacts || [];
      var started = contacts.filter(function (c) { return (c.stage || "Not contacted") !== "Not contacted"; });
      if (!started.length) return;
      var engaged = started.some(function (c) { return c.stage === "Replied" || c.stage === "Meeting booked"; });
      if (engaged) return;
      var quiet = started.filter(function (c) {
        if (c.stage === "Not interested") return false;
        var d = lastTouchDays(c);
        return c.stage === "No response" || (d !== null && d >= QUIET_DAYS);
      });
      var stillActive = started.filter(function (c) { return c.stage !== "Not interested" && c.stage !== "No response"; });
      // Every started contact must be quiet (or closed out) before we suggest someone new.
      if (!quiet.length || stillActive.some(function (c) { return quiet.indexOf(c) === -1; })) return;
      var waiting = quiet[0];
      var days = lastTouchDays(waiting);
      var untouched = contacts.filter(function (c) { return (c.stage || "Not contacted") === "Not contacted"; });
      untouched.sort(function (a, b) { return titleScore(b.title) - titleScore(a.title); });
      out.push({ lead: l, quiet: waiting, days: days, next: untouched[0] || null });
    });
    out.sort(function (a, b) { return (b.days || 0) - (a.days || 0); });
    return out;
  }

  function coverageHtml(l) {
    var have = {};
    (l.contacts || []).forEach(function (c) { (c.roles || []).forEach(function (r) { have[r] = true; }); });
    var pills = CONTACT_ROLES.map(function (r) {
      return '<span class="cov ' + (have[r] ? "cov-yes" : "cov-no") + '">' + (have[r] ? "✓ " : "") + r + '</span>';
    }).join("");
    return '<div class="coverage"><span class="cov-label">Roles covered at this company</span>' + pills + '</div>';
  }

  function newOutreachToday() {
    var today = todayStr(), n = 0;
    state.leads.forEach(function (l) {
      (l.contacts || []).forEach(function (c) {
        (c.activities || []).forEach(function (a) {
          if (a.type === "LinkedIn connection" && a.direction !== "Inbound" && a.date === today) n++;
        });
      });
    });
    return n;
  }

  function cadenceFollowUp(stage, baseIso) {
    var n = CADENCE_DAYS[stage];
    return n ? addDays(baseIso, n) : "";
  }

  function newActId() {
    return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function setView(v) {
    view = VIEWS.indexOf(v) !== -1 ? v : "leads";
    activityForm = null;
    crmLeadId = null;
    stopDictation();
    try { window.history.replaceState(null, "", view === "leads" ? window.location.pathname : "#" + view); } catch (e) { /* ignore */ }
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
    return '<div class="priorities followups"><h3>Follow-ups due <button class="btn-link" type="button" data-action="set-view" data-view="pipeline" style="margin-left:8px">Open Pipeline →</button></h3><div class="priority-list">' + body + '</div></div>';
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
        (f.direction !== "Inbound" && f.type !== "Note" && seqStep(c) < SEQUENCE.length ? '<p class="af-touch">Counts as touch ' + (seqStep(c) + 1) + ' of ' + SEQUENCE.length + ' in the outreach plan.</p>' : '') +
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
    var detailsOpen = !inClientCard || !!ctOpen[c.id] || !c.name;
    var acts = (c.activities || []).map(function (a, i) { return { a: a, i: i }; }).sort(function (x, y) {
      var dc = (y.a.date || "").localeCompare(x.a.date || "");
      return dc !== 0 ? dc : y.i - x.i;
    });
    var timeline = acts.length
      ? '<div class="activity-list">' + acts.map(function (x) { return renderActivity(l, c, x.a); }).join("") + '</div>'
      : '<div class="act-empty">No activity logged yet.</div>';
    var linkedinOk = /^https?:\/\//.test(c.linkedin || "");
    var fc = firstContact(l);
    var isFirst = fc && fc.id === c.id && (l.contacts || []).length > 0;
    var firstBadge = c.isPrimary ? '<span class="first-badge">★ First contact</span>' : (isFirst && (l.contacts || []).length > 1 ? '<span class="first-badge first-suggest" title="Best fit by job title">★ Suggested first</span>' : "");
    return '' +
      '<div class="contact-card' + (c.isPrimary ? ' is-primary' : '') + '">' +
        '<div class="contact-head">' +
          '<div class="avatar">' + escapeHtml(initialsOf(c.name)) + '</div>' +
          '<div class="ct-name-wrap"><input class="ct-name-input" type="text" value="' + escapeHtml(c.name) + '" placeholder="Contact name" data-action="edit-contact" data-field="name" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          firstBadge +
          '<select class="mini ct-stage" data-action="set-contact-stage" data-id="' + l.id + '" data-cid="' + c.id + '" aria-label="Outreach stage"' + d + '>' +
            CONTACT_STAGES.map(function (s) { return '<option value="' + s + '"' + (stage === s ? " selected" : "") + '>' + s + '</option>'; }).join("") +
          '</select>' +
          (readOnly ? "" : '<button class="btn btn-ghost btn-sm" type="button" data-action="remove-contact" data-id="' + l.id + '" data-cid="' + c.id + '" aria-label="Remove contact">✕</button>') +
        '</div>' +
        '<div class="ct-crm">' +
          renderSequenceBlock(l, c) +
          '<div class="ct-meta">' +
            '<span>Last contacted: <strong>' + (c.lastContacted ? fmtDate(c.lastContacted) : "never") + '</strong></span>' +
            '<label>Next follow-up <input type="date" value="' + escapeHtml(c.nextFollowUp || "") + '" data-action="set-followup" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></label>' +
            dueBadgeFor(c) +
            (linkedinOk ? '<a href="' + escapeHtml(c.linkedin) + '" target="_blank" rel="noopener">LinkedIn ↗</a>' : '') +
            (readOnly || (l.contacts || []).length < 2 ? "" : '<button type="button" class="btn-link" data-action="toggle-primary" data-id="' + l.id + '" data-cid="' + c.id + '">' + (c.isPrimary ? "Remove first-contact flag" : "Make first contact") + '</button>') +
          '</div>' +
          (formOpen ? renderActivityForm(l, c) : (readOnly ? "" : '<div><button class="btn btn-sm" type="button" data-action="open-activity-form" data-id="' + l.id + '" data-cid="' + c.id + '">+ Log activity</button></div>')) +
          (inClientCard ? "" : timeline) +
          renderContactFiles(l, c) +
        '</div>' +
        (inClientCard ? renderContactSummary(l, c, detailsOpen) : "") +
        (detailsOpen ? (
        '<div class="field-row">' +
          '<div><label>Title</label><input type="text" value="' + escapeHtml(c.title) + '" data-action="edit-contact" data-field="title" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<div><label>Phone</label><input type="text" value="' + escapeHtml(c.phone) + '" data-action="edit-contact" data-field="phone" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div><label>Email</label><input type="email" value="' + escapeHtml(c.email) + '" data-action="edit-contact" data-field="email" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
          '<div><label>LinkedIn</label><input type="text" value="' + escapeHtml(c.linkedin) + '" data-action="edit-contact" data-field="linkedin" data-id="' + l.id + '" data-cid="' + c.id + '"' + d + '></div>' +
        '</div>' +
        '<div class="role-pills">' + rolesPills + '</div>'
        ) : "") +
      '</div>';
  }

  // Inside the client card a contact's editable fields stay folded away until asked for.
  function renderContactSummary(l, c, open) {
    var bits = [];
    if (c.title) bits.push(escapeHtml(c.title));
    if (c.email) bits.push('<a href="mailto:' + escapeHtml(c.email) + '">' + escapeHtml(c.email) + '</a>');
    if (c.phone) bits.push(escapeHtml(c.phone));
    return '<div class="ct-summary"><span>' + (bits.length ? bits.join(' · ') : 'No title or contact details yet') + '</span>' +
      '<button type="button" class="btn-link" data-action="ct-toggle" data-cid="' + c.id + '" aria-expanded="' + (open ? "true" : "false") + '">' + (open ? "Hide details" : (readOnly ? "Show details" : "Edit details")) + '</button></div>';
  }

  /* ---------------- Uploaded files ---------------- */

  function fmtSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  function fileExt(name) { var m = /\.([A-Za-z0-9]{1,5})$/.exec(name || ""); return m ? m[1].toLowerCase() : ""; }

  function leadFiles(leadId) { return files.filter(function (f) { return f.leadId === leadId; }); }
  function contactFiles(leadId, cid) { return files.filter(function (f) { return f.leadId === leadId && f.contactId === cid; }); }

  function renderFileItem(l, f, showOwner) {
    var owner = "";
    if (showOwner && f.contactId) {
      var oc = findContact(l, f.contactId);
      if (oc) owner = '<span class="file-owner">' + escapeHtml(oc.name || "(unnamed contact)") + '</span>';
    }
    return '<div class="file-item">' +
      '<span class="file-ext">' + escapeHtml((f.ext || fileExt(f.name) || "file").toUpperCase()) + '</span>' +
      '<a class="file-name" href="/api/files/' + encodeURIComponent(f.id) + '" target="_blank" rel="noopener">' + escapeHtml(f.name) + '</a>' +
      owner +
      '<span class="file-meta">' + fmtSize(f.size) + ' · ' + fmtDate((f.uploadedAt || "").slice(0, 10)) + '</span>' +
      (readOnly ? "" : '<button type="button" class="act-del" data-action="file-remove" data-fid="' + escapeHtml(f.id) + '" aria-label="Delete file ' + escapeHtml(f.name) + '">✕</button>') +
    '</div>';
  }

  function renderUploadButton(l, cid, label) {
    if (readOnly) return "";
    var busy = uploading[l.id + "|" + (cid || "")] > 0;
    return '<label class="btn btn-sm file-btn' + (busy ? ' is-busy' : '') + '">' + (busy ? "Uploading…" : label) +
      '<input type="file" class="file-input" multiple accept="' + FILE_EXTS.map(function (e) { return "." + e; }).join(",") + '" data-action="file-input" data-id="' + l.id + '" data-cid="' + (cid || "") + '"' + (busy ? " disabled" : "") + '></label>';
  }

  function renderContactFiles(l, c) {
    var list = contactFiles(l.id, c.id);
    if (readOnly && !list.length) return "";
    return '<div class="ct-files">' + list.map(function (f) { return renderFileItem(l, f, false); }).join("") +
      renderUploadButton(l, c.id, list.length ? "+ Attach another file" : "+ Attach a file (profile PDF, CV…)") + '</div>';
  }

  function uploadFiles(leadId, cid, fileList) {
    var picked = Array.prototype.slice.call(fileList || []);
    if (!picked.length) return;
    var key = leadId + "|" + (cid || "");
    var ok = picked.filter(function (f) {
      if (FILE_EXTS.indexOf(fileExt(f.name)) === -1) { toast("“" + f.name + "” isn't a supported type. Use a PDF, an image, or an Office, text or CSV file."); return false; }
      if (f.size > FILE_MAX_BYTES) { toast("“" + f.name + "” is over the 10 MB limit."); return false; }
      if (f.size === 0) { toast("“" + f.name + "” is empty."); return false; }
      return true;
    });
    if (!ok.length) return;
    uploading[key] = (uploading[key] || 0) + ok.length;
    filesPending += ok.length;
    render();
    var done = 0;
    var chain = Promise.resolve();
    ok.forEach(function (f) {
      chain = chain.then(function () {
        return fetch("/api/leads/" + encodeURIComponent(leadId) + "/files" + (cid ? "?contactId=" + encodeURIComponent(cid) : ""), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(f.name) },
          body: f
        }).then(function (res) {
          if (res.status === 401) { window.location.href = "/auth/login"; return null; }
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
            return body;
          });
        }).then(function (meta) {
          if (meta && meta.id) { files.push(meta); done++; }
        }).catch(function (err) {
          toast("Couldn't upload “" + f.name + "”: " + (err && err.message ? err.message : "unknown error"));
        }).then(function () {
          uploading[key]--;
          filesPending--;
        });
      });
    });
    chain.then(function () {
      if (done) toast(done === 1 ? "File saved." : done + " files saved.");
      render();
    });
  }

  function removeFile(fid) {
    var f = files.filter(function (x) { return x.id === fid; })[0];
    if (!f) return;
    if (!window.confirm("Delete “" + f.name + "”? This can't be undone.")) return;
    files = files.filter(function (x) { return x.id !== fid; });
    filesPending++;
    render();
    fetch("/api/files/" + encodeURIComponent(fid), { method: "DELETE" }).then(function (res) {
      if (res.status === 401) { window.location.href = "/auth/login"; return; }
      if (!res.ok) throw new Error("HTTP " + res.status);
    }).catch(function (err) {
      files.push(f);
      toast("Couldn't delete the file: " + (err && err.message ? err.message : "unknown error"));
      render();
    }).then(function () { filesPending--; });
  }

  function loadFiles() {
    return fetch("/api/files").then(function (res) {
      if (res.status === 401) { window.location.href = "/auth/login"; return null; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (list) {
      if (!list || filesPending > 0) return;
      if (JSON.stringify(list) !== JSON.stringify(files)) {
        files = list;
        var a = document.activeElement;
        var typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
        if (!typing && !activityForm && !dictation.on && view !== "playbook") render();
      }
    }).catch(function () { /* files are optional; everything else keeps working without them */ });
  }

  function renderContactsPanel(l) {
    var body = l.contacts.length ? l.contacts.map(function (c) { return renderContactCard(l, c); }).join("") : '<p style="color:var(--ink-soft);margin:4px 0">No contacts yet.</p>';
    var fcN = firstContact(l);
    var hint = (l.contacts.length > 1 && fcN)
      ? '<p class="help" style="margin:0 0 8px">Reach out to <strong>' + escapeHtml(fcN.name || "(unnamed contact)") + '</strong> first' + (fcN.isPrimary ? "." : " (best fit by job title). Use “Make first contact” on a card to choose someone else.") + ' If they go quiet for ' + QUIET_DAYS + ' days, the Pipeline tab suggests the next person.</p>'
      : '';
    return '<h4>Contacts</h4>' + (l.contacts.length ? coverageHtml(l) : '') + hint + body + (readOnly ? "" : '<button class="btn btn-sm" type="button" data-action="add-contact" data-id="' + l.id + '">+ Add contact</button>');
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
    }).join("") : '<p style="color:var(--ink-soft);margin:4px 0">Nothing on the checklist yet.</p>';
    var lf = leadFiles(l.id);
    var filesHtml = (lf.length ? '<div class="file-list">' + lf.map(function (f) { return renderFileItem(l, f, true); }).join("") + '</div>' : '<p class="file-none">No files uploaded yet.</p>') +
      (readOnly ? "" : '<div class="file-actions">' + renderUploadButton(l, "", "Upload file") + '<span class="file-hint">PDF, images or Office files, up to 10 MB each</span></div>');
    return '<h4>Documents</h4>' + filesHtml + '<h5 class="doc-sub">Checklist (names only)</h5><div>' + docsHtml + '</div>' +
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
          renderCrmSaveBar(l) +
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
        '<td><div class="company-cell"><div><div class="nm">' + escapeHtml(l.company) + (l.status === "Won" ? '<span class="client-badge">Client</span>' : '') + (l.inCrm ? '<span class="incrm-badge" title="Saved to your CRM">In CRM</span>' : '') + (leadDueCount(l) > 0 ? '<span class="due-badge due-today" style="margin-left:6px">Follow-up due</span>' : '') + '</div><span class="role-tag">' + escapeHtml(l.jobTitle) + '</span></div></div></td>' +
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

  function overdueCount() {
    return allFollowUps().filter(function (f) { return f.days < 0; }).length;
  }

  function renderViewTabs() {
    var fresh = newRolesCount();
    var overdue = overdueCount();
    function tab(v, label, extra) {
      return '<button type="button" class="viewtab" role="tab" aria-selected="' + (view === v) + '" data-action="set-view" data-view="' + v + '">' + label + (extra || "") + '</button>';
    }
    function count(n, what) { return n > 0 ? ' <span class="tab-count" title="' + n + ' ' + what + '">' + n + '</span>' : ""; }
    return '<div class="viewtabs" role="tablist">' +
      tab("leads", "Leads", count(fresh, fresh === 1 ? "new lead" : "new leads")) +
      tab("pipeline", "Pipeline", count(overdue, overdue === 1 ? "overdue follow-up" : "overdue follow-ups")) +
      tab("crm", "CRM") + tab("playbook", "Playbook") + '</div>';
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
    var nt = nextTouch(c);
    var label = nt ? "Log touch " + nt.n : logLabel;
    return '' +
      '<div class="ar">' +
        '<div class="ar-main"><div class="nm">' + escapeHtml(who) + (c.isPrimary ? ' <span class="first-badge">★ First</span>' : '') + '</div>' +
        '<div class="rt">' + escapeHtml(lead.company) + ' · ' + escapeHtml(c.stage || "Not contacted") + (c.lastContacted ? ' · last touch ' + fmtDate(c.lastContacted) : '') + '</div>' +
        (nt ? '<div class="rt rt-next">Next: ' + escapeHtml(touchShort(c, nt)) + '</div>' : '') + '</div>' +
        badge +
        (readOnly ? "" : '<button class="btn btn-sm btn-primary" type="button" data-action="crm-log" data-id="' + lead.id + '" data-cid="' + c.id + '">' + label + '</button>') +
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
        '<div class="kb-seq" title="Outreach plan progress">' + SEQUENCE.map(function (t, i) { return '<span class="seq-dot' + (i < seqStep(c) ? ' done' : '') + '"></span>'; }).join("") + '<span>' + seqStep(c) + '/' + SEQUENCE.length + ' touches' + (c.isPrimary ? ' · ★ first' : '') + '</span></div>' +
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
    // Start outreach: one person per company (the first contact) until that company has been approached.
    var start = items.filter(function (i) {
      if (i.stage !== "Not contacted" || isIsoDate(i.contact.nextFollowUp)) return false;
      var started = (i.lead.contacts || []).some(function (c) { return (c.stage || "Not contacted") !== "Not contacted"; });
      if (started) return false;
      var fc = firstContact(i.lead);
      return !fc || fc.id === i.contact.id;
    }).sort(function (a, b) {
      return priorityRank(a.lead.priority) - priorityRank(b.lead.priority) || a.lead.company.localeCompare(b.lead.company);
    });
    var seconds = secondContactPrompts();
    var sentToday = newOutreachToday();
    var roomToday = Math.max(0, DAILY_NEW_OUTREACH - sentToday);
    var inConversation = items.filter(function (i) { return i.stage === "Replied" || i.stage === "Meeting booked"; }).length;

    function rowsFor(list, limit, logLabel) {
      return list.slice(0, limit).map(function (x) {
        return renderActionRow(x.lead, x.contact, '<span class="due-badge ' + dueClass(x.days) + '">' + dueLabel(x.days) + '</span>', logLabel);
      });
    }
    var startRows = start.slice(0, Math.max(roomToday, 3)).map(function (i) {
      return renderActionRow(i.lead, i.contact, '<span class="due-badge due-soon">Not started</span>', "Start");
    });
    var secondRows = seconds.slice(0, 6).map(function (x) {
      var nx = x.next;
      var quietWho = escapeHtml(x.quiet.name || "(unnamed contact)");
      var quietFor = x.days === null ? "no reply" : "no reply for " + x.days + " days";
      return '' +
        '<div class="ar">' +
          '<div class="ar-main"><div class="nm">' + (nx ? 'Reach out to ' + escapeHtml(nx.name || "(unnamed contact)") : 'Add a second contact') + '</div>' +
          '<div class="rt">' + escapeHtml(x.lead.company) + (nx && nx.title ? ' · ' + escapeHtml(nx.title) : '') + '</div>' +
          '<div class="rt rt-next">' + quietWho + ': ' + quietFor + '</div></div>' +
          '<span class="due-badge due-today">Go wider</span>' +
          (readOnly || !nx ? "" : '<button class="btn btn-sm btn-primary" type="button" data-action="crm-log" data-id="' + x.lead.id + '" data-cid="' + nx.id + '">Log touch 1</button>') +
          '<button class="btn btn-sm" type="button" data-action="goto-lead" data-id="' + x.lead.id + '">' + (nx ? 'Open' : 'Add contact') + '</button>' +
        '</div>';
    });

    var stats = '' +
      '<div class="stats">' +
        '<div class="stat"><div class="num mono">' + items.length + '</div><div class="lbl">Contacts</div></div>' +
        '<div class="stat"><div class="num mono">' + items.filter(function (i) { return i.stage === "Not contacted"; }).length + '</div><div class="lbl">Not contacted yet</div></div>' +
        '<div class="stat"><div class="num mono">' + inConversation + '</div><div class="lbl">In conversation</div></div>' +
        '<div class="stat' + (overdue.length + dueToday.length > 0 ? " stat-highlight" : "") + '"><div class="num mono">' + (overdue.length + dueToday.length) + '</div><div class="lbl">Contact now</div></div>' +
      '</div>';

    var planText = SEQUENCE.map(function (t) { return t.n + ". " + t.name; }).join(" → ");

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
          renderActionGroup("Reach a second person", "ag-second", secondRows, seconds.length, "No company is waiting on a reply.") +
          renderActionGroup("Start outreach", "ag-start", startRows, start.length, "Every company has been approached.") +
        '</div>' +
        '<p class="pace">New connection requests today: <strong>' + sentToday + '</strong> of ' + DAILY_NEW_OUTREACH + (roomToday > 0 ? ' — room for ' + roomToday + ' more. Spreading them across days keeps your LinkedIn account safe.' : ' — that is plenty for today. Come back tomorrow.') + '</p>' +
        '<p class="help">Every contact follows a five-touch plan: ' + escapeHtml(planText) + '. Follow-up dates come from that plan and you can always change one. A reply pauses the plan.</p>' +
      '</div>' +
      '<div class="crm-section"><h3>Pipeline</h3>' + renderBoard(items) +
        '<p class="help">' + (readOnly ? "" : "Drag a card to a new column, or use its menu, to move a contact. ") + 'Contacts at companies marked Lost or Not a Fit are hidden.</p></div>' +
      renderRecentActivity();
  }

  /* ---------------- CRM tab: saved prospects + full-page client card ---------------- */

  function crmLeads() { return state.leads.filter(function (l) { return l.inCrm; }); }

  function crmGroupOf(l) {
    if (l.status === "Won") return "Clients";
    if (DEAD_STATUSES.indexOf(l.status) !== -1) return "Closed";
    return "Active";
  }

  // The soonest scheduled follow-up across this company's contacts.
  function leadNextStep(l) {
    var today = todayStr(), best = null;
    (l.contacts || []).forEach(function (c) {
      if (!isIsoDate(c.nextFollowUp) || c.stage === "Not interested") return;
      var days = diffDays(c.nextFollowUp, today);
      if (!best || days < best.days) best = { contact: c, days: days };
    });
    return best;
  }

  function leadLastActivity(l) {
    var best = "";
    (l.contacts || []).forEach(function (c) { (c.activities || []).forEach(function (a) { if (a.type !== "Note" && a.date && a.date > best) best = a.date; }); });
    return best;
  }

  function shortText(t, n) {
    t = (t || "").replace(/\s+/g, " ").trim();
    if (t.length <= n) return t;
    var cut = t.slice(0, n);
    var sp = cut.lastIndexOf(" ");
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "") + "…";
  }

  function saveToCrm(id) {
    var l = findLead(id);
    if (!l || l.inCrm) return;
    l.inCrm = true;
    l.crmSavedAt = todayStr();
    persist();
    toast(l.company + " saved to your CRM.");
  }

  function removeFromCrm(id) {
    var l = findLead(id);
    if (!l) return;
    l.inCrm = false;
    if (crmLeadId === id) crmLeadId = null;
    try { if (view === "crm") window.history.replaceState(null, "", "#crm"); } catch (e) { /* ignore */ }
    persist();
    toast(l.company + " removed from the CRM. It is still in Leads.");
  }

  function openClient(id) {
    var l = findLead(id);
    if (!l || !l.inCrm) { gotoLead(id); return; }
    view = "crm";
    crmLeadId = id;
    activityForm = null;
    cardMore = false;
    tlLimit = 12;
    stopDictation();
    try { window.history.pushState(null, "", "#crm/" + encodeURIComponent(id)); } catch (e) { /* ignore */ }
    render();
    window.scrollTo(0, 0);
  }

  function closeClient() {
    crmLeadId = null;
    activityForm = null;
    try { window.history.pushState(null, "", "#crm"); } catch (e) { /* ignore */ }
    render();
    window.scrollTo(0, 0);
  }

  function renderCrmSaveBar(l) {
    if (l.inCrm) {
      return '<div class="crm-savebar crm-saved"><span><strong>In your CRM</strong> since ' + fmtDate(l.crmSavedAt) + '</span>' +
        '<button type="button" class="btn btn-sm btn-primary" data-action="crm-open" data-id="' + l.id + '">Open client card →</button>' +
        (readOnly ? "" : '<button type="button" class="btn-link" data-action="crm-remove" data-id="' + l.id + '">Remove from CRM</button>') + '</div>';
    }
    if (readOnly) return "";
    return '<div class="crm-savebar"><span>Good prospect? Keep it in your CRM with its own client card.</span>' +
      '<button type="button" class="btn btn-sm btn-primary" data-action="crm-save" data-id="' + l.id + '">★ Save to CRM</button></div>';
  }

  function renderClientListCard(l) {
    var ns = leadNextStep(l);
    var fc = ns ? ns.contact : firstContact(l);
    var step = fc ? seqStep(fc) : 0;
    var nC = (l.contacts || []).length;
    var dots = SEQUENCE.map(function (t, i) { return '<span class="seq-dot' + (i < step ? ' done' : '') + '"></span>'; }).join("");
    var last = leadLastActivity(l);
    var nextHtml;
    if (ns) {
      nextHtml = '<span class="due-badge ' + dueClass(ns.days) + '">' + dueLabel(ns.days) + '</span> <span class="cl-who">' + escapeHtml(ns.contact.name || "(unnamed contact)") + '</span>';
    } else if ((l.contacts || []).length) {
      nextHtml = '<span class="cl-muted">No follow-up scheduled</span>';
    } else {
      nextHtml = '<span class="cl-muted">No contacts yet</span>';
    }
    return '' +
      '<button type="button" class="cl-card" data-action="crm-open" data-id="' + l.id + '">' +
        '<span class="cl-top"><span class="cl-name">' + escapeHtml(l.company) + '</span><span class="pill ' + priorityClass(l.priority) + '">' + l.priority + '</span></span>' +
        '<span class="cl-role">' + escapeHtml(l.jobTitle || l.roleType || "") + '</span>' +
        '<span class="cl-row"><span class="pill status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status) + '</span>' +
          '<span class="cl-dots" title="Outreach plan: ' + step + ' of ' + SEQUENCE.length + ' touches">' + dots + '</span></span>' +
        '<span class="cl-row cl-next">' + nextHtml + '</span>' +
        '<span class="cl-foot">' + (nC ? nC + (nC === 1 ? ' contact' : ' contacts') : 'Add a contact to start outreach') +
          (last ? ' · last touch ' + fmtDate(last) : (nC ? ' · no touches logged yet' : '')) + '</span>' +
      '</button>';
  }

  function renderClients() {
    if (crmLeadId) {
      var open = findLead(crmLeadId);
      if (open && open.inCrm) return renderClientCard(open);
      if (state.leads.length) crmLeadId = null;
    }
    var all = crmLeads();
    var q = clientQuery.trim().toLowerCase();
    var counts = { Active: 0, Clients: 0, Closed: 0, All: all.length };
    all.forEach(function (l) { counts[crmGroupOf(l)]++; });
    var list = all.filter(function (l) {
      if (crmFilter !== "All" && crmGroupOf(l) !== crmFilter) return false;
      return !q || (l.company + " " + (l.jobTitle || "") + " " + (l.roleType || "")).toLowerCase().indexOf(q) !== -1;
    });
    list.sort(function (a, b) {
      var na = leadNextStep(a), nb = leadNextStep(b);
      var da = na ? na.days : 9999, db = nb ? nb.days : 9999;
      return da - db || priorityRank(a.priority) - priorityRank(b.priority) || a.company.localeCompare(b.company);
    });
    var dueNow = all.filter(function (l) { var n = leadNextStep(l); return n && n.days <= 0 && crmGroupOf(l) === "Active"; }).length;
    var talking = all.filter(function (l) { return l.status === "Replied" || l.status === "Meeting Booked" || l.status === "Proposal Sent"; }).length;
    var stats = '' +
      '<div class="stats">' +
        '<div class="stat"><div class="num mono">' + counts.Active + '</div><div class="lbl">Active prospects</div></div>' +
        '<div class="stat' + (dueNow > 0 ? " stat-highlight" : "") + '"><div class="num mono">' + dueNow + '</div><div class="lbl">Follow-ups due</div></div>' +
        '<div class="stat"><div class="num mono">' + talking + '</div><div class="lbl">In conversation</div></div>' +
        '<div class="stat"><div class="num mono">' + counts.Clients + '</div><div class="lbl">Clients won</div></div>' +
      '</div>';
    var chips = ["Active", "Clients", "Closed", "All"].map(function (g) {
      return '<button class="chip" type="button" aria-pressed="' + (crmFilter === g) + '" data-action="crm-filter" data-value="' + g + '">' + g + ' (' + counts[g] + ')</button>';
    }).join("");
    var body;
    if (!all.length) {
      body = '<div class="empty crm-empty"><strong>No prospects in your CRM yet.</strong><br>When a lead looks worth pursuing, open it in the Leads tab and press <em>★ Save to CRM</em>. It then gets its own full-page client card here, with status, people, outreach plan, timeline and notes in one place.<div style="margin-top:12px"><button class="btn btn-primary" type="button" data-action="set-view" data-view="leads">Go to Leads</button></div></div>';
    } else if (!list.length) {
      body = '<div class="empty">No prospects match this filter.</div>';
    } else {
      body = '<div class="cl-grid">' + list.map(renderClientListCard).join("") + '</div>';
    }
    return stats +
      '<div class="crm-toolbar cl-toolbar">' +
        '<div class="chipset">' + chips + '</div>' +
        '<div class="search crm-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
        '<input type="text" placeholder="Search prospects" value="' + escapeHtml(clientQuery) + '" data-action="client-search"></div>' +
      '</div>' + body;
  }

  function renderTimeline(l) {
    var items = [];
    (l.contacts || []).forEach(function (c) {
      (c.activities || []).forEach(function (a, i) { items.push({ date: a.date || "", i: i, who: c.name || "(unnamed contact)", type: a.type, dir: a.direction, text: a.summary || "", cid: c.id, aid: a.id }); });
    });
    (l.notes || []).forEach(function (n, i) { items.push({ date: n.date || "", i: i, who: "Company note", type: "Note", dir: "", text: n.text || "", company: true }); });
    items.sort(function (a, b) { var dc = b.date.localeCompare(a.date); return dc !== 0 ? dc : b.i - a.i; });
    var shown = items.slice(0, tlLimit);
    var rows = shown.map(function (it) {
      var dirHtml = it.type === "Note" ? "" : '<span class="act-dir ' + (it.dir === "Inbound" ? "act-in" : "act-out") + '">' + (it.dir === "Inbound" ? "↙ In" : "↗ Out") + '</span>';
      return '<div class="tl-item"><div class="tl-date">' + fmtDate(it.date) + '</div><div class="tl-main"><div class="tl-head"><span class="tl-who' + (it.company ? " tl-co" : "") + '">' + escapeHtml(it.who) + '</span><span class="tl-type">' + escapeHtml(it.type) + '</span>' + dirHtml +
        (readOnly || !it.aid ? "" : '<button type="button" class="act-del" data-action="remove-activity" data-id="' + l.id + '" data-cid="' + it.cid + '" data-aid="' + escapeHtml(it.aid) + '" aria-label="Delete activity">✕</button>') + '</div>' +
        (it.text ? '<div class="tl-text">' + escapeHtml(it.text) + '</div>' : '') + '</div></div>';
    }).join("");
    var more = items.length > shown.length ? '<button type="button" class="btn btn-sm" data-action="tl-more">Show more (' + (items.length - shown.length) + ' older)</button>' : '';
    var note = readOnly ? "" : '<div class="add-note"><textarea id="note-input-' + l.id + '" placeholder="Add a note about this company: a call, an insight, a reminder…"></textarea><button class="btn btn-sm btn-primary" type="button" data-action="add-note" data-id="' + l.id + '">Add note</button></div>';
    return '<section class="cc-sec"><h3>Activity &amp; notes</h3>' + note +
      '<div class="tl">' + (rows || '<div class="ag-empty">Nothing logged yet. Log a touch from a contact above, or add a note.</div>') + '</div>' + more + '</section>';
  }

  function renderClientCard(l) {
    var d = readOnly ? " disabled" : "";
    var statusGroups = [
      ["In progress", ["Not Started", "Researching", "Contacted", "Replied", "Meeting Booked", "Proposal Sent", "Won"]],
      ["Closed", ["Lost", "Not a Fit"]]
    ];
    var statusHtml = statusGroups.map(function (g) {
      return '<div class="seg-group"><span class="seg-label">' + g[0] + '</span><div class="seg">' + g[1].map(function (st) {
        return '<button type="button" class="seg-btn ' + statusClass(st) + '" aria-pressed="' + (l.status === st) + '" data-action="card-status" data-id="' + l.id + '" data-value="' + escapeHtml(st) + '"' + d + '>' + escapeHtml(st) + '</button>';
      }).join("") + '</div></div>';
    }).join("");
    var prioHtml = '<div class="seg">' + PRIORITIES.map(function (pr) {
      return '<button type="button" class="seg-btn seg-prio-' + pr.toLowerCase() + '" aria-pressed="' + (l.priority === pr) + '" data-action="card-priority" data-id="' + l.id + '" data-value="' + pr + '"' + d + '>' + pr + '</button>';
    }).join("") + '</div>';

    // Next step
    var ns = leadNextStep(l);
    var nextHtml;
    if (ns) {
      var nt = nextTouch(ns.contact);
      nextHtml = '<span class="due-badge ' + dueClass(ns.days) + '">' + dueLabel(ns.days) + '</span>' +
        '<div class="ns-main"><strong>' + escapeHtml(ns.contact.name || "(unnamed contact)") + '</strong>' + (ns.contact.title ? ' · ' + escapeHtml(ns.contact.title) : '') +
        '<div class="ns-sub">' + (nt ? escapeHtml(touchShort(ns.contact, nt)) : escapeHtml(ns.contact.stage || "Not contacted")) + ' · ' + fmtDate(ns.contact.nextFollowUp) + '</div></div>' +
        (readOnly ? "" : '<button type="button" class="btn btn-primary" data-action="crm-log" data-id="' + l.id + '" data-cid="' + ns.contact.id + '">' + (nt ? 'Log touch ' + nt.n : 'Log activity') + '</button>');
    } else {
      var fc = firstContact(l);
      if (fc && (fc.stage || "Not contacted") === "Not contacted") {
        nextHtml = '<span class="due-badge due-soon">Not started</span><div class="ns-main"><strong>Start with ' + escapeHtml(fc.name || "(unnamed contact)") + '</strong>' + (fc.title ? ' · ' + escapeHtml(fc.title) : '') +
          '<div class="ns-sub">' + escapeHtml(nextTouch(fc) ? touchShort(fc, nextTouch(fc)) : "") + '</div></div>' +
          (readOnly ? "" : '<button type="button" class="btn btn-primary" data-action="crm-log" data-id="' + l.id + '" data-cid="' + fc.id + '">Log touch 1</button>');
      } else {
        nextHtml = '<div class="ns-main"><strong>' + ((l.contacts || []).length ? 'No follow-up scheduled' : 'No contacts yet') + '</strong><div class="ns-sub">' +
          ((l.contacts || []).length ? 'Log a touch, or set a follow-up date on a contact below.' : 'Add the person you will reach out to first.') + '</div></div>';
      }
    }

    // Company and roles
    var profile = cardMore ? (l.companyProfile || "—") : (shortText(l.companyProfile, 230) || "—");
    var fit = cardMore ? (l.nearshoreFit || "—") : shortText(l.nearshoreFit, 200);
    var skills = cardMore ? (l.requiredSkills || "") : shortText(l.requiredSkills, 140);
    var hasMore = (l.companyProfile || "").length > 230 || (l.nearshoreFit || "").length > 200 || (l.requiredSkills || "").length > 140;
    var rd = daysSince(l.datePosted);
    var company = '' +
      '<section class="cc-sec"><h3>Company</h3>' +
        '<p class="cc-text">' + escapeHtml(profile) + '</p>' +
        '<div class="cc-facts">' +
          (l.estSize ? '<span><em>Size</em> ' + escapeHtml(shortText(l.estSize, 60)) + '</span>' : '') +
          (l.endClient ? '<span><em>End client</em> ' + escapeHtml(l.endClient) + '</span>' : '') +
        '</div>' +
        (fit ? '<h4>Nearshore fit</h4><p class="cc-text">' + escapeHtml(fit) + '</p>' : '') +
        (hasMore ? '<button type="button" class="btn-link" data-action="card-more">' + (cardMore ? 'Show less' : 'Show full details') + '</button>' : '') +
      '</section>' +
      '<section class="cc-sec"><h3>Open role</h3>' +
        '<div class="role-line"><strong>' + escapeHtml(l.jobTitle || "—") + '</strong>' + (l.roleType ? '<span class="role-tag">' + escapeHtml(l.roleType) + '</span>' : '') + '</div>' +
        '<div class="cc-facts">' +
          (l.employmentType ? '<span>' + escapeHtml(l.employmentType) + '</span>' : '') +
          (rd !== null ? '<span>Posted ' + rd + 'd ago</span>' : '') +
        '</div>' +
        (skills ? '<p class="cc-text">' + escapeHtml(skills) + '</p>' : '') +
        '<div class="links">' +
          (l.jobUrl ? '<a href="' + escapeHtml(l.jobUrl) + '" target="_blank" rel="noopener">Job posting ↗</a>' : '') +
          (l.website ? '<a href="' + escapeHtml(l.website) + '" target="_blank" rel="noopener">Company site ↗</a>' : '') +
        '</div>' +
      '</section>';

    var isWon = l.status === "Won";
    inClientCard = true;
    var people;
    try { people = renderContactsPanel(l).replace('<h4>Contacts</h4>', ''); } finally { inClientCard = false; }
    return '' +
      '<div class="client-card">' +
        '<div class="cc-back"><button type="button" class="btn btn-sm" data-action="crm-back">← All prospects</button>' +
          (readOnly ? "" : '<button type="button" class="btn-link" data-action="crm-remove" data-id="' + l.id + '">Remove from CRM</button>') + '</div>' +
        '<header class="cc-head">' +
          '<div><h2>' + escapeHtml(l.company) + '</h2><div class="cc-sub">Saved ' + fmtDate(l.crmSavedAt) + (l.estSize ? ' · ' + escapeHtml(shortText(l.estSize, 40)) : '') + '</div></div>' +
        '</header>' +
        '<div class="cc-controls">' +
          '<div class="cc-ctl"><div class="cc-lbl">Status</div><div class="seg-wrap">' + statusHtml + '</div></div>' +
          '<div class="cc-ctl"><div class="cc-lbl">Priority</div>' + prioHtml + '</div>' +
        '</div>' +
        '<div class="cc-next"><div class="cc-lbl">Next step</div><div class="ns-row">' + nextHtml + '</div></div>' +
        '<div class="cc-grid">' +
          '<div class="cc-main">' +
            '<section class="cc-sec"><h3>People &amp; outreach plan</h3>' + people + '</section>' +
            renderTimeline(l) +
          '</div>' +
          '<aside class="cc-side">' + company +
            '<section class="cc-sec"><h3>Client info</h3>' + renderClientInfoPanel(l).replace('<h4>Client info</h4>', '') + '</section>' +
            '<section class="cc-sec"><h3>Documents</h3>' + renderDocumentsPanel(l).replace('<h4>Documents</h4>', '') + '</section>' +
          '</aside>' +
        '</div>' +
        (isWon ? '<section class="cc-sec cc-wide">' + renderCandidatesPanel(l) + '</section>' : '') +
      '</div>';
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

  /* ---------------- playbook ---------------- */

  function newPbId() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  function findPb(id) {
    for (var i = 0; i < playbook.length; i++) if (playbook[i].id === id) return playbook[i];
    return null;
  }

  function pbSave(item) {
    pbPending++;
    return fetch("/api/playbook/" + encodeURIComponent(item.id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: item.kind, title: item.title, body: item.body, tag: item.tag })
    }).then(function (res) {
      if (res.status === 401) { window.location.href = "/auth/login"; return; }
      if (!res.ok) throw new Error("HTTP " + res.status);
    }).catch(function (err) {
      toast("Couldn't save to the playbook: " + (err && err.message ? err.message : "unknown error") + ". Try again.");
    }).then(function () { pbPending--; });
  }

  function pbDelete(id) {
    pbPending++;
    return fetch("/api/playbook/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {
      toast("Couldn't delete that item. Try again.");
    }).then(function () { pbPending--; });
  }

  function pbAdd(kind) {
    var item = { id: newPbId(), kind: kind, title: "", body: "", tag: kind === "template" ? TEMPLATE_TAGS[0] : "", createdAt: new Date().toISOString() };
    playbook.push(item);
    pbSave(item);
    render();
    var box = document.querySelector('[data-pid="' + item.id + '"][data-field="title"]');
    if (box) box.focus();
  }

  function pbAddNote() {
    var body = (pbDraft.body || "").trim();
    if (!body) { toast("Type or dictate something first."); return; }
    stopDictation();
    var item = { id: newPbId(), kind: "note", title: "", body: body, tag: pbDraft.tag, createdAt: new Date().toISOString() };
    playbook.push(item);
    pbDraft.body = "";
    pbSave(item);
    render();
    toast("Note saved. Claude can read it when writing your templates.");
  }

  function pbRemove(id) {
    var item = findPb(id);
    if (!item) return;
    var label = item.kind === "note" ? "this note" : "“" + (item.title || "this item") + "”";
    if (!window.confirm("Delete " + label + "? This can't be undone.")) return;
    playbook = playbook.filter(function (x) { return x.id !== id; });
    pbDelete(id);
    render();
  }

  function pbCopy(id) {
    var item = findPb(id);
    if (!item) return;
    var text = item.body || "";
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Copied."); }, function () { toast("Couldn't copy. Select the text and copy it by hand."); });
    } else {
      toast("Couldn't copy. Select the text and copy it by hand.");
    }
  }

  function stopDictation() {
    if (dictation.rec && dictation.on) { try { dictation.rec.stop(); } catch (e) { /* ignore */ } }
    dictation.on = false;
  }

  function toggleDictation() {
    if (!SpeechRec) return;
    if (dictation.on) { stopDictation(); render(); return; }
    var rec = new SpeechRec();
    rec.lang = dictation.lang;
    rec.continuous = true;
    rec.interimResults = true;
    var base = pbDraft.body ? pbDraft.body.replace(/\s+$/, "") + " " : "";
    var finalText = "";
    rec.onresult = function (ev) {
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript + " "; else interim += r[0].transcript;
      }
      pbDraft.body = base + finalText + interim;
      var ta = document.getElementById("pb-draft");
      if (ta) ta.value = pbDraft.body;
    };
    rec.onerror = function (ev) {
      var code = ev && ev.error;
      if (code === "not-allowed" || code === "service-not-allowed") toast("The microphone is blocked. Allow it from the lock icon in your browser's address bar, then try again.");
      else if (code === "no-speech") toast("Didn't hear anything. Try again.");
      else if (code !== "aborted") toast("Dictation stopped (" + code + ").");
    };
    rec.onend = function () {
      var wasOn = dictation.on;
      dictation.on = false;
      pbDraft.body = (base + finalText).replace(/\s+$/, "");
      if (wasOn || view === "playbook") { if (view === "playbook") render(); }
    };
    dictation.rec = rec;
    dictation.on = true;
    try { rec.start(); } catch (e) { dictation.on = false; toast("Couldn't start the microphone."); }
    render();
  }

  function micIcon() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  }

  function fmtIsoDay(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return "";
    return fmtDate(d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()));
  }

  function renderPbCard(item, opts) {
    var d = readOnly ? " disabled" : "";
    function f(field) { return 'data-action="pb-edit" data-field="' + field + '" data-pid="' + item.id + '"' + d; }
    var head = '';
    if (item.kind === "note") {
      head = '<span class="pb-tagpill">' + escapeHtml(item.tag || "Note") + '</span><span class="pb-date">' + escapeHtml(fmtIsoDay(item.createdAt)) + '</span>';
    } else {
      head = '<input class="pb-title" type="text" placeholder="' + escapeHtml(opts.titlePlaceholder) + '" value="' + escapeHtml(item.title) + '" ' + f("title") + '>';
      if (item.kind === "template") {
        var tags = TEMPLATE_TAGS.slice();
        if (item.tag && tags.indexOf(item.tag) === -1) tags.push(item.tag);
        head += '<select class="mini" ' + f("tag") + ' aria-label="Which touch is this for">' + tags.map(function (t) { return '<option value="' + escapeHtml(t) + '"' + (item.tag === t ? " selected" : "") + '>' + escapeHtml(t) + '</option>'; }).join("") + '</select>';
      }
    }
    return '' +
      '<div class="pb-card">' +
        '<div class="pb-head">' + head +
          '<span class="pb-actions">' +
            (item.kind === "note" ? "" : '<button type="button" class="btn btn-sm" data-action="pb-copy" data-pid="' + item.id + '">Copy</button>') +
            (readOnly ? "" : '<button type="button" class="btn btn-ghost btn-sm" data-action="pb-delete" data-pid="' + item.id + '" aria-label="Delete">✕</button>') +
          '</span>' +
        '</div>' +
        '<textarea class="pb-body" rows="' + (item.kind === "note" ? 3 : 4) + '" placeholder="' + escapeHtml(opts.bodyPlaceholder) + '" ' + f("body") + '>' + escapeHtml(item.body) + '</textarea>' +
      '</div>';
  }

  function renderPlaybook() {
    var notes = playbook.filter(function (x) { return x.kind === "note"; }).slice().sort(function (a, b) { return (b.createdAt || "").localeCompare(a.createdAt || ""); });
    var objections = playbook.filter(function (x) { return x.kind === "objection"; });
    var templates = playbook.filter(function (x) { return x.kind === "template"; });
    var tagOpts = NOTE_TAGS.map(function (t) { return '<option value="' + t + '"' + (pbDraft.tag === t ? " selected" : "") + '>' + t + '</option>'; }).join("");
    var langOpts = [["en-US", "English"], ["es-ES", "Español"]].map(function (l) { return '<option value="' + l[0] + '"' + (dictation.lang === l[0] ? " selected" : "") + '>' + l[1] + '</option>'; }).join("");
    var mic = SpeechRec
      ? '<button type="button" class="btn btn-sm mic-btn' + (dictation.on ? ' mic-on' : '') + '" data-action="pb-dictate" aria-pressed="' + dictation.on + '">' + micIcon() + (dictation.on ? ' Stop dictating' : ' Dictate') + '</button>' +
        '<select class="mini" data-action="pb-lang" aria-label="Dictation language"' + (dictation.on ? " disabled" : "") + '>' + langOpts + '</select>'
      : '<span class="help" style="margin:0">Dictation isn\'t available in this browser. Try Chrome, Edge or Safari, or use your keyboard\'s built-in dictation in the box.</span>';
    var form = readOnly ? "" : '' +
      '<div class="pb-form">' +
        '<textarea id="pb-draft" class="pb-body" rows="4" data-action="pb-draft" placeholder="Type or dictate: what you learned, a concern, something prospects keep saying…">' + escapeHtml(pbDraft.body) + '</textarea>' +
        '<div class="pb-form-row">' + mic +
          '<select class="mini" data-action="pb-tag" aria-label="Note type">' + tagOpts + '</select>' +
          '<button type="button" class="btn btn-sm btn-primary" data-action="pb-add-note">Save note</button>' +
          (dictation.on ? '<span class="pb-listening">Listening…</span>' : '') +
        '</div>' +
      '</div>';
    return '' +
      '<div class="crm-section"><h3>Research notes</h3>' +
        '<p class="help" style="margin:0 0 10px">Anything you have learned or worry about that could shape outreach. Saved notes are stored in Radar, and Claude reads them when you ask it to write templates or tune the plan. Dictation uses your browser\'s speech recognition, which may send the audio to the browser maker (Google, in Chrome).</p>' +
        form +
        '<div class="pb-list">' + (notes.length ? notes.map(function (n) { return renderPbCard(n, { bodyPlaceholder: "Note" }); }).join("") : '<div class="ag-empty">No notes yet.</div>') + '</div>' +
      '</div>' +
      '<div class="crm-section"><h3>Objection cheat sheet</h3>' +
        '<p class="help" style="margin:0 0 10px">What a prospect might say, and how to answer. Edit anything to match how Nimbl really works.</p>' +
        '<div class="pb-list">' + (objections.length ? objections.map(function (o) { return renderPbCard(o, { titlePlaceholder: "What they say", bodyPlaceholder: "How to answer" }); }).join("") : '<div class="ag-empty">No objections yet.</div>') + '</div>' +
        (readOnly ? "" : '<button type="button" class="btn btn-sm" data-action="pb-add" data-kind="objection">+ Add objection</button>') +
      '</div>' +
      '<div class="crm-section"><h3>Message templates</h3>' +
        '<p class="help" style="margin:0 0 10px">Ready-to-send messages for each touch. Ask Claude to write a set from your research notes, or write your own. Copy puts the text on your clipboard for LinkedIn.</p>' +
        '<div class="pb-list">' + (templates.length ? templates.map(function (t) { return renderPbCard(t, { titlePlaceholder: "Template name", bodyPlaceholder: "Message text" }); }).join("") : '<div class="ag-empty">No templates yet. When you are ready, ask Claude to generate them.</div>') + '</div>' +
        (readOnly ? "" : '<button type="button" class="btn btn-sm" data-action="pb-add" data-kind="template">+ Add template</button>') +
      '</div>';
  }

  function loadPlaybook() {
    return fetch("/api/playbook").then(function (res) {
      if (res.status === 401) { window.location.href = "/auth/login"; return null; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (items) {
      if (!items || pbPending > 0) return;
      if (JSON.stringify(items) !== JSON.stringify(playbook)) {
        playbook = items;
        var a = document.activeElement;
        var typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
        if (view === "playbook" && !typing && !dictation.on) render();
      }
    }).catch(function () { /* the playbook is optional; leads keep working without it */ });
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
      (view === "pipeline" ? renderCrm() : view === "crm" ? renderClients() : view === "playbook" ? renderPlaybook() : (
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
      ((view === "pipeline" || view === "crm") ? renderCrmModal() : "");
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
    l.contacts.push({ id: "c" + Date.now().toString(36), name: "", title: "", email: "", phone: "", linkedin: "", roles: [], stage: "Not contacted", nextFollowUp: "", lastContacted: "", sequenceStep: 0, isPrimary: false, activities: [] });
    var newId = l.contacts[l.contacts.length - 1].id;
    ctOpen[newId] = true;
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

  // Sequence step once this activity is saved: an outbound touch counts as one more touch.
  function stepAfterLog(c, f, stageAfter) {
    var step = Math.max(seqStep(c), STAGE_MIN_STEP[stageAfter] || 0);
    if (f.direction !== "Inbound" && f.type !== "Note") step = Math.min(SEQUENCE.length, seqStep(c) + 1);
    return Math.max(step, STAGE_MIN_STEP[stageAfter] || 0);
  }

  function defaultFollowUp(f, c) {
    var existing = c.nextFollowUp || "";
    if (f.type === "Note") return existing;
    var stageAfter = f.moveStage || c.stage || "Not contacted";
    var base = isIsoDate(f.date) ? f.date : todayStr();
    var cadence = sequenceFollowUp(c, stageAfter, stepAfterLog(c, f, stageAfter), base);
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
    var nt = nextTouch(c);
    activityForm = {
      leadId: id, cid: cid,
      type: nt ? touchType(c, nt) : (stage === "Not contacted" ? "LinkedIn connection" : "LinkedIn message"),
      direction: "Outbound", date: todayStr(), summary: nt ? "Touch " + nt.n + ": " + nt.name : "", moveStage: "", followUp: "",
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
    var newStep = stepAfterLog(c, f, f.moveStage || c.stage || "Not contacted"); // before the stage changes
    if (f.moveStage) c.stage = f.moveStage;
    c.sequenceStep = newStep;
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
    c.sequenceStep = seqStageFloor(c, stage);
    if (stage === "Not interested") {
      c.nextFollowUp = "";
    } else {
      var due = !isIsoDate(c.nextFollowUp) || c.nextFollowUp <= today; // nothing scheduled, or already due
      var cadence = sequenceFollowUp(c, stage, seqStep(c), today);
      if (cadence && (due || cadence < c.nextFollowUp)) c.nextFollowUp = cadence; // an earlier nudge wins (e.g. they just accepted)
      else if (!cadence && due) c.nextFollowUp = "";
    }
    if (!c.activities) c.activities = [];
    c.activities.push({ id: newActId(), type: "Note", direction: "Outbound", date: today, summary: "Stage changed: " + prev + " → " + stage });
    autoAdvanceLead(l, stage);
    persist();
  }

  function skipTouch(id, cid) {
    var l = findLead(id);
    var c = findContact(l, cid);
    var nt = c && nextTouch(c);
    if (!nt) return;
    var today = todayStr();
    c.activities = c.activities || [];
    c.activities.push({ id: newActId(), type: "Note", direction: "Outbound", date: today, summary: "Skipped touch " + nt.n + " (" + nt.name + ")" });
    c.sequenceStep = nt.n;
    var nxt = sequenceFollowUp(c, c.stage || "Not contacted", seqStep(c), today);
    if (nxt) c.nextFollowUp = nxt;
    persist();
  }

  function setSeqStep(id, cid, value) {
    var c = findContact(findLead(id), cid);
    if (!c) return;
    var n = parseInt(value, 10);
    if (isNaN(n)) return;
    c.sequenceStep = Math.min(SEQUENCE.length, Math.max(0, n));
    var nxt = sequenceFollowUp(c, c.stage || "Not contacted", seqStep(c), todayStr());
    if (nxt) c.nextFollowUp = nxt;
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
    if (!silent || !dictation.on) loadPlaybook();
    loadFiles();
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
    if (action === "goto-lead") { var gl = findLead(id); if (gl && gl.inCrm) { openClient(id); } else { gotoLead(id); } return; }
    if (action === "file-remove") { removeFile(t.getAttribute("data-fid")); return; }
    if (action === "crm-save") { saveToCrm(id); return; }
    if (action === "crm-remove") { removeFromCrm(id); return; }
    if (action === "crm-open") { openClient(id); return; }
    if (action === "crm-back") { closeClient(); return; }
    if (action === "crm-filter") { crmFilter = t.getAttribute("data-value"); render(); return; }
    if (action === "card-more") { cardMore = !cardMore; render(); return; }
    if (action === "ct-toggle") { if (ctOpen[cid]) { delete ctOpen[cid]; } else { ctOpen[cid] = true; } render(); return; }
    if (action === "tl-more") { tlLimit += 12; render(); return; }
    if (action === "card-status") { setStatus(id, t.getAttribute("data-value")); return; }
    if (action === "card-priority") { setPriority(id, t.getAttribute("data-value")); return; }
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
    if (action === "pb-add-note") { pbAddNote(); return; }
    if (action === "pb-dictate") { toggleDictation(); return; }
    if (action === "pb-add") { pbAdd(t.getAttribute("data-kind")); return; }
    if (action === "pb-delete") { pbRemove(t.getAttribute("data-pid")); return; }
    if (action === "pb-copy") { pbCopy(t.getAttribute("data-pid")); return; }
    if (action === "skip-touch") { skipTouch(id, cid); return; }
    if (action === "toggle-primary") { setPrimary(id, cid); return; }
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
    if (action === "file-input") { uploadFiles(id, cid, t.files); return; }
    if (action === "set-status") { setStatus(id, t.value); return; }
    if (action === "set-priority") { setPriority(id, t.value); return; }
    if (action === "set-contact-stage") { setContactStage(id, cid, t.value); return; }
    if (action === "set-followup") { setFollowUp(id, cid, t.value); return; }
    if (action === "set-seq-step") { setSeqStep(id, cid, t.value); return; }
    if (action === "pb-tag") { pbDraft.tag = t.value; return; }
    if (action === "pb-lang") {
      dictation.lang = t.value;
      try { window.localStorage.setItem("radar-dictation-lang", t.value); } catch (e) { /* ignore */ }
      return;
    }
    if (action === "pb-edit") {
      var pbItem = findPb(t.getAttribute("data-pid"));
      if (pbItem) { pbItem[t.getAttribute("data-field")] = t.value; pbSave(pbItem); }
      return;
    }
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
    if (e.target.getAttribute("data-action") === "client-search") {
      clientQuery = e.target.value;
      render();
      var ci2 = document.querySelector('input[data-action="client-search"]');
      if (ci2) { ci2.focus(); ci2.setSelectionRange(ci2.value.length, ci2.value.length); }
      return;
    }
    if (e.target.getAttribute("data-action") === "pb-draft") { pbDraft.body = e.target.value; return; }
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
    if (e.key === "Escape" && (view === "pipeline" || view === "crm") && activityForm) { activityForm = null; render(); return; }
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
      loadPlaybook();
      loadFiles();
    }).catch(function (err) {
      document.getElementById("app").innerHTML =
        '<div class="empty">Couldn\'t load data from the server: ' + escapeHtml(err.message) + '. Is the API running and DATABASE_URL configured?</div>';
    });
  }

  window.addEventListener("popstate", function () {
    var parts = (window.location.hash || "").replace(/^#/, "").split("/");
    var next = VIEWS.indexOf(parts[0]) !== -1 ? parts[0] : "leads";
    activityForm = null;
    stopDictation();
    view = next;
    crmLeadId = next === "crm" && parts[1] ? decodeURIComponent(parts[1]) : null;
    if (state.leads.length) render();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.leads.length) refreshData(true);
  });

  document.title = "Nimbl Radar";
  loadState();
}());
