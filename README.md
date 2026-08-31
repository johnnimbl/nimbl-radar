# Nimbl Radar

A lead-tracking CRM for nearshore LATAM staffing: leads with role/priority/status,
contacts, a "Won" client record (billing info, documents), and a candidate
pipeline (Identified → Placed) with contractor onboarding fields once someone's
placed. Originally prototyped as a Claude Artifact; this is that same frontend
running against a real Postgres database so it can be deployed anywhere.

## Stack

- **Frontend:** plain HTML/CSS/JS, no build step (`public/`)
- **Backend:** Node.js + Express, one JSON-in/JSON-out API (`server/`)
- **Database:** Postgres — works with Supabase, Render, Railway, or a local instance

The whole app is one Express process that serves the static frontend and the
API. There's no separate frontend build/deploy step.

## Quick start (local, with Docker)

The fastest way to see it running, no Supabase account needed:

```bash
docker compose up --build
# in another terminal, once the db is up:
docker compose exec app npm run migrate
docker compose exec app npm run seed
```

Open http://localhost:3000 — you'll see the 9 leads carried over from the
original prototype.

## Quick start (local, without Docker)

Requires Node.js 18+ and a Postgres database you can connect to (see
"Getting a database" below).

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to your Postgres connection string
npm run migrate   # creates the tables
npm run seed       # loads the 9 starter leads
npm start           # http://localhost:3000
```

Use `npm run dev` instead of `npm start` during development — it restarts on
file changes.

## Getting a database

**Supabase (recommended, free tier available):**

1. Create a project at [supabase.com](https://supabase.com).
2. Project Settings → Database → Connection string → copy the "URI" (use the
   "Transaction pooler" URI if you'll deploy to a serverless host like Vercel).
3. Paste it into `.env` as `DATABASE_URL`.

Any other Postgres works the same way — Render, Railway, Neon, a self-hosted
instance. Just set `DATABASE_URL` and (if it doesn't use SSL, like a local
Postgres) set `PGSSL=false`.

## Deploying

This is a standard Node app, so any of these work:

- **Render / Railway:** point them at this repo, set `DATABASE_URL` (and
  `APP_USER`/`APP_PASSWORD` if you want the login gate) as environment
  variables, build command `npm install`, start command `npm start`. Run
  `npm run migrate && npm run seed` once via their shell/console.
- **Docker anywhere:** `docker build -t nimbl-radar . && docker run -p 3000:80 --env-file .env nimbl-radar` (point `DATABASE_URL` at a real Postgres, not the docker-compose one, when you do this outside of `docker compose`).
- **A plain VPS:** `git clone`, `npm install`, set up `.env`, run behind
  `pm2`/`systemd` and a reverse proxy (nginx/Caddy) for TLS.

## Protecting it

Since this can hold candidate PII (tax IDs, birthdates, payment method), the
app is gated behind Google sign-in, restricted to one email domain
(`GOOGLE_ALLOWED_DOMAIN`, e.g. `nimbl.ai`). Anyone signing in with a Google
account on that domain gets in; everyone else is turned away before a
session is created.

**Set it up in Google Cloud Console** (console.cloud.google.com):

1. Create a project (or use an existing one).
2. **APIs & Services → OAuth consent screen** — set it up for "Internal" if
   your Google Workspace is on `nimbl.ai` (simplest, restricts to your
   workspace automatically), or "External" with your domain check still
   enforced server-side either way.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type **Web application**.
4. Under **Authorized redirect URIs**, add:
   `{PUBLIC_URL}/auth/google/callback` — e.g.
   `https://nimbl-radar-app.onrender.com/auth/google/callback`.
5. Copy the generated **Client ID** and **Client secret**.

**Set these on your host** (see `.env.example`):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from step 5 above
- `GOOGLE_ALLOWED_DOMAIN` — defaults to `nimbl.ai`
- `PUBLIC_URL` — this app's public https URL, no trailing slash (must match
  the redirect URI exactly)
- `SESSION_SECRET` — a random string signing session cookies; generate one
  with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `NODE_ENV=production` — makes session cookies HTTPS-only

Leave `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset to skip the login gate
entirely (useful for local development — the app is then open to anyone who
can reach it, same as before).

A legacy HTTP Basic Auth stopgap (`APP_USER`/`APP_PASSWORD`) still exists
for local/dev use but is superseded by Google sign-in — leave both blank
once Google login is configured.

Sessions are held in memory on the server process, so everyone is signed
out on a redeploy or restart — signing back in takes one click. If you
outgrow "any @yourdomain.com Google account," swap in per-user roles
(Supabase Auth is a natural fit since you're already on Supabase for the
database).

## Project layout

```
public/          static frontend — index.html, app.js, styles.css, logo, login.html
server/          Express app (index.js), db pool (db.js), state read/write (state.js), Google auth (auth.js)
db/schema.sql    full table definitions
db/seed-data.json the 9 starter leads
scripts/         migrate.js and seed.js, run via npm run migrate / npm run seed
```

## How data is stored

`GET /api/state` and `PUT /api/state` read/write the *entire* app state as
one JSON document — the same shape the original Claude Artifact prototype
used in-page. Under the hood it's normalized into real tables (`leads`,
`contacts`, `documents`, `candidates`, `candidate_notes`, ... — see
`db/schema.sql`), and every save replaces each lead's child rows wholesale
(delete + reinsert) inside a transaction. That's simple and correct at the
scale of a lead-tracking CRM. If you outgrow it — a lot of leads, several
people editing at once — split `PUT /api/state` into smaller per-resource
endpoints (`PATCH /api/leads/:id`, `POST /api/leads/:id/notes`, etc.) instead
of replacing the whole document each time.

## What's not here yet

- **Per-user roles/permissions.** Google sign-in identifies who's who (any
  `@nimbl.ai` account gets in), but everyone has the same full access today.
  Role-based permissions (e.g. read-only vs. edit) are the natural next step.
- **Gmail / calendar integration.** The original design intentionally kept
  outreach as "draft in chat, send from Gmail yourself" rather than the app
  sending email directly. Wiring up real Gmail/Google Calendar integration
  (for interview scheduling) is a separate project.
- **File uploads.** Documents are tracked as named entries (matching the
  "SOW pertains to contractor" style list from the original design), not
  actual file storage. Supabase Storage is a natural fit if you want real
  uploads later.
