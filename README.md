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

Since this can hold candidate PII (tax IDs, birthdates, payment method), set
`APP_USER` and `APP_PASSWORD` in `.env`/your host's environment variables to
turn on a shared HTTP Basic Auth login for the whole app. It's a stopgap —
if you outgrow "one shared password for the team," swap in real per-user
auth (Supabase Auth is a natural fit since you're already on Supabase for
the database).

## Project layout

```
public/          static frontend — index.html, app.js, styles.css, logo
server/          Express app (index.js), db pool (db.js), state read/write (state.js)
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

- **Per-user accounts.** Right now it's one shared login for the whole team
  (or none). Multi-user auth with roles is the natural next step.
- **Gmail / calendar integration.** The original design intentionally kept
  outreach as "draft in chat, send from Gmail yourself" rather than the app
  sending email directly. Wiring up real Gmail/Google Calendar integration
  (for interview scheduling) is a separate project.
- **File uploads.** Documents are tracked as named entries (matching the
  "SOW pertains to contractor" style list from the original design), not
  actual file storage. Supabase Storage is a natural fit if you want real
  uploads later.
