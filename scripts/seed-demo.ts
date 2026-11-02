import { loadEnv } from './_env';

/**
 * `pnpm seed:demo` — creates a clearly labelled DEMO account (demo@lifeos.local, role "test") and
 * replays a plausible past week through the real services (no direct inserts of fake facts into
 * someone's real account). Use it to look at the plan / reviews with data. Never runs against an
 * existing non-demo user.
 *
 *   LIFEOS_PASSWORD=... pnpm seed:demo        (default password: demo-password-123)
 */
async function main() {
  loadEnv();
  const { DateTime } = await import('luxon');
  const { createUser } = await import('../src/server/auth/users');
  const { withSystem, withUser, closeDb } = await import('../src/server/db');
  const { saveOnboarding, loadContext } = await import('../src/server/services/profile');
  const planning = await import('../src/server/services/planning');
  const { addMeasurement } = await import('../src/server/services/health');
  const { logMeal } = await import('../src/server/services/meals');
  const { createTask } = await import('../src/server/services/tasks');
  const { addShoppingItem } = await import('../src/server/services/shopping');
  const { addDays, weekStartOf } = await import('../src/domain/time');

  const email = 'demo@lifeos.local';
  const tz = 'Europe/Lisbon';
  try {
    const existing = await withSystem((tx) => tx<{ id: string; role: string }[]>`select id, role from users where email_normalized = ${email}`);
    if (existing[0] && existing[0].role !== 'test') throw new Error('demo@lifeos.local exists and is not a test account — refusing');
    if (existing[0]) {
      await withSystem((tx) => tx`delete from users where id = ${existing[0]!.id}`);
      console.log('• old demo account removed');
    }
    const u = await createUser({ email, password: process.env.LIFEOS_PASSWORD ?? 'demo-password-123', displayName: 'Демо-аккаунт', role: 'test', timezone: tz });
    const id = u.id;

    const today = DateTime.now().setZone(tz).toISODate()!;
    const lastWeek = addDays(weekStartOf(today), -7);
    const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: tz }).toUTC();

    // onboarding as of the previous Sunday evening, so last week gets materialised
    const onboardNow = at(addDays(lastWeek, -1), '20:00');
    await withUser(id, (tx) =>
      saveOnboarding(tx, id, { displayName: 'Демо', timezone: tz, workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00', morningPrepMinutes: 60, wakeTime: '08:00', bedTime: '00:00', gymDays: [2, 4] }),
    );
    await withUser(id, async (tx) => planning.ensureMaterialized(tx, await loadContext(tx, id), onboardNow, lastWeek, addDays(weekStartOf(today), 13)));

    // replay last week day by day
    for (let i = 0; i < 7; i++) {
      const d = addDays(lastWeek, i);
      const isWork = i < 5;
      await withUser(id, async (tx) => {
        const ctx = await loadContext(tx, id);
        const evs = await tx<{ id: string; kind: string }[]>`select id, kind from schedule_events where user_id = ${id} and local_date = ${d} and status = 'planned' order by start_at`;
        for (const e of evs) {
          const t = at(d, '23:00');
          if (e.kind === 'meal_breakfast' && i !== 2) await logMeal(tx, ctx, at(d, '08:55'), { eventId: e.id, consumptionStatus: 'all', drinks: [] });
          else if (e.kind === 'meal_lunch' && isWork && i % 2 === 0) await logMeal(tx, ctx, at(d, '13:40'), { eventId: e.id, consumptionStatus: i === 4 ? 'part' : 'all', drinks: [] });
          else if (e.kind === 'meal_lunch' && i === 3) await planning.transitionEvent(tx, ctx, t, e.id, { action: 'skip', reason: 'Созвон' });
          else if (e.kind === 'meal_dinner' && i !== 5) await logMeal(tx, ctx, at(d, '20:10'), { eventId: e.id, consumptionStatus: 'all', description: 'Домашнее блюдо', drinks: [] });
          else if (e.kind === 'work' && isWork) await planning.transitionEvent(tx, ctx, t, e.id, { action: 'complete' });
          else if (e.kind === 'workout' && i === 1) await planning.transitionEvent(tx, ctx, t, e.id, { action: 'complete', actualMinutes: 55 });
          else if (e.kind === 'own_project' && i === 5) await planning.transitionEvent(tx, ctx, t, e.id, { action: 'complete', actualMinutes: 50 });
        }
        if (i % 2 === 0) await addMeasurement(tx, ctx, at(d, '08:10'), { metricType: 'weight', value: 53 + i * 0.1, sourceType: 'manual', replace: false });
        if (i !== 3) await addMeasurement(tx, ctx, at(d, '22:00'), { metricType: 'steps', value: 5200 + i * 650, sourceType: 'manual', replace: false });
        await addMeasurement(tx, ctx, at(d, '13:00'), { metricType: 'water_ml', value: 500, sourceType: 'manual', replace: false });
      });
    }

    // a Wednesday overtime: preview + commit through the real planner
    const wed = addDays(lastWeek, 2);
    await withUser(id, async (tx) => {
      const ctx = await loadContext(tx, id);
      const now = at(wed, '17:50');
      const p = await planning.extraWorkPreview(tx, ctx, now, { date: wed, startMode: 'after_work', durationMinutes: 90, reason: 'важная задача' });
      if (p.canCommit) {
        await planning.extraWorkCommit(tx, ctx, now, { date: wed, startMode: 'after_work', startTime: null, durationMinutes: 90, reason: 'важная задача', expectedPlanVersion: p.basePlanVersion, acknowledgeRisks: true });
      }
    });

    await withUser(id, async (tx) => {
      const ctx = await loadContext(tx, id);
      const now = DateTime.utc();
      await createTask(tx, ctx, { title: 'Записаться на чистку зубов', type: 'task', category: 'health', priority: 'normal' });
      await createTask(tx, ctx, { title: 'Выбрать медицинскую страховку', type: 'task', category: 'finance', priority: 'high', dueDate: addDays(today, 5) });
      await createTask(tx, ctx, { title: 'Письмо ипотечному брокеру: ждать ответа', type: 'waiting', category: 'finance', priority: 'normal', waitingFor: 'Брокер', followUpDate: addDays(today, 2) });
      await createTask(tx, ctx, { title: 'Подумать про поход в горы', type: 'idea', category: 'idea', priority: 'low' });
      for (const name of ['Бананы', 'Молоко', 'Овсяные хлопья', 'Орехи'])
        await addShoppingItem(tx, ctx, now, { name, quantity: null, unit: null, listType: 'personal' }, 'manual');
    });

    console.log(`✓ Демо-аккаунт готов: ${email} (пароль: ${process.env.LIFEOS_PASSWORD ? 'из LIFEOS_PASSWORD' : 'demo-password-123'}). Неделя ${lastWeek} заполнена через сервисы.`);
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
