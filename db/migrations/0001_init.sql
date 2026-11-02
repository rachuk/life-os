-- Life OS — initial schema (plain PostgreSQL 15+).
-- Row Level Security: application code runs user-scoped work inside a transaction with
--   SET LOCAL ROLE lifeos_user; SELECT set_config('app.user_id', '<uuid>', true);
-- so every policy below is enforced by the database itself, not only by app code.
-- System jobs (worker, auth, telegram routing) run as the owner role and bypass RLS
-- only where explicitly needed.

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lifeos_user') then
    create role lifeos_user nologin noinherit;
  end if;
end $$;

-- allow the migrating/connecting role to switch into lifeos_user
do $$
begin
  execute format('grant lifeos_user to %I', current_user);
exception when others then
  raise notice 'grant lifeos_user to current_user skipped: %', sqlerrm;
end $$;

create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

grant usage on schema app to lifeos_user;
grant execute on function app.current_user_id() to lifeos_user;
grant usage on schema public to lifeos_user;

-- ---------------------------------------------------------------------------
-- Identity (system-managed; not exposed to lifeos_user except own row read)
-- ---------------------------------------------------------------------------
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_normalized text not null unique,
  password_hash text,
  display_name text,
  role text not null default 'owner' check (role in ('owner', 'member', 'test')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table sessions (
  id text primary key, -- sha256(token), the raw token only lives in the cookie
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text
);
create index sessions_user_idx on sessions(user_id);

create table auth_attempts (
  id bigserial primary key,
  key text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index auth_attempts_key_idx on auth_attempts(key, created_at desc);

-- ---------------------------------------------------------------------------
-- Profile & routine
-- ---------------------------------------------------------------------------
create table profiles (
  user_id uuid primary key references users(id) on delete cascade,
  display_name text,
  locale text not null default 'ru',
  voice_languages text[] not null default array['ru','uk','en'],
  timezone text not null default 'Europe/Lisbon',
  is_onboarded boolean not null default false,
  onboarded_at timestamptz,
  quiet_hours jsonb, -- {"start":"23:30","end":"07:30"} or null = off
  privacy_settings jsonb not null default '{}'::jsonb,
  feature_flags jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table routine_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  work_days int[] not null default array[1,2,3,4,5], -- ISO weekday 1=Mon..7=Sun
  work_start time not null default '09:00',
  work_end time not null default '18:00',
  morning_prep_minutes int not null default 60 check (morning_prep_minutes between 10 and 240),
  wake_time time not null default '08:00',
  weekend_wake_time time,
  bed_time time not null default '00:00',
  fall_asleep_minutes int not null default 15,
  meal_windows jsonb not null default '{}'::jsonb,
  gym_preferred_start time not null default '21:00',
  gym_preferred_end time not null default '22:00',
  gym_travel_minutes int, -- null = unknown, never invented
  gym_days int[], -- null = planner picks within week
  weekly_targets jsonb not null default '{}'::jsonb,
  notification_preferences jsonb not null default '{}'::jsonb,
  overtime_weekly_warn_minutes int not null default 300,
  rewards_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tasks / projects / inbox
-- ---------------------------------------------------------------------------
create table projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  name text not null,
  category text not null default 'own_project',
  status text not null default 'active' check (status in ('active','paused','done','archived')),
  notes text,
  target_minutes_per_week int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_idx on projects(user_id, status);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  title text not null check (length(title) between 1 and 500),
  details text,
  type text not null default 'task' check (type in ('task','reminder','waiting','idea','wish','event')),
  category text not null default 'personal',
  status text not null default 'inbox'
    check (status in ('inbox','todo','scheduled','in_progress','waiting','someday','done','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  due_at timestamptz,
  due_date date,
  planned_at timestamptz,
  estimated_minutes int,
  actual_minutes int,
  next_action text,
  waiting_for text,
  follow_up_at timestamptz,
  source text not null default 'manual',
  source_message_id text,
  inbox_item_id uuid,
  privacy_class text not null default 'normal' check (privacy_class in ('normal','work_neutral','sensitive')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_user_status_idx on tasks(user_id, status);
create index tasks_user_due_idx on tasks(user_id, due_date);

create table inbox_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  kind text not null default 'text' check (kind in ('text','voice','photo')),
  raw_text text,
  normalized_text text,
  processing_status text not null default 'received'
    check (processing_status in ('received','processing','proposed','confirmed','rejected','failed','stored')),
  source text not null default 'web',
  source_ref text,
  source_media_id uuid,
  parser text, -- 'rules' | provider name
  proposals_json jsonb not null default '[]'::jsonb,
  linked_entities jsonb not null default '[]'::jsonb,
  needs_confirmation boolean not null default true,
  idempotency_key text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index inbox_items_idem_idx on inbox_items(user_id, idempotency_key) where idempotency_key is not null;
create index inbox_items_user_idx on inbox_items(user_id, processing_status, created_at desc);

-- ---------------------------------------------------------------------------
-- Planning
-- ---------------------------------------------------------------------------
create table schedule_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  key text not null, -- stable key: work, lunch, gym, ...
  kind text not null,
  title text not null,
  recurrence jsonb not null, -- {"type":"weekly","days":[1..5]} | {"type":"weekly_quota","count":2,...}
  local_start time,
  local_end time,
  duration_minutes int,
  timezone text not null default 'Europe/Lisbon',
  priority_class text not null check (priority_class in ('fixed','protected','required_movable','flexible','buffer')),
  flex_window jsonb, -- {"earliest":"12:30","latest":"15:00"}
  reminder jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  week_start date not null,
  version int not null,
  local_date date,
  status text not null default 'confirmed' check (status in ('draft','confirmed','reverted')),
  source text not null,
  summary text,
  diff_json jsonb not null default '{}'::jsonb,
  reverts_version_id uuid references plan_versions(id) on delete set null,
  actor text not null default 'user',
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, week_start, version)
);
create index plan_versions_user_idx on plan_versions(user_id, week_start, version desc);

create table schedule_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  local_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  template_id uuid references schedule_templates(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  plan_version_id uuid references plan_versions(id) on delete set null,
  kind text not null,
  title text not null,
  priority_class text not null check (priority_class in ('fixed','protected','required_movable','flexible','buffer')),
  status text not null default 'planned'
    check (status in ('planned','notified','started','completed','snoozed','rescheduled','skipped','unanswered','cancelled')),
  source text not null default 'template',
  origin_key text,
  flex_window jsonb,
  actual_start timestamptz,
  actual_end timestamptz,
  actual_minutes int,
  notes text,
  reason text,
  revision int not null default 1,
  status_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
create unique index schedule_events_origin_idx on schedule_events(user_id, origin_key) where origin_key is not null;
create index schedule_events_user_time_idx on schedule_events(user_id, start_at);
create index schedule_events_user_date_idx on schedule_events(user_id, local_date);

create table plan_changes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  version_id uuid not null references plan_versions(id) on delete cascade,
  event_id uuid references schedule_events(id) on delete set null,
  action text not null,
  from_json jsonb,
  to_json jsonb,
  reason text,
  actor text not null default 'user',
  created_at timestamptz not null default now()
);
create index plan_changes_version_idx on plan_changes(version_id);

create table day_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  local_date date not null,
  status text not null default 'draft' check (status in ('draft','confirmed','kept')),
  confirmed_at timestamptz,
  evening_review_json jsonb,
  evening_reviewed_at timestamptz,
  evening_review_skipped boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, local_date)
);

-- ---------------------------------------------------------------------------
-- Habits & health
-- ---------------------------------------------------------------------------
create table habit_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  key text not null,
  name text not null,
  type text not null check (type in ('scheduled_checkin','daily_rule','quantitative','weekly_quota','negative_boundary')),
  schedule_rule jsonb not null default '{}'::jsonb,
  target numeric,
  unit text,
  strictness text not null default 'normal' check (strictness in ('soft','normal','strict')),
  enabled boolean not null default true,
  tracking_mode text not null default 'check' check (tracking_mode in ('check','quantity','event')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create table habit_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  habit_id uuid not null references habit_definitions(id) on delete cascade,
  local_date date not null,
  status text not null check (status in ('done','partial','skipped','exception')),
  value numeric,
  source text not null default 'manual',
  source_media_id uuid,
  confirmed_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, habit_id, local_date)
);

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  kind text not null check (kind in ('weight_photo','steps_screenshot','meal_photo','progress_photo','receipt','voice','other')),
  storage_path text not null,
  mime text not null,
  size_bytes int not null,
  width int,
  height int,
  sha256 text,
  capture_date date,
  privacy_level text not null default 'private' check (privacy_level in ('private','sensitive')),
  consent_snapshot jsonb not null default '{}'::jsonb,
  retention_until timestamptz,
  processing_status text not null default 'stored_private'
    check (processing_status in ('received','stored_private','processing','proposed','confirmed','rejected','logged','failed')),
  source text not null default 'web',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index media_assets_user_idx on media_assets(user_id, kind, created_at desc);

create table health_measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  metric_type text not null check (metric_type in ('weight','steps','sleep_minutes','sleep_quality','energy','water_ml')),
  value numeric not null,
  unit text not null,
  measured_at timestamptz not null,
  local_date date not null,
  source_type text not null default 'manual'
    check (source_type in ('manual','telegram','photo','screenshot','health_import','ai_estimate')),
  source_media_id uuid references media_assets(id) on delete set null,
  ai_confidence numeric,
  user_confirmed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one value per day for daily metrics; water is additive
create unique index health_daily_unique_idx on health_measurements(user_id, metric_type, local_date)
  where metric_type in ('weight','steps','sleep_minutes','sleep_quality','energy');
create index health_user_date_idx on health_measurements(user_id, metric_type, local_date);

-- ---------------------------------------------------------------------------
-- Nutrition
-- ---------------------------------------------------------------------------
create table meal_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  title text not null,
  category text not null check (category in ('breakfast','snack','lunch','dinner','drink','post_workout')),
  ingredients_json jsonb not null default '[]'::jsonb,
  restrictions_json jsonb not null default '[]'::jsonb,
  prep_minutes int,
  notes text,
  is_example boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table meal_plan_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  local_date date not null,
  meal_slot text not null check (meal_slot in ('breakfast','lunch','dinner','snack','post_workout')),
  planned_at timestamptz,
  template_id uuid references meal_templates(id) on delete set null,
  schedule_event_id uuid references schedule_events(id) on delete set null,
  description text,
  expected_items_json jsonb not null default '[]'::jsonb,
  status text not null default 'planned' check (status in ('planned','eaten','partial','replaced','skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index meal_plan_slot_idx on meal_plan_entries(user_id, local_date, meal_slot) where meal_slot <> 'snack';

create table meal_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  meal_plan_id uuid references meal_plan_entries(id) on delete set null,
  schedule_event_id uuid references schedule_events(id) on delete set null,
  local_date date not null,
  meal_slot text not null check (meal_slot in ('breakfast','lunch','dinner','snack','post_workout')),
  eaten_at timestamptz not null,
  description text,
  consumption_status text not null check (consumption_status in ('all','part','replaced','not_eaten')),
  portion_fraction numeric,
  drinks_json jsonb not null default '[]'::jsonb,
  media_id uuid references media_assets(id) on delete set null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meal_logs_user_date_idx on meal_logs(user_id, local_date);

create table ai_interpretations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  media_id uuid references media_assets(id) on delete cascade,
  inbox_item_id uuid references inbox_items(id) on delete cascade,
  operation text not null,
  provider text not null,
  model text,
  structured_json jsonb not null default '{}'::jsonb,
  confidence numeric,
  needs_review boolean not null default true,
  confirmed_at timestamptz,
  rejected_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index ai_interp_media_idx on ai_interpretations(media_id);

-- ---------------------------------------------------------------------------
-- Shopping
-- ---------------------------------------------------------------------------
create table shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  week_start date not null,
  name text not null,
  list_type text not null check (list_type in ('personal','household')),
  status text not null default 'active' check (status in ('active','archived')),
  estimated_cost_cents int,
  currency text not null default 'EUR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start, list_type)
);

create table shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  list_id uuid not null references shopping_lists(id) on delete cascade,
  name text not null,
  name_normalized text not null,
  quantity numeric,
  unit text,
  category text not null default 'other',
  checked boolean not null default false,
  checked_at timestamptz,
  source text not null default 'manual',
  source_meal_id uuid references meal_templates(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shopping_items_list_idx on shopping_items(list_id);

-- ---------------------------------------------------------------------------
-- Fitness
-- ---------------------------------------------------------------------------
create table workout_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  name text not null,
  days_per_week int not null default 2,
  status text not null default 'active' check (status in ('active','archived')),
  routines_json jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  plan_id uuid references workout_plans(id) on delete set null,
  schedule_event_id uuid references schedule_events(id) on delete set null,
  routine_key text,
  local_date date not null,
  started_at timestamptz,
  finished_at timestamptz,
  duration_minutes int,
  status text not null default 'started' check (status in ('planned','started','completed','cancelled')),
  perceived_effort int check (perceived_effort between 1 and 10),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workout_sessions_user_idx on workout_sessions(user_id, local_date);

create table workout_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  session_id uuid not null references workout_sessions(id) on delete cascade,
  exercise_key text not null,
  set_order int not null,
  target_reps int,
  actual_reps int,
  weight_kg numeric,
  rpe numeric,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index workout_sets_session_idx on workout_sets(session_id);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_id uuid references schedule_events(id) on delete cascade,
  channel text not null check (channel in ('in_app','telegram','web_push')),
  kind text not null check (kind in ('soft','important','review')),
  reminder_type text not null,
  message_key text not null unique,
  scheduled_at timestamptz not null,
  sent_at timestamptz,
  status text not null default 'scheduled'
    check (status in ('scheduled','sent','delivered_unknown','failed','acknowledged','cancelled','skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  payload_json jsonb not null default '{}'::jsonb,
  last_error text,
  acknowledged_at timestamptz,
  read_at timestamptz,
  cancel_reason text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbox_due_idx on notification_outbox(status, scheduled_at);
create index outbox_user_idx on notification_outbox(user_id, scheduled_at desc);
create index outbox_event_idx on notification_outbox(event_id);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_success_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table telegram_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  chat_id bigint not null unique,
  telegram_user_id bigint not null,
  username text,
  connected_at timestamptz not null default now(),
  is_active boolean not null default true,
  last_update_id bigint,
  notification_enabled boolean not null default true,
  pending_state jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table telegram_link_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table telegram_events (
  id uuid primary key default gen_random_uuid(),
  bot_update_id bigint not null unique,
  chat_id bigint,
  user_id uuid references users(id) on delete set null,
  update_type text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received','processed','ignored','failed')),
  result_json jsonb
);

-- ---------------------------------------------------------------------------
-- Reviews & rewards
-- ---------------------------------------------------------------------------
create table weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  week_start_date date not null,
  facts_json jsonb not null,
  ai_insights_json jsonb,
  proposals_json jsonb not null default '[]'::jsonb,
  decisions_json jsonb not null default '{}'::jsonb,
  status text not null default 'generated' check (status in ('generated','decided')),
  generated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start_date)
);

create table reward_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  title text not null,
  target_amount_cents int not null check (target_amount_cents >= 0),
  currency text not null default 'EUR',
  priority int not null default 0,
  status text not null default 'active' check (status in ('active','redeemed','archived')),
  link text,
  notes text,
  image_media_id uuid references media_assets(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table reward_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  goal_id uuid references reward_goals(id) on delete set null,
  period_key text not null,
  entry_type text not null check (entry_type in ('earned','approved','funded','redeemed','adjusted')),
  amount_cents int not null,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','funded','redeemed','final')),
  origin_key text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, origin_key)
);

create table xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  source_type text not null,
  source_id text not null,
  points int not null,
  reason text not null,
  local_date date not null,
  created_at timestamptz not null default now(),
  unique (user_id, source_type, source_id)
);

-- ---------------------------------------------------------------------------
-- Audit & usage
-- ---------------------------------------------------------------------------
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  entity_type text not null,
  entity_id text,
  action text not null,
  safe_diff_json jsonb not null default '{}'::jsonb,
  source text not null default 'web',
  created_at timestamptz not null default now()
);
create index audit_user_idx on audit_events(user_id, created_at desc);

create table external_api_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  provider text not null,
  operation text not null,
  request_id text,
  units numeric,
  estimated_cost numeric,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index api_usage_user_idx on external_api_usage(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'users','profiles','routine_preferences','projects','tasks','inbox_items','schedule_templates',
    'schedule_events','day_plans','habit_definitions','habit_checkins','media_assets','health_measurements',
    'meal_templates','meal_plan_entries','meal_logs','shopping_lists','shopping_items','workout_plans',
    'workout_sessions','notification_outbox','telegram_connections','weekly_reviews','reward_goals','reward_ledger'
  ]) loop
    execute format('create trigger %I before update on %I for each row execute function app.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security: every user-owned table is restricted to app.current_user_id()
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'profiles','routine_preferences','projects','tasks','inbox_items','schedule_templates','plan_versions',
    'schedule_events','plan_changes','day_plans','habit_definitions','habit_checkins','media_assets',
    'health_measurements','meal_templates','meal_plan_entries','meal_logs','ai_interpretations',
    'shopping_lists','shopping_items','workout_plans','workout_sessions','workout_sets',
    'notification_outbox','push_subscriptions','telegram_connections','weekly_reviews','reward_goals',
    'reward_ledger','xp_events','audit_events','external_api_usage'
  ]) loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to lifeos_user using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_owner', t);
    execute format('grant select, insert, update, delete on %I to lifeos_user', t);
  end loop;
end $$;

-- users: a user may read only their own identity row (no password hash exposure via column grant)
alter table users enable row level security;
create policy users_self on users for select to lifeos_user using (id = app.current_user_id());
grant select (id, email, display_name, role, created_at) on users to lifeos_user;
-- sessions, auth_attempts, telegram_link_tokens, telegram_events: system-only (no grants)
