-- The user blocked the bot: remember that the block (not the user's switch) turned reminders off,
-- so unblocking / «/start» turns them back on.
alter table telegram_connections add column if not exists blocked_at timestamptz;
