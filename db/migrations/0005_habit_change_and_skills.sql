-- Life OS v0.2: «Изменение привычек» (reduce / quit, first case IQOS) and «Навыки» (skills with
-- checkpoints). Additive only.

-- ---------------------------------------------------------------------------
-- Habit change
-- ---------------------------------------------------------------------------
create table habit_change_programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  key text not null,
  title text not null check (length(title) between 1 and 80),
  unit_label text not null default 'раз',
  direction text not null default 'reduce' check (direction in ('reduce', 'quit')),
  phase text not null default 'baseline' check (phase in ('baseline', 'reducing', 'quit', 'paused')),
  baseline_started_on date not null,
  baseline_days int not null default 7 check (baseline_days between 3 and 28),
  baseline_per_day numeric,
  daily_limit int check (daily_limit >= 0),
  step_per_week int not null default 1 check (step_per_week between 0 and 10),
  limit_set_on date,
  quit_date date,
  price_per_unit_cents int check (price_per_unit_cents >= 0),
  currency text not null default 'EUR',
  reasons jsonb not null default '[]'::jsonb,
  alternatives jsonb not null default '[]'::jsonb,
  show_on_today boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create table habit_change_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  program_id uuid not null references habit_change_programs(id) on delete cascade,
  kind text not null check (kind in ('use', 'urge_resisted', 'day_total')),
  occurred_at timestamptz not null,
  local_date date not null,
  quantity int not null default 1 check (quantity between 0 and 200),
  reason text,
  context jsonb not null default '{}'::jsonb,
  source text not null default 'web',
  note text,
  created_at timestamptz not null default now()
);
create index habit_change_events_idx on habit_change_events(user_id, program_id, local_date);
-- one end-of-day total per program and date (it overrides the per-use sum for that day)
create unique index habit_change_day_total_idx on habit_change_events(program_id, local_date) where kind = 'day_total';

-- ---------------------------------------------------------------------------
-- Skills
-- ---------------------------------------------------------------------------
create table skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  title text not null check (length(title) between 1 and 80),
  area text not null default 'other' check (area in ('language', 'communication', 'leadership', 'professional', 'other')),
  why text,
  target_description text,
  level_scale text not null default 'five' check (level_scale in ('cefr', 'five')),
  current_level int not null default 1 check (current_level between 1 and 6),
  target_level int not null default 3 check (target_level between 1 and 6),
  status text not null default 'active' check (status in ('active', 'maintenance', 'paused', 'done')),
  weekly_minutes int not null default 90 check (weekly_minutes between 0 and 1200),
  session_minutes int not null default 20 check (session_minutes between 5 and 180),
  template_id uuid references schedule_templates(id) on delete set null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index skills_user_idx on skills(user_id, status);

create table skill_practice_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  skill_id uuid not null references skills(id) on delete cascade,
  local_date date not null,
  minutes int not null check (minutes between 1 and 600),
  activity text,
  schedule_event_id uuid references schedule_events(id) on delete set null,
  source text not null default 'web',
  created_at timestamptz not null default now()
);
create index skill_practice_idx on skill_practice_logs(user_id, skill_id, local_date);
create unique index skill_practice_event_idx on skill_practice_logs(schedule_event_id) where schedule_event_id is not null;

create table skill_checkpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  skill_id uuid not null references skills(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  description text,
  due_date date,
  status text not null default 'planned' check (status in ('planned', 'passed', 'not_yet')),
  result_level int check (result_level between 1 and 6),
  notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index skill_checkpoints_idx on skill_checkpoints(user_id, skill_id, status);

-- ---------------------------------------------------------------------------
-- triggers, RLS, grants
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array['habit_change_programs', 'skills', 'skill_checkpoints']) loop
    execute format('create trigger %I before update on %I for each row execute function app.touch_updated_at()', t || '_touch', t);
  end loop;
  for t in select unnest(array['habit_change_programs', 'habit_change_events', 'skills', 'skill_practice_logs', 'skill_checkpoints']) loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for all to lifeos_user using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())', t || '_owner', t);
    execute format('grant select, insert, update, delete on %I to lifeos_user', t);
  end loop;
end $$;
