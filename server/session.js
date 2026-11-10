const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);

// Logins are stored in the database (table "user_sessions", created automatically) instead of the
// server's memory. Render's free plan restarts the server on every deploy and after ~15 minutes
// idle; with memory-backed sessions each restart signed everyone out.
function buildSession(pool) {
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
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
    rolling: true, // each visit pushes the 30-day expiry forward
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: thirtyDays,
    },
  });
}

module.exports = { buildSession };
