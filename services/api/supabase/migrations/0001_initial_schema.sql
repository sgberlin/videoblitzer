create extension if not exists pgcrypto;

create table if not exists allowed_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'member' check (role in ('owner','admin','member')),
  plan_key text not null default 'starter_weekly',
  is_unlimited boolean not null default false,
  is_suspended boolean not null default false,
  invited_at timestamptz not null default now(),
  invited_by uuid,
  notes text
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text,
  role text not null default 'member' check (role in ('owner','admin','member')),
  plan_key text not null default 'starter_weekly',
  is_unlimited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists plans (
  key text primary key,
  name text not null,
  weekly_price_cents integer not null default 0,
  weekly_credits integer,
  is_public boolean not null default false,
  is_unlimited boolean not null default false,
  stripe_price_id text
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  plan_key text not null references plans(key),
  stripe_customer_id text,
  stripe_subscription_id text,
  status text not null default 'inactive',
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists credit_balances (
  user_id uuid primary key references profiles(id) on delete cascade,
  balance integer not null default 0,
  is_unlimited boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid,
  action text not null,
  amount integer not null,
  balance_after integer,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  home_team text,
  away_team text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists videos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  owner_id uuid not null references profiles(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  storage_key text not null,
  size_bytes bigint,
  duration_seconds numeric,
  status text not null default 'uploaded',
  created_at timestamptz not null default now()
);

create table if not exists video_sources (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  source_type text not null,
  recorder_metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null,
  status text not null default 'queued',
  progress integer not null default 0,
  input jsonb not null default '{}',
  output jsonb not null default '{}',
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists exports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  preset_id text not null,
  crop_mode text not null,
  status text not null default 'not_started',
  storage_key text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists match_data (
  project_id uuid primary key references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  data jsonb not null default '{}',
  confirmed boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists match_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  event_type text not null,
  event_time numeric not null,
  label text not null,
  confidence text not null default 'Low',
  metadata jsonb not null default '{}'
);

create table if not exists team_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  short_code text,
  primary_color text,
  secondary_color text,
  metadata jsonb not null default '{}'
);

create table if not exists squad_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references team_profiles(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  number text,
  position text,
  metadata jsonb not null default '{}'
);

create table if not exists stats_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  key text not null,
  value jsonb not null,
  source text not null,
  confidence text not null,
  confirmed boolean not null default false
);

create table if not exists thumbnail_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  asset_type text not null,
  storage_key text not null,
  metadata jsonb not null default '{}'
);

create table if not exists thumbnails (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  template text not null,
  size_label text not null,
  storage_key text,
  checklist jsonb not null default '{}',
  selected boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists social_packages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  language text not null default 'English',
  content jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid,
  event_name text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists billing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete set null,
  stripe_event_id text unique,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  use_case text,
  message text not null,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
