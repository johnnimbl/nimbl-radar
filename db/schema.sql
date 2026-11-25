-- Nimbl Radar database schema
-- Works against any Postgres database (Supabase, Render, Railway, local, etc.)
-- Run via: npm run migrate  (executes this file against DATABASE_URL)

create table if not exists meta (
  id smallint primary key default 1,
  last_scanned date,
  constraint meta_singleton check (id = 1)
);
insert into meta (id, last_scanned) values (1, current_date)
  on conflict (id) do nothing;

create table if not exists role_types (
  id serial primary key,
  name text unique not null,
  sort_order integer not null default 0
);

create table if not exists leads (
  id text primary key,
  company text not null,
  website text default '',
  role_type text default '',
  job_title text default '',
  job_url text default '',
  date_posted date,
  date_added date default current_date,
  employment_type text default '',
  est_size text default '',
  priority text not null default 'Medium'
    check (priority in ('High','Medium','Low')),
  end_client text default '',
  company_profile text default '',
  required_skills text default '',
  nearshore_fit text default '',
  status text not null default 'Not Started'
    check (status in ('Not Started','Researching','Contacted','Replied','Meeting Booked','Proposal Sent','Won','Lost','Not a Fit')),
  is_new boolean not null default true,
  client_info jsonb not null default '{"address":"","phone":"","taxId":"","currency":"USD"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists lead_notes (
  id serial primary key,
  lead_id text not null references leads(id) on delete cascade,
  note_date date,
  text text not null default '',
  sort_order integer not null default 0
);
create index if not exists lead_notes_lead_id_idx on lead_notes(lead_id);

create table if not exists contacts (
  id text primary key,
  lead_id text not null references leads(id) on delete cascade,
  name text default '',
  title text default '',
  email text default '',
  phone text default '',
  linkedin text default '',
  roles text[] not null default '{}',
  sort_order integer not null default 0
);
create index if not exists contacts_lead_id_idx on contacts(lead_id);

-- CRM tracking on contacts (safe to re-run on an existing database).
-- stage: where this person is in your outreach; next_follow_up drives the
-- dashboard's "Follow-ups due" list; last_contacted is stamped when you log an activity.
alter table contacts add column if not exists stage text not null default 'Not contacted'
  check (stage in ('Not contacted','Connection sent','Request pending','Connected','Message sent','Replied','Meeting booked','Not interested','No response'));
alter table contacts add column if not exists next_follow_up date;
alter table contacts add column if not exists last_contacted date;

-- Outreach sequence + first-contact choice.
-- sequence_step: how many touches of the 5-touch plan are done (0-5). is_primary: the person
-- you reach out to first at that company.
alter table contacts add column if not exists sequence_step integer not null default 0
  check (sequence_step between 0 and 5);
alter table contacts add column if not exists is_primary boolean not null default false;
-- Contacts the daily scan found itself (from public pages). The app flags them "check the title"
-- until John confirms or logs a touch; source_url is where the scan saw the person.
alter table contacts add column if not exists agent_found boolean not null default false;
alter table contacts add column if not exists source_url text not null default '';

-- One row per touch with a contact (LinkedIn request/message, email, call, meeting).
-- contact_id is deliberately NOT a foreign key: every save rewrites a lead's
-- contacts rows (see server/state.js), which would cascade-delete the history.
-- The app removes a contact's activities itself when the contact is removed.
create table if not exists activities (
  id text primary key,
  lead_id text not null references leads(id) on delete cascade,
  contact_id text not null,
  type text not null default 'Note'
    check (type in ('LinkedIn connection','LinkedIn message','Email','Call','Meeting','Note')),
  direction text not null default 'Outbound'
    check (direction in ('Outbound','Inbound')),
  activity_date date not null default current_date,
  summary text not null default '',
  sort_order integer not null default 0
);
create index if not exists activities_lead_id_idx on activities(lead_id);
create index if not exists activities_contact_id_idx on activities(contact_id);

create table if not exists documents (
  id text primary key,
  lead_id text not null references leads(id) on delete cascade,
  name text not null default '',
  sort_order integer not null default 0
);
create index if not exists documents_lead_id_idx on documents(lead_id);

create table if not exists candidates (
  id text primary key,
  lead_id text not null references leads(id) on delete cascade,
  name text default '',
  job_title text default '',
  linkedin text default '',
  email text default '',
  phone text default '',
  country text default '',
  stage text not null default 'Identified'
    check (stage in ('Identified','Call booked','Screen Approved','Presented','Interviewing','Pre-Approved','Placed','Not Placed')),
  contractor jsonb not null default '{"firstName":"","middleName":"","lastName":"","gender":"","payMethod":"","jobTitle":"","paymentRefTemplate":"","mainTask":"","companyName":"","companyTaxId":"","companyAddress":"","companyType":"","birthdate":"","startDate":""}'::jsonb,
  sort_order integer not null default 0
);
create index if not exists candidates_lead_id_idx on candidates(lead_id);

create table if not exists candidate_notes (
  id serial primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  note_date date,
  text text not null default '',
  sort_order integer not null default 0
);
create index if not exists candidate_notes_candidate_id_idx on candidate_notes(candidate_id);

create table if not exists candidate_documents (
  id text primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  name text not null default '',
  sort_order integer not null default 0
);
create index if not exists candidate_documents_candidate_id_idx on candidate_documents(candidate_id);

-- Login sessions (server/session.js). Stored in the database so users stay signed in across
-- server restarts. Row level security stays ON with no policies, so the table is not reachable
-- through Supabase's public API; the app connects with its own database role.
create table if not exists user_sessions (
  sid varchar not null primary key,
  sess json not null,
  expire timestamp(6) not null
);
create index if not exists idx_user_sessions_expire on user_sessions (expire);
alter table user_sessions enable row level security;

-- Playbook: research notes, the objection cheat sheet and message templates.
-- kind = 'note' (your own research / concerns, typed or dictated), 'objection'
-- (title = what the prospect says, body = how to answer) or 'template' (title = name,
-- tag = which touch it is for, body = the message). RLS on, like the other tables.
create table if not exists playbook_items (
  id text primary key,
  kind text not null check (kind in ('note','objection','template')),
  title text not null default '',
  body text not null default '',
  tag text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists playbook_items_kind_idx on playbook_items(kind, created_at);
alter table playbook_items enable row level security;

-- Starter objection cheat sheet (edit or delete freely in the app).
insert into playbook_items (id, kind, title, body, created_at) values
('obj-cost','objection','We expected bigger savings',
$b$Agree it is not the cheapest option: offshore in India or Eastern Europe costs less per hour. Position nearshore on total value: faster time to fill, real overlap with their team's hours, and one monthly cost with no recruiting fee, benefits admin or foreign entity to set up.
Ask: "What does the open seat cost you each month while it stays unfilled?"$b$, now() + interval '1 second'),
('obj-timezone','objection','Time zones will slow us down',
$b$Name the country the developer is in and how many hours overlap with their team. Most Latin American developers are within 0-3 hours of US Eastern time. Offer a fixed overlap window for standups and reviews.
Ask: "Which hours do you need someone online?"$b$, now() + interval '2 seconds'),
('obj-quality','objection','Quality and English level',
$b$Do not debate it, show it. Offer 2-3 anonymized profiles for the role, let them interview the people, and, if Nimbl's terms allow, a short trial period. Technical skill and English are tested in the interview, not assumed.$b$, now() + interval '3 seconds'),
('obj-legal','objection','Legal, tax and contractor-misclassification risk',
$b$This is the most serious worry, so answer it exactly. Explain how the person is engaged (contractor or employer-of-record), who carries compliance and local benefits, and that IP assignment is written into the contract. Do not give legal advice; suggest their counsel review the agreement.
TODO: write in Nimbl's actual engagement model here.$b$, now() + interval '4 seconds'),
('obj-manage','objection','I do not have time to manage another person',
$b$The developer joins their standups, tools and process and takes direction like any teammate. Offer a clear first-month onboarding plan and, if Nimbl offers it, a replacement if it is not working.$b$, now() + interval '5 seconds'),
('obj-vendor','objection','We already have a vendor or we are not ready to switch',
$b$Do not ask them to switch. Offer a pilot: one role or one project, alongside what they have now. Be honest that there is a short ramp-up while the new person learns the codebase.$b$, now() + interval '6 seconds'),
('obj-investors','objection','Leadership or investors may see this as outsourcing',
$b$Frame it as extending their own team with a dedicated hire, not handing the product to an agency. The developer works inside their repo, tools and roadmap.$b$, now() + interval '7 seconds'),
('obj-badexp','objection','We tried it before and it went badly',
$b$Ask what went wrong: the vetting, the time zone, the communication, the contract? Then show how your process differs on that exact point. Do not defend nearshoring in general.$b$, now() + interval '8 seconds')
on conflict (id) do nothing;

-- CRM tab: a lead you have saved as a good prospect (gets its own full-page client card).
alter table leads add column if not exists in_crm boolean not null default false;
alter table leads add column if not exists crm_saved_at date;

-- Uploaded files (profile PDFs, contracts, screenshots) attached to a lead and optionally to
-- one of its contacts. contact_id is deliberately not a foreign key: contacts are rewritten
-- on every state save, and a file should outlive the contact it was attached to.
create table if not exists files (
  id text primary key,
  lead_id text not null references leads(id) on delete cascade,
  contact_id text not null default '',
  name text not null default '',
  mime text not null default 'application/octet-stream',
  size integer not null default 0,
  data bytea not null,
  uploaded_by text not null default '',
  uploaded_at timestamptz not null default now()
);
alter table files alter column data set storage external;
create index if not exists files_lead_id_idx on files(lead_id);
alter table files enable row level security;

-- New openings the daily scan finds at a company already saved to the CRM. Shown as an alert
-- on the CRM tab and the client card until marked as seen. One row per posting URL.
create table if not exists role_alerts (
  id text primary key default gen_random_uuid()::text,
  lead_id text not null references leads(id) on delete cascade,
  role_type text not null default '',
  job_title text not null default '',
  job_url text not null default '',
  date_posted date,
  note text not null default '',
  found_at timestamptz not null default now(),
  seen_at timestamptz,
  unique (lead_id, job_url)
);
create index if not exists role_alerts_lead_id_idx on role_alerts(lead_id);
alter table role_alerts enable row level security;

-- Work the morning scan prepares for "Next moves": message drafts (kind 'message', per contact
-- and touch), re-engagement drafts for new roles ('reengage', meta.alertId) and suggested people
-- for CRM companies with no contacts ('contact', meta: name, title, linkedin, why, source).
-- dedupe_key stops the scan from writing the same draft twice. The app never sends anything.
create table if not exists agent_drafts (
  id text primary key default gen_random_uuid()::text,
  lead_id text not null references leads(id) on delete cascade,
  contact_id text not null default '',
  kind text not null check (kind in ('message', 'reengage', 'contact')),
  touch integer not null default 0,
  dedupe_key text not null unique,
  body text not null default '',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  dismissed_at timestamptz
);
create index if not exists agent_drafts_lead_id_idx on agent_drafts(lead_id);
alter table agent_drafts enable row level security;

-- Job descriptions on the Nimbl letterhead. John saves a posting (link and/or pasted text) as
-- 'waiting'; Claude writes the Nimbl version into content (title, practice, location, type, level,
-- about, responsibilities[], requirements[], niceToHave[], language, apply) and sets 'ready';
-- the app renders it as a PDF (server/jdpdf.js). The client name is hidden unless show_client.
create table if not exists job_descriptions (
  id text primary key default gen_random_uuid()::text,
  lead_id text not null references leads(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting','ready')),
  source_url text not null default '',
  source_text text not null default '',
  content jsonb not null default '{}'::jsonb,
  show_client boolean not null default false,
  client_label text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists job_descriptions_lead_idx on job_descriptions(lead_id, created_at);
alter table job_descriptions enable row level security;

-- Small app-wide settings. 'drive' holds the Google Drive connection used for weekly backups
-- (refresh token for the drive.file scope, folder id, last backup time). See server/backup.js.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;

-- Lead revisions: any change to a lead's contacts, activities, notes, documents or candidates bumps
-- leads.updated_at, which the app sends back as "rev" when saving. putState refuses a lead whose
-- revision moved on since the browser loaded it (see server/state.js), so writes from the Chrome
-- extension, Claude or the morning scan can't be wiped out by a stale tab.
create or replace function touch_lead() returns trigger language plpgsql set search_path = public as $$
declare lid text;
begin
  if tg_op = 'DELETE' then lid := old.lead_id; else lid := new.lead_id; end if;
  update leads set updated_at = now() where id = lid and updated_at <> now();
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
    update leads set updated_at = now() where id = old.lead_id and updated_at <> now();
  end if;
  return null;
end $$;
drop trigger if exists touch_lead_contacts on contacts;
create trigger touch_lead_contacts after insert or update or delete on contacts for each row execute function touch_lead();
drop trigger if exists touch_lead_activities on activities;
create trigger touch_lead_activities after insert or update or delete on activities for each row execute function touch_lead();
drop trigger if exists touch_lead_notes on lead_notes;
create trigger touch_lead_notes after insert or update or delete on lead_notes for each row execute function touch_lead();
drop trigger if exists touch_lead_documents on documents;
create trigger touch_lead_documents after insert or update or delete on documents for each row execute function touch_lead();
drop trigger if exists touch_lead_candidates on candidates;
create trigger touch_lead_candidates after insert or update or delete on candidates for each row execute function touch_lead();

-- Keys for the Nimbl Radar Chrome extension (created in Radar → Settings, stored hashed).
create table if not exists api_keys (
  id text primary key default gen_random_uuid()::text,
  key_hash text not null unique,
  label text not null default '',
  prefix text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table api_keys enable row level security;

-- ---------------------------------------------------------------------------
-- Who did what (also applied by the server at startup from server/audit_schema.sql).
-- Who did what. Every write runs with the person's account in the setting radar.actor (the app
-- sets it per transaction; anything else, like Claude's direct database work or the morning scan,
-- shows as "Claude"). New activities, notes, contacts and job descriptions take it as their author,
-- and the triggers below write a readable line into audit_log for each meaningful change.
-- Browser saves rewrite a company's rows wholesale, so they set radar.rewrite and the app logs a
-- diff itself instead (server/state.js).
create table if not exists audit_log (
  id bigserial primary key,
  lead_id text,
  at timestamptz not null default now(),
  actor text not null default '',
  action text not null default '',
  detail text not null default ''
);
create index if not exists audit_log_lead_idx on audit_log(lead_id, at desc);
alter table audit_log enable row level security;

create or replace function radar_actor() returns text language sql stable set search_path = public as $$
  select coalesce(nullif(current_setting('radar.actor', true), ''), 'Claude')
$$;

alter table if exists activities add column if not exists author text not null default '';
alter table if exists lead_notes add column if not exists author text not null default '';
alter table if exists contacts add column if not exists added_by text not null default '';
alter table if exists job_descriptions add column if not exists created_by text not null default '';
alter table if exists activities alter column author set default radar_actor();
alter table if exists lead_notes alter column author set default radar_actor();
alter table if exists contacts alter column added_by set default radar_actor();
alter table if exists job_descriptions alter column created_by set default radar_actor();

create or replace function radar_audit() returns trigger language plpgsql set search_path = public as $$
declare
  a text := radar_actor();
  lid text;
  msg text := '';
  kind text := '';
begin
  if current_setting('radar.rewrite', true) = 'on' then return null; end if;
  if tg_table_name = 'leads' then
    lid := coalesce(new.id, old.id);
    if tg_op = 'INSERT' then kind := 'company'; msg := 'Added ' || new.company || ' to Radar';
    elsif tg_op = 'UPDATE' then
      if new.status is distinct from old.status then kind := 'status'; msg := 'Status: ' || coalesce(old.status, '') || ' → ' || coalesce(new.status, ''); end if;
      if new.priority is distinct from old.priority then
        insert into audit_log (lead_id, actor, action, detail) values (lid, a, 'priority', 'Priority: ' || coalesce(old.priority, '') || ' → ' || coalesce(new.priority, ''));
      end if;
      if new.in_crm is distinct from old.in_crm then
        insert into audit_log (lead_id, actor, action, detail) values (lid, a, 'crm', case when new.in_crm then 'Saved to the CRM' else 'Removed from the CRM' end);
      end if;
    end if;
  elsif tg_table_name = 'contacts' then
    lid := coalesce(new.lead_id, old.lead_id);
    if tg_op = 'INSERT' then kind := 'contact'; msg := 'Added contact ' || coalesce(new.name, '') || case when new.title <> '' then ' (' || new.title || ')' else '' end;
    elsif tg_op = 'DELETE' then kind := 'contact'; msg := 'Removed contact ' || coalesce(old.name, '');
    elsif new.stage is distinct from old.stage then kind := 'stage'; msg := new.name || ': ' || old.stage || ' → ' || new.stage;
    elsif new.name is distinct from old.name or new.title is distinct from old.title then kind := 'contact'; msg := 'Edited contact ' || new.name;
    end if;
  elsif tg_table_name = 'activities' then
    lid := new.lead_id;
    kind := 'activity';
    msg := new.type || case when new.direction = 'Inbound' then ' from ' else ' to ' end ||
      coalesce((select name from contacts where id = new.contact_id), 'a contact') ||
      case when new.summary <> '' then ': ' || left(new.summary, 140) else '' end;
  elsif tg_table_name = 'lead_notes' then
    lid := new.lead_id; kind := 'note'; msg := 'Note: ' || left(new.text, 160);
  elsif tg_table_name = 'job_descriptions' then
    lid := coalesce(new.lead_id, old.lead_id);
    if tg_op = 'INSERT' then kind := 'jd'; msg := 'Started a job description';
    elsif tg_op = 'DELETE' then kind := 'jd'; msg := 'Deleted a job description' || coalesce(': ' || nullif(old.content->>'title', ''), '');
    elsif new.status = 'ready' and old.status is distinct from 'ready' then kind := 'jd'; msg := 'Job description ready: ' || coalesce(new.content->>'title', '');
    end if;
  elsif tg_table_name = 'role_alerts' then
    lid := new.lead_id; kind := 'role'; msg := 'New role found: ' || new.job_title;
  end if;
  if msg <> '' then
    insert into audit_log (lead_id, actor, action, detail) values (lid, a, kind, msg);
  end if;
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['leads','contacts','activities','lead_notes','job_descriptions','role_alerts'] loop
    if to_regclass('public.' || t) is not null and not exists (select 1 from pg_trigger where tgname = 'radar_audit_' || t) then
      execute format('create trigger %I after insert or update or delete on %I for each row execute function radar_audit()', 'radar_audit_' || t, t);
    end if;
  end loop;
end $$;
