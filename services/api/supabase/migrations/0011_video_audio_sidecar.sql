alter table videos add column if not exists audio_source_object_key text;
alter table videos add column if not exists audio_source_filename text;
alter table videos add column if not exists audio_source_content_type text;
alter table videos add column if not exists audio_source_size_bytes bigint;
alter table videos add column if not exists audio_source_metadata jsonb not null default '{}'::jsonb;

create index if not exists videos_audio_source_object_key_idx on videos(audio_source_object_key) where audio_source_object_key is not null;

notify pgrst, 'reload schema';
