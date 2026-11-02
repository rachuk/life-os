import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { addDays, isLocalDate, localDateOf, weekDates, weekStartOf } from '@/domain/time';
import { listMealLogs, mealsRange, serializeMealLog } from '@/server/services/meals';
import { Section } from '@/components/ui/Card';
import { Notice } from '@/components/ui/States';
import { Catalog, RecentLogs, WeekMenu, type MealLog } from '@/components/meals/MealsClient';

export const metadata = { title: 'Питание' };

export default async function MealsPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requirePageUser();
  const { week } = await searchParams;
  const data = await inUser(user.id, async (tx, ctx) => {
    const today = localDateOf(now(), ctx.tz);
    const weekStart = weekStartOf(week && isLocalDate(week) ? week : today);
    const range = await mealsRange(tx, ctx.userId, weekStart, addDays(weekStart, 6));
    const logs = (await listMealLogs(tx, ctx.userId, addDays(today, -6), today)).map(serializeMealLog);
    return { weekStart, range, logs };
  });

  return (
    <div className="space-y-6">
      <header>
        <Link href="/health" className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm text-muted hover:text-text">
          <ChevronLeft className="size-4" /> Здоровье
        </Link>
        <h1 className="text-2xl font-semibold">Питание</h1>
        <p className="text-sm text-muted">Регулярная еда без подсчёта калорий: быстрые завтраки, домашние обеды и ужины.</p>
      </header>

      <Notice>
        Шаблоны — примеры, а не медицинское предписание. Аллергии и ограничения не заданы — это не значит, что их нет: проверяй состав сам.
      </Notice>

      <Section title="Меню недели">
        <WeekMenu weekStart={data.weekStart} days={weekDates(data.weekStart)} plan={data.range.plan} templates={data.range.templates} />
      </Section>

      <Section title="Шаблоны блюд">
        <Catalog templates={data.range.templates} />
      </Section>

      <Section title="Отметки за 7 дней">
        <RecentLogs logs={data.logs as MealLog[]} />
      </Section>
    </div>
  );
}
