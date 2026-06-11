insert into plans (key, name, weekly_price_cents, weekly_credits, is_public, is_unlimited)
values
  ('owner_unlimited', 'Owner Unlimited', 0, null, false, true),
  ('starter_weekly', 'Starter Weekly', 900, 100, false, false),
  ('creator_weekly', 'Creator Weekly', 1900, 300, false, false),
  ('pro_weekly', 'Pro Weekly', 3900, 800, false, false)
on conflict (key) do update set
  name = excluded.name,
  weekly_price_cents = excluded.weekly_price_cents,
  weekly_credits = excluded.weekly_credits,
  is_public = excluded.is_public,
  is_unlimited = excluded.is_unlimited;

insert into allowed_users (email, role, plan_key, is_unlimited, status, notes)
values ('gizlenweb@gmail.com', 'owner', 'owner_unlimited', true, 'active', 'VideoBlitzer owner account')
on conflict (email) do update set role = 'owner', plan_key = 'owner_unlimited', is_unlimited = true, status = 'active', is_suspended = false;
