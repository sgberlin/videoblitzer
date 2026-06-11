alter table projects add column if not exists source_type text not null default 'web_app';
alter table projects add column if not exists user_id uuid references profiles(id) on delete cascade;
update projects set user_id = owner_id where user_id is null;

alter table videos add column if not exists user_id uuid references profiles(id) on delete cascade;
alter table videos add column if not exists content_type text;
alter table videos add column if not exists source_object_key text;
alter table videos add column if not exists source_format text;
alter table videos add column if not exists original_filename text;
alter table videos add column if not exists desired_export_format text;
update videos set user_id = owner_id where user_id is null;
update videos set content_type = mime_type where content_type is null;

create table if not exists export_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  video_id uuid references videos(id) on delete set null,
  user_id uuid not null references profiles(id) on delete cascade,
  source_object_key text not null,
  target_object_key text,
  source_format text not null,
  target_format text not null,
  status text not null default 'queued',
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table export_jobs enable row level security;

create policy "export jobs own" on export_jobs for all
  using (user_id = auth.uid() or public.is_owner())
  with check (user_id = auth.uid() or public.is_owner());
