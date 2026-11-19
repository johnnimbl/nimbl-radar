// "Sign in with Google" for the Chrome extension: create a key for the signed-in person and hand it
// straight to the extension that opened this page (it lists Radar in externally_connectable).
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ext = new URLSearchParams(location.search).get("ext") || "";
  var validExt = /^[a-p]{32}$/.test(ext);
  function show(text, ok) { var o = $("out"); o.className = "msg " + (ok ? "ok" : "err"); o.textContent = text; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function initials(n) { return String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0].toUpperCase(); }).join(""); }

  fetch("/auth/me").then(function (r) { return r.json(); }).then(function (who) {
    var u = who && who.user;
    if (!u) return;
    var w = $("who");
    w.innerHTML = (u.photo ? '<img src="' + esc(u.photo) + '" alt="" referrerpolicy="no-referrer">' : '<span class="ini">' + esc(initials(u.name || u.email)) + "</span>") +
      "<div><strong>" + esc(u.name || u.email) + '</strong><span class="muted">' + esc(u.email || "") + "</span></div>";
    w.hidden = false;
  }).catch(function () {});

  if (!validExt) { show("Open this page from the extension: its settings page has a “Sign in with Google” button.", false); $("connect").disabled = true; }

  $("cancel").addEventListener("click", function () { show("Not connected. You can close this tab.", false); $("actions").hidden = true; });

  $("connect").addEventListener("click", function () {
    var btn = $("connect");
    btn.disabled = true;
    show("Connecting…", true);
    fetch("/api/extension-keys/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "HTTP " + r.status); return d; }); })
      .then(function (d) {
        var fallback = function (why) {
          show(why, false);
          $("key").textContent = d.key; $("fallback").hidden = false; $("actions").hidden = true;
        };
        if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
          fallback("The extension isn't installed in this browser, or it needs updating to version 1.3.");
          return;
        }
        try {
          chrome.runtime.sendMessage(ext, { type: "radar-connect", key: d.key }, function (resp) {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              fallback("Couldn't reach the extension" + (resp && resp.error ? ": " + resp.error : "") + ".");
              return;
            }
            $("actions").hidden = true;
            $("intro").textContent = "You're all set. The extension is now signed in as " + (d.user.name || d.user.email) + ".";
            show("Connected. You can close this tab.", true);
            setTimeout(function () { window.close(); }, 1800);
          });
        } catch (e) { fallback("Couldn't reach the extension."); }
      })
      .catch(function (err) { btn.disabled = false; show("Couldn't connect: " + err.message, false); });
  });

  $("copy").addEventListener("click", function () {
    navigator.clipboard.writeText($("key").textContent).then(function () { show("Key copied.", true); }, function () { show("Select the key and copy it.", false); });
  });
})();
