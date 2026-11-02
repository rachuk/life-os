-- Telegram bot & media slice (PRD §11, §12.4, §19.1).

-- A reminder/inline button press is applied at most once per (chat, message, button), even when
-- Telegram delivers the repeated tap as a new update_id (NT-04). Stored in the same user
-- transaction as the action itself, so "recorded" always means "applied".
create table telegram_callback_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references users(id) on delete cascade,
  chat_id bigint not null,
  message_id bigint not null,
  data text not null,
  result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (chat_id, message_id, data)
);
create index telegram_callback_actions_user_idx on telegram_callback_actions(user_id, created_at desc);

alter table telegram_callback_actions enable row level security;
create policy telegram_callback_actions_owner on telegram_callback_actions for all to lifeos_user
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update, delete on telegram_callback_actions to lifeos_user;

-- housekeeping lookups (system-only tables, no grants to lifeos_user)
create index telegram_link_tokens_user_idx on telegram_link_tokens(user_id);
create index telegram_events_chat_idx on telegram_events(chat_id, received_at desc);

-- retention purge scans by deadline
create index media_assets_retention_idx on media_assets(retention_until) where retention_until is not null;
