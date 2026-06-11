alter table allowed_users add column if not exists status text not null default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'allowed_users_status_check'
  ) then
    alter table allowed_users add constraint allowed_users_status_check check (status in ('active','suspended','pending'));
  end if;
end $$;

update allowed_users
set status = case when is_suspended then 'suspended' else 'active' end
where status is null or status = '';
