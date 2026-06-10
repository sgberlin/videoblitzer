alter table allowed_users enable row level security;
alter table profiles enable row level security;
alter table plans enable row level security;
alter table subscriptions enable row level security;
alter table credit_balances enable row level security;
alter table credit_transactions enable row level security;
alter table projects enable row level security;
alter table videos enable row level security;
alter table video_sources enable row level security;
alter table jobs enable row level security;
alter table exports enable row level security;
alter table match_data enable row level security;
alter table match_events enable row level security;
alter table team_profiles enable row level security;
alter table squad_members enable row level security;
alter table stats_records enable row level security;
alter table thumbnail_assets enable row level security;
alter table thumbnails enable row level security;
alter table social_packages enable row level security;
alter table usage_events enable row level security;
alter table billing_events enable row level security;
alter table contact_messages enable row level security;
alter table audit_logs enable row level security;

create or replace function public.is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner');
$$;

create policy "profiles select own" on profiles for select using (id = auth.uid() or public.is_owner());
create policy "plans readable" on plans for select using (true);
create policy "subscriptions own" on subscriptions for select using (user_id = auth.uid() or public.is_owner());
create policy "credit balances own" on credit_balances for select using (user_id = auth.uid() or public.is_owner());
create policy "credit transactions own" on credit_transactions for select using (user_id = auth.uid() or public.is_owner());

create policy "projects own" on projects for all using (owner_id = auth.uid() or public.is_owner()) with check (owner_id = auth.uid() or public.is_owner());
create policy "videos own" on videos for all using (owner_id = auth.uid() or public.is_owner()) with check (owner_id = auth.uid() or public.is_owner());
create policy "jobs own" on jobs for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "exports own" on exports for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "match data own" on match_data for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "match events own" on match_events for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "team profiles own" on team_profiles for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "squad members own" on squad_members for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "stats records own" on stats_records for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "thumbnail assets own" on thumbnail_assets for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "thumbnails own" on thumbnails for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "social packages own" on social_packages for all using (user_id = auth.uid() or public.is_owner()) with check (user_id = auth.uid() or public.is_owner());
create policy "usage events own" on usage_events for select using (user_id = auth.uid() or public.is_owner());

-- Admin-only tables are intentionally managed through the server API using the service role.
create policy "allowed users owner read" on allowed_users for select using (public.is_owner());
create policy "billing events owner read" on billing_events for select using (public.is_owner());
create policy "contact messages owner read" on contact_messages for select using (public.is_owner());
create policy "audit logs owner read" on audit_logs for select using (public.is_owner());
