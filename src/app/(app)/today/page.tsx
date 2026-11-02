import { Dumbbell, Footprints, Utensils } from 'lucide-react';
import Link from 'next/link';
import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { getTodayData } from '@/server/views/today';
import { currentLimit, dayTotal, listPrograms } from '@/server/services/habitChange';
import { formatDateRu, localDateOf } from '@/domain/time';
import { TodayClient } from '@/components/today/TodayClient';
import { HabitQuickCard } from '@/components/habitChange/HabitQuickCard';

export const metadata = { title: 'Сегодня' };

const nf = new Intl.NumberFormat('ru-RU');

function Metric({ icon, label, value, hint, href }: { icon: React.ReactNode; label: string; value: string; hint?: string; href: string }) {
  return (
    <Link href={href} className="block min-w-0 rounded-2xl border border-border bg-surface px-3 py-2.5 hover:bg-surface-2">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className="tabular mt-0.5 truncate text-[17px] font-semibold">{value}</div>
      {hint ? <div className="truncate text-xs text-muted">{hint}</div> : null}
    </Link>
  );
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requirePageUser();
  const { date } = await searchParams;
  const t = now();
  const { data, habits } = await inUser(user.id, async (tx, ctx) => {
    const today = localDateOf(t, ctx.tz);
    const programs = (await listPrograms(tx, user.id)).filter((p) => p.showOnToday);
    return {
      data: await getTodayData(tx, ctx, t, date ?? null),
      habits: await Promise.all(
        programs.map(async (p) => ({
          id: p.id,
          title: p.title,
          unit: p.unitLabel,
          todayTotal: await dayTotal(tx, user.id, p.id, today),
          limit: currentLimit(p, today),
          phase: p.phase,
          reasons: p.reasons,
          alternatives: p.alternatives,
        })),
      ),
    };
  });
  const p = data.progress;
  // meals count only once their time has come — "0 из 3" before breakfast is not a failure
  const nowIso = t.toISO()!;
  const mealEvents = data.events.filter((e) => ['meal_breakfast', 'meal_lunch', 'meal_dinner'].includes(e.kind) && e.status !== 'cancelled');
  const dueMeals = data.isToday ? mealEvents.filter((e) => e.startAt <= nowIso) : mealEvents;
  const eaten = dueMeals.filter((e) => e.status === 'completed').length;
  const ahead = mealEvents.length - dueMeals.length;

  const metrics = (
    <section aria-label="Показатели дня" className="grid grid-cols-3 gap-2">
      <Metric
        icon={<Utensils className="size-3.5" />}
        label="Еда"
        value={dueMeals.length ? `${eaten} из ${dueMeals.length}` : '—'}
        hint={ahead ? `впереди: ${ahead}` : dueMeals.length - eaten > 0 ? `без отметки: ${dueMeals.length - eaten}` : undefined}
        href="/health"
      />
      <Metric
        icon={<Footprints className="size-3.5" />}
        label="Шаги"
        value={data.health.steps !== null ? nf.format(data.health.steps) : '—'}
        hint={data.health.steps === null ? 'нет данных' : undefined}
        href="/health#steps"
      />
      <Metric icon={<Dumbbell className="size-3.5" />} label="Тренировки" value={`${p.workouts.completed} из ${p.workouts.target}`} hint="за неделю" href="/workouts" />
    </section>
  );

  return (
    <div className="space-y-4">
      <header className="hidden lg:block">
        <p className="text-sm text-muted">{formatDateRu(data.date, { long: true })}</p>
      </header>
      <TodayClient
        events={data.events}
        now={data.now}
        isToday={data.isToday}
        date={data.date}
        metrics={metrics}
        habits={data.isToday && habits.length ? <div className="space-y-2">{habits.map((h) => <HabitQuickCard key={h.id} p={h} />)}</div> : null}
        showChannelsHint={!data.telegramConnected}
      />
    </div>
  );
}
