alter table projects add column if not exists recording_mode text;
alter table projects add column if not exists source_label text;
alter table projects add column if not exists source_url text;
alter table projects add column if not exists permission_confirmed boolean not null default false;
alter table projects add column if not exists permission_confirmed_at timestamptz;
alter table projects add column if not exists recording_metadata jsonb not null default '{}'::jsonb;
alter table projects add column if not exists match_metadata jsonb not null default '{}'::jsonb;
alter table projects add column if not exists source_metadata jsonb not null default '{}'::jsonb;
alter table projects add column if not exists import_metadata jsonb not null default '{}'::jsonb;

alter table videos add column if not exists recording_mode text;
alter table videos add column if not exists source_type text;
alter table videos add column if not exists source_label text;
alter table videos add column if not exists source_url text;
alter table videos add column if not exists permission_confirmed boolean not null default false;
alter table videos add column if not exists permission_confirmed_at timestamptz;
alter table videos add column if not exists recording_metadata jsonb not null default '{}'::jsonb;
alter table videos add column if not exists match_metadata jsonb not null default '{}'::jsonb;
alter table videos add column if not exists markers jsonb not null default '[]'::jsonb;
alter table videos add column if not exists chunk_manifest jsonb not null default '{}'::jsonb;
alter table videos add column if not exists import_metadata jsonb not null default '{}'::jsonb;
alter table videos add column if not exists local_original_filename text;
alter table videos add column if not exists original_mime_type text;
alter table videos add column if not exists duration_seconds numeric;
alter table videos add column if not exists conversion_status text;

create table if not exists import_audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  source_url text,
  import_method text not null,
  permission_confirmed boolean not null default false,
  file_name text,
  file_size numeric,
  ip_address text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table import_audits enable row level security;

create policy "import audits own" on import_audits for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());

create table if not exists clip_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  video_id uuid references videos(id) on delete set null,
  user_id uuid not null references profiles(id) on delete cascade,
  source_timestamp numeric,
  start_seconds numeric,
  end_seconds numeric,
  duration_seconds numeric,
  marker_id text,
  source_sentence_ids text[] default '{}',
  manual_override boolean not null default false,
  status text not null default 'planned',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table clip_jobs enable row level security;

create policy "clip jobs own" on clip_jobs for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());

create table if not exists transcripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  video_id uuid references videos(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  segments jsonb not null default '[]'::jsonb,
  sentence_boundaries jsonb not null default '[]'::jsonb,
  status text not null default 'planned',
  created_at timestamptz not null default now()
);

alter table transcripts enable row level security;

create policy "transcripts own" on transcripts for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());
