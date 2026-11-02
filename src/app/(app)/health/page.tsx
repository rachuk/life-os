import { Camera, ChevronRight, Utensils } from 'lucide-react';
import Link from 'next/link';
import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { addDays, formatDateRu, weekStartOf } from '@/domain/time';
import { MEAL_KINDS } from '@/domain/types';
import { healthSummary, healthToday } from '@/server/services/health';
import { habitsWeek } from '@/server/services/habits';
import { mealPlanForRange } from '@/server/services/meals';
import { dayEvents, ensureMaterialized, serializeEvent } from '@/server/services/planning';
import { Section } from '@/components/ui/Card';
import { HealthCharts } from '@/components/health/HealthCharts';
import { HealthMealsToday } from '@/components/health/HealthMealsToday';
import { HealthToday } from '@/components/health/HealthToday';
import { HabitWeek } from '@/components/health/HabitWeek';

export const metadata = { title: 'Здоровье' };

export default async function HealthPage() {
  const user = await requirePageUser();
  const data = await inUser(user.id, async (tx, ctx) => {
    const t = now();
    const today = await healthToday(tx, ctx, t);
    await ensureMaterialized(tx, ctx, t, today.date, today.date);
    const meals = (await dayEvents(tx, ctx, today.date)).filter((e) => MEAL_KINDS.includes(e.kind) && e.status !== 'cancelled');
    const plan = await mealPlanForRange(tx, ctx.userId, today.date, today.date);
    const week = await habitsWeek(tx, ctx.userId, weekStartOf(today.date));
    const summary = await healthSummary(tx, ctx.userId, addDays(today.date, -29), today.date);
    return { today, meals: meals.map(serializeEvent), plan, week, summary };
  });
  const dishes = Object.fromEntries(data.plan.map((p) => [p.mealSlot, p.templateTitle ?? p.description ?? ''])) as Record<string, string>;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Здоровье</h1>
          <p className="text-sm text-muted">{formatDateRu(data.today.date, { long: true })}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/health/meals" className="flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm hover:bg-surface-2">
            <Utensils className="size-4" /> Питание и меню
          </Link>
          <Link href="/health/photo" className="flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface px-3 text-sm hover:bg-surface-2">
            <Camera className="size-4" /> Фото
          </Link>
        </div>
      </header>

      <Section title="Сегодня">
        <HealthToday data={data.today} />
      </Section>

      <Section
        title="Еда сегодня"
        action={
          <Link href="/health/meals" className="flex min-h-11 items-center text-sm text-accent">
            Меню недели <ChevronRight className="size-4" />
          </Link>
        }
      >
        <HealthMealsToday events={data.meals} dishes={dishes} />
      </Section>

      <Section title="Правила недели">
        <HabitWeek habits={data.week.habits} checkins={data.week.checkins} days={data.week.days} today={data.today.date} />
      </Section>

      <Section title="Динамика">
        <HealthCharts initial={data.summary} today={data.today.date} />
      </Section>
    </div>
  );
}
