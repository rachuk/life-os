-- Health / nutrition / shopping / workouts slice (PRD §7–10).

-- Progression suggestions are suggestions only (PRD §10.3): the user's answer is remembered per
-- exercise and per source session, so a dismissed suggestion does not come back until new data exists.
create table workout_progression_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  exercise_key text not null,
  based_on_session_id uuid not null references workout_sessions(id) on delete cascade,
  decision text not null check (decision in ('accepted','dismissed')),
  suggested_weight_kg numeric,
  created_at timestamptz not null default now(),
  unique (user_id, exercise_key, based_on_session_id)
);
create index workout_progression_user_idx on workout_progression_decisions(user_id, exercise_key);

alter table workout_progression_decisions enable row level security;
create policy workout_progression_decisions_owner on workout_progression_decisions for all to lifeos_user
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update, delete on workout_progression_decisions to lifeos_user;

-- at most one running session per user, and one live session per planned workout event
create unique index workout_sessions_one_started_idx on workout_sessions(user_id) where status = 'started';
create unique index workout_sessions_event_live_idx on workout_sessions(schedule_event_id)
  where schedule_event_id is not null and status in ('started','completed');
create index workout_sets_user_exercise_idx on workout_sets(user_id, exercise_key);

-- shopping items generated from the menu are recognised on regeneration (HEALTH-08)
create index shopping_items_source_idx on shopping_items(list_id, source);
