# Life OS — notes for contributors (humans and agents)

Requirements: `LifeOS_PRD_v1.0_RU.md` (source of truth) and `START_HERE_CLAUDE.md`. UI language is **Russian**.
Stack decision (owner): **plain PostgreSQL, no Supabase, no paid services except optional AI**. Self-hosted (Docker on the `netcup` server, `life.astudypro.com`).

## Commands
- `pnpm dev` (port 3000), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (vitest unit + integration), `pnpm e2e` (Playwright)
- `pnpm db:create-local && pnpm db:migrate` — local Postgres (`.env.local`: `DATABASE_URL`, `TEST_DATABASE_URL`)
- `pnpm user:create you@example.com` — accounts (sign-up is closed unless `SIGNUP_MODE=open`)
- `pnpm worker` — reminder/materialisation loop; `pnpm bot:poll` — Telegram long polling
- Integration tests **drop and recreate the schema** of `TEST_DATABASE_URL`. When several people/agents run tests at once, give each its own DB: `TEST_DATABASE_URL=postgres://vik@localhost:5432/lifeos_test_x pnpm vitest run tests/integration/foo.test.ts` (created automatically).

## Architecture (PRD §15.2)
```
src/domain/      pure TS, no IO: time (Europe/Lisbon, DST), planner (prefs → templates → materialize,
                 extraWork preview, now-state), notifications/reminders, capture (rule parser + zod
                 schema for proposed actions), shopping normalisation, nutrition/fitness catalogs
src/server/      server-only: env.ts, db.ts (withUser / withSystem), http.ts (userRoute, AppError),
                 context.ts (now(), inUser), auth/, services/*, views/*, ai/, telegram/, push/, storage/, worker/
src/app/         Next.js 16 App Router: (auth)/, (app)/ pages, api/ route handlers
src/components/  ui/ (design system), shell/, events/, today/, plan/, capture/ …
db/migrations/   plain SQL, applied in order by scripts/migrate.ts (never edit an applied file — add a new one)
tests/unit, tests/integration (real Postgres), tests/e2e (Playwright)
```
**Rule: no business logic in React, Telegram handlers or AI code** — they all call the same `src/server/services/*`.

## Data access & security
- Every user-scoped operation runs in `withUser(userId, tx => …)` (or `inUser(userId, (tx, ctx) => …)` which also loads `UserContext`: profile, prefs, privacy, templates, tz). This sets `role lifeos_user` + `app.user_id`, so **Postgres RLS enforces isolation**. Always still filter `where user_id = ${ctx.userId}` in queries for clarity.
- `withSystem` (owner, bypasses RLS) only for: auth, worker scans across users, telegram chat→user routing, retention purge.
- postgres.js returns **camelCase** columns; `date` → `'YYYY-MM-DD'` string, `time` → `'HH:mm'`, `numeric`/`int8` → number, `timestamptz` → `Date`. Use `tx.json(obj as never)` for jsonb params. Use `one(rows)` for RETURNING that must hit one row.
- New user tables: `user_id uuid not null default app.current_user_id() references users(id) on delete cascade`, enable RLS, policy `user_id = app.current_user_id()`, grant to `lifeos_user` (see 0001_init.sql loop).
- Never log user content or secrets. Errors → `AppError(code, russianMessage, status, details?)`; route wrapper `userRoute` returns `{code, message, fieldErrors?, correlationId?}`.
- Mutating API routes are same-origin only (checked in `userRoute`). Validate all input with zod.

## Time
- Store instants as timestamptz (UTC); interpret with the user's IANA zone (`ctx.tz`). Use helpers in `src/domain/time.ts`
  (`zoned(date, 'HH:mm', tz)`, `localDateOf`, `weekStartOf`, `formatDateRu`, `formatRange`). **Never** `toISOString().slice(0,10)` for a local date.
- Use `now()` from `src/server/context.ts` (supports `LIFEOS_FAKE_NOW` in dev/test), pass `now: DateTime` into services.

## Product rules that code must respect
- Statuses: `planned → notified → started → completed`; `snoozed`, `rescheduled`, `skipped`, `unanswered`, `cancelled`. Started ≠ completed. No answer = unknown, not missed.
- Sleep and meals are never shortened automatically; conflicts are shown, not resolved silently. No silent moves outside the week.
- AI output = suggestion only, schema-validated, user confirms. "No data" ≠ 0. Body photos only with opt-in. No calorie numbers from photos.
- Rewards are virtual, never exceed the user's budget, never for weight/calories/overtime, idempotent.
- Every button works or honestly says the integration is not configured.

## UI conventions
- Components in `src/components/ui`: `Button` (variants primary/secondary/soft/ghost/danger), `Card`, `Section`, `Badge`, `Sheet` (bottom sheet / dialog), `Input`/`Textarea`/`Select`/`Switch`/`Chips`, `Segmented`, `EmptyState`/`ErrorState`/`Notice`/`Skeleton`, `useToast()`.
- Colours only via tokens (`bg-surface`, `text-muted`, `bg-accent`, `text-danger`, `var(--c-meal)` …). Touch targets ≥ 44px (`min-h-11`). Mobile first (375–430px), desktop 1280+.
- Pages are server components that load data via services (`requirePageUser()` + `inUser`), interactive parts are client components calling `/api/*` with `api()` from `src/lib/api.ts`, then `router.refresh()`.
- Client user info: `useClientUser()` (tz, today, workStart/End). Global sheets: `openCapture()`, `openExtraWork(minutes?)` from `src/components/shell/events.ts`.
- Each screen needs loading / empty / error / success states.
