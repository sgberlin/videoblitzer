alter table export_jobs add column if not exists locked_at timestamptz;
alter table export_jobs add column if not exists worker_id text;
alter table export_jobs add column if not exists attempts integer not null default 0;
alter table export_jobs add column if not exists updated_at timestamptz not null default now();

create index if not exists export_jobs_status_created_at_idx on export_jobs(status, created_at);
create index if not exists jobs_project_id_idx on jobs(project_id);
create index if not exists jobs_user_id_status_idx on jobs(user_id, status);
create index if not exists videos_project_owner_idx on videos(project_id, owner_id);
create index if not exists usage_events_user_created_idx on usage_events(user_id, created_at desc);
create index if not exists projects_owner_updated_idx on projects(owner_id, updated_at desc);

create or replace function public.debit_credits_atomic(
  p_user_id uuid,
  p_project_id uuid,
  p_action text,
  p_amount integer,
  p_metadata jsonb default '{}'::jsonb
)
returns table(ok boolean, cost integer, balance_after integer, is_unlimited boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance integer;
  current_unlimited boolean;
begin
  if p_amount <= 0 then
    return query select true, 0, null::integer, true;
    return;
  end if;

  insert into credit_balances(user_id, balance, is_unlimited)
  values (p_user_id, 0, false)
  on conflict (user_id) do nothing;

  select balance, credit_balances.is_unlimited
  into current_balance, current_unlimited
  from credit_balances
  where user_id = p_user_id
  for update;

  if current_unlimited then
    return query select true, 0, current_balance, true;
    return;
  end if;

  if current_balance < p_amount then
    return query select false, p_amount, current_balance, false;
    return;
  end if;

  update credit_balances
  set balance = balance - p_amount,
      updated_at = now()
  where user_id = p_user_id
  returning balance into current_balance;

  insert into credit_transactions(user_id, project_id, action, amount, balance_after, metadata)
  values (p_user_id, p_project_id, p_action, -p_amount, current_balance, coalesce(p_metadata, '{}'::jsonb));

  return query select true, p_amount, current_balance, false;
end;
$$;

create or replace function public.refund_credits_atomic(
  p_user_id uuid,
  p_project_id uuid,
  p_action text,
  p_amount integer,
  p_metadata jsonb default '{}'::jsonb
)
returns table(ok boolean, balance_after integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance integer;
  current_unlimited boolean;
begin
  if p_amount <= 0 then
    return query select true, null::integer;
    return;
  end if;

  insert into credit_balances(user_id, balance, is_unlimited)
  values (p_user_id, 0, false)
  on conflict (user_id) do nothing;

  select balance, credit_balances.is_unlimited
  into current_balance, current_unlimited
  from credit_balances
  where user_id = p_user_id
  for update;

  if current_unlimited then
    return query select true, current_balance;
    return;
  end if;

  update credit_balances
  set balance = balance + p_amount,
      updated_at = now()
  where user_id = p_user_id
  returning balance into current_balance;

  insert into credit_transactions(user_id, project_id, action, amount, balance_after, metadata)
  values (p_user_id, p_project_id, p_action, p_amount, current_balance, coalesce(p_metadata, '{}'::jsonb));

  return query select true, current_balance;
end;
$$;
