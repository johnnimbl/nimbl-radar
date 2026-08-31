require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const { pool } = require("./db");
const { getState, putState } = require("./state");
const { configurePassport, ensureAuthenticated, googleLoginEnabled, ALLOWED_DOMAIN } = require("./auth");

const app = express();
app.set("trust proxy", 1); // Render terminates TLS upstream; needed for secure cookies
app.use(express.json({ limit: "5mb" }));

// --- Optional shared-password protection -----------------------------------
// Legacy stopgap, kept for local/dev use. If Google sign-in is configured
// (below) it supersedes this — leave APP_USER/APP_PASSWORD unset once Google
// login is on.
if (process.env.APP_USER && process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === process.env.APP_USER && pass === process.env.APP_PASSWORD) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Nimbl Radar"');
    res.status(401).send("Authentication required.");
  });
}

// --- Google sign-in ----------------------------------------------------------
// Restricted to accounts on ALLOWED_DOMAIN (see server/auth.js). Skipped
// entirely if GOOGLE_CLIENT_ID/SECRET aren't set, so local dev stays simple.
configurePassport();
app.use(
  session({
    secret: process.env.SESSION_SECRET || "nimbl-radar-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());

app.get("/auth/login", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect("/");
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/auth/login?error=domain" }),
  (req, res) => res.redirect("/")
);

app.post("/auth/logout", (req, res) => {
  req.logout(() => res.redirect("/auth/login"));
});

app.get("/auth/me", (req, res) => {
  if (!googleLoginEnabled) return res.json({ enabled: false });
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ enabled: true, user: req.user });
  }
  res.status(401).json({ enabled: true, user: null });
});

app.get("/", ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/api/state", ensureAuthenticated, async (req, res) => {
  try {
    res.json(await getState(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load state." });
  }
});

app.put("/api/state", ensureAuthenticated, async (req, res) => {
  try {
    await putState(pool, req.body || {});
    res.json(await getState(pool));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save state." });
  }
});

app.get("/index.html", ensureAuthenticated, (req, res) => res.redirect("/"));
app.use(express.static(path.join(__dirname, "..", "public")));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Nimbl Radar listening on http://localhost:${port}`);
});
