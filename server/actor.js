// Who is making a change. Every write the app makes on someone's behalf runs with their email in the
// Postgres setting radar.actor, so new rows record their author (column defaults) and the audit
// triggers (server/audit_schema.sql) know whom to credit. Writes made outside the app — Claude
// working on the database directly, the morning scan — have no actor and show as "Claude".
const { googleLoginEnabled } = require("./auth");

const OWNER_EMAILS = (process.env.OWNER_EMAILS || "john@nimbl.ai,jmvillarde@gmail.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Local development only: with Google sign-in switched off, tests can act as a named person.
function testUser(req) {
  if (googleLoginEnabled || process.env.NODE_ENV === "production" || process.env.RADAR_TEST_USERS !== "1") return null;
  const e = String(req.headers["x-test-user"] || "").trim().toLowerCase();
  return e ? { email: e, name: e.split("@")[0] } : null;
}

function emailOf(req) {
  if (req.extUser) return String(req.extUser).toLowerCase();
  const t = testUser(req);
  if (t) return t.email;
  return String((req.user && req.user.email) || "").toLowerCase();
}

function isOwner(req) {
  if (!googleLoginEnabled) {
    const t = testUser(req);
    return t ? OWNER_EMAILS.includes(t.email) : true; // no sign-in locally: everyone is the owner
  }
  return OWNER_EMAILS.includes(emailOf(req));
}

function requireOwner(req, res, next) {
  if (isOwner(req)) return next();
  res.status(403).json({ error: "Only the Radar owner can change this." });
}

const WRITE = /^\s*(insert|update|delete|with)\b/i;

// A drop-in for the pg pool whose writes carry the actor. Reads go straight through; each write runs
// in a short transaction that sets radar.actor first. connect() hands back a client whose BEGIN also
// sets it, so multi-step transactions (logActivity, putState) are covered too.
function actorPool(pool, actor) {
  const who = String(actor || "").slice(0, 200);
  const setActor = (c) => c.query("select set_config('radar.actor', $1, true)", [who]);
  return {
    actor: who,
    async query(text, params) {
      if (!who || !WRITE.test(String(text))) return pool.query(text, params);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await setActor(c);
        const r = await c.query(text, params);
        await c.query("COMMIT");
        return r;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally { c.release(); }
    },
    async connect() {
      const c = await pool.connect();
      const raw = c.query.bind(c);
      c.query = async (text, ...rest) => {
        const r = await raw(text, ...rest);
        if (who && typeof text === "string" && /^\s*begin\s*;?\s*$/i.test(text)) await raw("select set_config('radar.actor', $1, true)", [who]);
        return r;
      };
      const release = c.release.bind(c);
      c.release = (e) => { c.query = raw; return release(e); };
      return c;
    },
  };
}

module.exports = { OWNER_EMAILS, emailOf, isOwner, requireOwner, actorPool, testUser };
