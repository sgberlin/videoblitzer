alter table videos add column if not exists file_sha256 text;
alter table videos add column if not exists fingerprint_status text not null default 'not_started';
alter table videos add column if not exists fingerprint_metadata jsonb not null default '{}'::jsonb;
alter table videos add column if not exists duplicate_of_video_id uuid references videos(id) on delete set null;
alter table videos add column if not exists analysis_status text not null default 'not_started';
alter table videos add column if not exists analysis_metadata jsonb not null default '{}'::jsonb;

create index if not exists videos_owner_sha_size_duration_idx on videos(owner_id, file_sha256, verified_size_bytes, duration_seconds) where file_sha256 is not null;
create index if not exists videos_duplicate_of_idx on videos(duplicate_of_video_id) where duplicate_of_video_id is not null;

create table if not exists video_analysis (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  source_hash text not null,
  status text not null default 'completed',
  duration_seconds numeric,
  scene_changes jsonb not null default '[]'::jsonb,
  audio_peaks jsonb not null default '[]'::jsonb,
  motion_scores jsonb not null default '[]'::jsonb,
  candidate_moments jsonb not null default '[]'::jsonb,
  transcript_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table video_analysis enable row level security;

drop policy if exists "video analysis own" on video_analysis;
create policy "video analysis own" on video_analysis for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());

create index if not exists video_analysis_video_idx on video_analysis(video_id, created_at desc);
create index if not exists video_analysis_user_hash_idx on video_analysis(user_id, source_hash, created_at desc);

alter table package_jobs add column if not exists analysis_id uuid references video_analysis(id) on delete set null;
alter table package_jobs add column if not exists package_variant text not null default 'standard_highlights';
alter table package_jobs add column if not exists package_options jsonb not null default '{}'::jsonb;
alter table package_jobs add column if not exists reuse_analysis boolean not null default false;
alter table package_jobs add column if not exists source_video_id uuid references videos(id) on delete set null;
alter table package_jobs add column if not exists duplicate_source_video_id uuid references videos(id) on delete set null;

create index if not exists package_jobs_analysis_idx on package_jobs(analysis_id) where analysis_id is not null;
create index if not exists package_jobs_source_video_idx on package_jobs(source_video_id) where source_video_id is not null;

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
  insert into package_jobs(
    id,
    project_id,
    video_id,
    user_id,
    status,
    stage,
    progress,
    input,
    stage_started_at,
    last_heartbeat_at,
    analysis_id,
    package_variant,
    package_options,
    reuse_analysis,
    source_video_id,
    duplicate_source_video_id
  )
  values (
    p_job_id,
    p_project_id,
    p_video_id,
    p_user_id,
    'queued',
    'queued',
    0,
    coalesce(p_input, '{}'::jsonb),
    now(),
    now(),
    nullif(p_input->>'analysisId', '')::uuid,
    coalesce(p_input->>'packageVariant', 'standard_highlights'),
    coalesce(p_input->'packageOptions', '{}'::jsonb),
    coalesce((p_input->>'reuseAnalysis')::boolean, false),
    coalesce(nullif(p_input->>'sourceVideoId', '')::uuid, p_video_id),
    nullif(p_input->>'duplicateSourceVideoId', '')::uuid
  );

  insert into jobs(id, project_id, user_id, type, status, progress, input, output)
  values (p_job_id, p_project_id, p_user_id, 'social_content_pack', 'queued', 0, coalesce(p_input, '{}'::jsonb), jsonb_build_object('stage', 'queued'));

  perform public.write_audit_log(
    p_user_id,
    'package_job_queued',
    'package_job',
    p_job_id::text,
    jsonb_build_object('projectId', p_project_id, 'videoId', p_video_id, 'packageVariant', coalesce(p_input->>'packageVariant', 'standard_highlights'), 'reuseAnalysis', coalesce((p_input->>'reuseAnalysis')::boolean, false))
  );

  return p_job_id;
end;
$$;

notify pgrst, 'reload schema';
