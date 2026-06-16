alter table videos add column if not exists has_video boolean not null default false;
alter table videos add column if not exists has_audio boolean not null default false;
alter table videos add column if not exists video_codec text;
alter table videos add column if not exists audio_codec text;
alter table videos add column if not exists width integer;
alter table videos add column if not exists height integer;

create index if not exists videos_project_has_video_idx on videos(project_id, has_video);

notify pgrst, 'reload schema';
