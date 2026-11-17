const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);

// Logins are stored in the database (table "user_sessions", created automatically) instead of the
// server's memory. Render's free plan restarts the server on every deploy and after ~15 minutes
// idle; with memory-backed sessions each restart signed everyone out.
function buildSession(pool) {
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET is not set: using the development secret. Set it on the server.");
  return session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 60, // clear expired sessions hourly (seconds)
    }),
    secret: process.env.SESSION_SECRET || "nimbl-radar-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    rolling: true, // each visit pushes the 14-day expiry forward; 14 days without a visit signs you out
    cookie: {
      secure: "auto", // Secure on HTTPS (Render), so the cookie never travels over plain HTTP
      httpOnly: true,
      sameSite: "lax",
      maxAge: fourteenDays,
    },
  });
}

module.exports = { buildSession };
