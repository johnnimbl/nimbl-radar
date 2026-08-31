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
