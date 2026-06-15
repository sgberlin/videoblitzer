create table if not exists package_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  video_id uuid references videos(id) on delete set null,
  user_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'queued',
  progress integer not null default 0,
  attempts integer not null default 0,
  locked_at timestamptz,
  worker_id text,
  error_message text,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  artifact_object_key text,
  manifest_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table package_jobs enable row level security;

create policy "package jobs own" on package_jobs for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());

create index if not exists package_jobs_status_created_at_idx on package_jobs(status, created_at);
create index if not exists package_jobs_project_id_idx on package_jobs(project_id);
create index if not exists package_jobs_user_status_idx on package_jobs(user_id, status);

create or replace function public.enqueue_package_job_atomic(
  p_job_id uuid,
  p_project_id uuid,
  p_video_id uuid,
  p_user_id uuid,
  p_input jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into package_jobs(id, project_id, video_id, user_id, status, progress, input)
  values (p_job_id, p_project_id, p_video_id, p_user_id, 'queued', 0, coalesce(p_input, '{}'::jsonb));

  insert into jobs(id, project_id, user_id, type, status, progress, input, output)
  values (p_job_id, p_project_id, p_user_id, 'social_content_pack', 'queued', 0, coalesce(p_input, '{}'::jsonb), '{}'::jsonb);

  return p_job_id;
end;
$$;

notify pgrst, 'reload schema';
