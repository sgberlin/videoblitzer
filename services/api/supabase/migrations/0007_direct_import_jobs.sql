create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_url text not null,
  source_type text not null,
  status text not null default 'queued',
  progress integer not null default 0,
  error_message text,
  source_metadata jsonb not null default '{}'::jsonb,
  r2_object_key text,
  attempts integer not null default 0,
  locked_at timestamptz,
  worker_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table import_jobs enable row level security;

create policy "import jobs own" on import_jobs for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());

create index if not exists import_jobs_status_created_at_idx on import_jobs(status, created_at);
create index if not exists import_jobs_project_id_idx on import_jobs(project_id);
create index if not exists import_jobs_user_status_idx on import_jobs(user_id, status);

notify pgrst, 'reload schema';
