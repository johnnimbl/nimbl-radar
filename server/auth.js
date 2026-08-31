const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

// --- Google sign-in, restricted to one email domain -------------------------
// This app can hold candidate PII (tax IDs, birthdates, payment info), so
// access is gated behind Google sign-in rather than left open. Anyone who
// signs in with a Google account on GOOGLE_ALLOWED_DOMAIN gets in; everyone
// else is turned away at the callback, before a session is ever created.
//
// Configure by setting these on the server (see .env.example):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  — from Google Cloud Console
//   GOOGLE_ALLOWED_DOMAIN                    — defaults to "nimbl.ai"
//   PUBLIC_URL                               — this app's public https URL,
//                                               used to build the callback URL
//
// If GOOGLE_CLIENT_ID isn't set, the login gate is skipped entirely (useful
// for local development) — the app behaves as it did before, open to anyone
// who can reach it.

const ALLOWED_DOMAIN = (process.env.GOOGLE_ALLOWED_DOMAIN || "nimbl.ai").toLowerCase();

const googleLoginEnabled = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
);

function configurePassport() {
  // Session only ever holds the small, non-secret profile fields below —
  // never the Google access/refresh token.
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  if (!googleLoginEnabled) return;

  const callbackURL = (process.env.PUBLIC_URL || "").replace(/\/$/, "") + "/auth/google/callback";

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL,
      },
      (accessToken, refreshToken, profile, done) => {
        const emailEntry = (profile.emails || []).find((e) => e.value) || {};
        const email = (emailEntry.value || "").toLowerCase();
        const verified = emailEntry.verified !== false; // passport-google-oauth20 sets this from Google
        const domain = email.split("@")[1] || "";

        if (!email || !verified || domain !== ALLOWED_DOMAIN) {
          return done(null, false, { message: "domain_not_allowed" });
        }

        return done(null, {
          email,
          name: profile.displayName || email,
          photo: (profile.photos && profile.photos[0] && profile.photos[0].value) || "",
        });
      }
    )
  );
}

function ensureAuthenticated(req, res, next) {
  if (!googleLoginEnabled) return next(); // gate disabled — local/dev mode
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Sign-in required." });
  }
  return res.redirect("/auth/login");
}

module.exports = { configurePassport, ensureAuthenticated, googleLoginEnabled, ALLOWED_DOMAIN };
