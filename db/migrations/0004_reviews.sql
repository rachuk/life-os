-- 0004 — evening/weekly reviews and the virtual reward fund (additive only).
--
-- reward_ledger: an `earned` row moves proposed → approved → funded (or rejected); `redeemed` and
-- `adjusted` rows are separate, final journal entries. period_key = budget month 'YYYY-MM'
-- (a week belongs to the month of its Thursday, like ISO weeks). origin_key stays the
-- idempotency key (e.g. 'week:2026-11-02:workouts'), unique per user since 0001.
alter table reward_ledger
  add column if not exists week_start date,
  add column if not exists rule_key text,
  add column if not exists basis_json jsonb not null default '{}'::jsonb,
  add column if not exists status_changed_at timestamptz;

create index if not exists reward_ledger_user_period_idx on reward_ledger(user_id, period_key);
create index if not exists reward_ledger_user_week_idx on reward_ledger(user_id, week_start);
create index if not exists reward_ledger_user_goal_idx on reward_ledger(user_id, goal_id);

-- weekly review: the user's own short note ("что было новым/приятным") and a regeneration counter.
alter table weekly_reviews
  add column if not exists user_note text,
  add column if not exists generation int not null default 1;

create index if not exists xp_events_user_date_idx on xp_events(user_id, local_date);
