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

-- Which role a job description was written for: a role found since (role_alerts), or null for the
-- role the company was saved with. If that alert is ever removed, the description falls back to the company.
-- Roles that have closed, and a role found since that became the company's main role.
alter table if exists leads add column if not exists job_closed_at date;
alter table if exists role_alerts add column if not exists closed_at date;
alter table if exists role_alerts add column if not exists promoted_at timestamptz;
alter table if exists job_descriptions add column if not exists role_alert_id text references role_alerts (id) on delete set null;

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

-- People who have signed in to Radar (name and photo from Google), so the extension can show who
-- it is connected as. Updated on sign-in; no tokens are stored here.
create table if not exists radar_users (
  email text primary key,
  name text not null default '',
  photo text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table radar_users enable row level security;

-- "Find email" results for a contact: where the address came from and how sure it is.
alter table contacts add column if not exists email_info jsonb;

-- Where the person is based, and whose relationship it is when it isn't the team's to work
-- (e.g. "Brian" for a client contact Brian looks after): no outreach is suggested for them.
alter table contacts add column if not exists location text not null default '';
alter table contacts add column if not exists owner text not null default '';

-- "Request pending": the connection request wasn't accepted within a week, so touch 2 is an InMail or email.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_stage_check' and pg_get_constraintdef(oid) like '%Request pending%') then
    alter table contacts drop constraint if exists contacts_stage_check;
    alter table contacts add constraint contacts_stage_check check (stage in
      ('Not contacted','Connection sent','Request pending','Connected','Message sent','Replied','Meeting booked','Not interested','No response'));
  end if;
end $$;
