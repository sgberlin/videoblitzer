alter table videos add column if not exists verification_status text not null default 'unverified';
alter table videos add column if not exists verified_at timestamptz;
alter table videos add column if not exists verified_size_bytes bigint;
alter table videos add column if not exists verified_content_type text;
alter table videos add column if not exists verification_metadata jsonb not null default '{}'::jsonb;

alter table package_jobs add column if not exists stage text not null default 'queued';
alter table package_jobs add column if not exists stage_started_at timestamptz;
alter table package_jobs add column if not exists last_heartbeat_at timestamptz;
alter table package_jobs add column if not exists deadline_at timestamptz;

create table if not exists upload_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  video_id uuid references videos(id) on delete cascade,
  object_key text not null,
  expected_size_bytes bigint,
  verified_size_bytes bigint,
  expected_content_type text,
  verified_content_type text,
  status text not null default 'pending',
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

alter table upload_verifications enable row level security;

create policy "upload verifications own" on upload_verifications for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());

create index if not exists upload_verifications_project_created_idx on upload_verifications(project_id, created_at desc);
create index if not exists upload_verifications_video_idx on upload_verifications(video_id);
create index if not exists upload_verifications_object_key_idx on upload_verifications(object_key);

create table if not exists package_assets (
  id uuid primary key default gen_random_uuid(),
  package_job_id uuid not null references package_jobs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  video_id uuid references videos(id) on delete set null,
  user_id uuid not null references profiles(id) on delete cascade,
  asset_type text not null,
  platform text,
  clip_id text,
  preset_id text,
  storage_key text not null,
  filename text not null,
  content_type text,
  duration_seconds numeric,
  width integer,
  height integer,
  aspect_ratio text,
  start_seconds numeric,
  end_seconds numeric,
  confidence numeric,
  validation_status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table package_assets enable row level security;

create policy "package assets own" on package_assets for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());

create index if not exists package_assets_job_idx on package_assets(package_job_id, asset_type);
create index if not exists package_assets_project_idx on package_assets(project_id, created_at desc);
create index if not exists package_assets_user_type_idx on package_assets(user_id, asset_type);

create or replace function public.write_audit_log(
  p_actor_id uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id uuid;
begin
  insert into audit_logs(actor_id, action, target_type, target_id, metadata)
  values (p_actor_id, p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into log_id;

  return log_id;
end;
$$;

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
  insert into package_jobs(id, project_id, video_id, user_id, status, stage, progress, input, stage_started_at, last_heartbeat_at)
  values (p_job_id, p_project_id, p_video_id, p_user_id, 'queued', 'queued', 0, coalesce(p_input, '{}'::jsonb), now(), now());

  insert into jobs(id, project_id, user_id, type, status, progress, input, output)
  values (p_job_id, p_project_id, p_user_id, 'social_content_pack', 'queued', 0, coalesce(p_input, '{}'::jsonb), jsonb_build_object('stage', 'queued'));

  perform public.write_audit_log(
    p_user_id,
    'package_job_queued',
    'package_job',
    p_job_id::text,
    jsonb_build_object('projectId', p_project_id, 'videoId', p_video_id)
  );

  return p_job_id;
end;
$$;

notify pgrst, 'reload schema';
