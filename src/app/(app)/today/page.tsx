import { Footprints, Scale, Utensils, Dumbbell } from 'lucide-react';
import Link from 'next/link';
import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { getTodayData } from '@/server/views/today';
import { formatDateRu } from '@/domain/time';
import { Card } from '@/components/ui/Card';
import { TodayClient } from '@/components/today/TodayClient';

export const metadata = { title: 'Сегодня' };

function Metric({ icon, label, value, hint, href }: { icon: React.ReactNode; label: string; value: string; hint?: string; href: string }) {
  return (
    <Link href={href} className="block rounded-2xl border border-border bg-surface p-3 hover:bg-surface-2">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className="tabular mt-1 text-lg font-semibold">{value}</div>
      {hint ? <div className="text-xs text-faint">{hint}</div> : null}
    </Link>
  );
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requirePageUser();
  const { date } = await searchParams;
  const data = await inUser(user.id, (tx, ctx) => getTodayData(tx, ctx, now(), date ?? null));
  const p = data.progress;
  return (
    <div className="space-y-5">
      <header className="hidden lg:block">
        <p className="text-sm text-muted">{formatDateRu(data.date, { long: true, year: false })}</p>
      </header>

      <TodayClient events={data.events} now={data.now} isToday={data.isToday} />

      <section aria-label="Показатели дня" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric icon={<Utensils className="size-3.5" />} label="Еда" value={data.meals.planned ? `${data.meals.confirmed} из ${data.meals.planned}` : '—'} hint={data.meals.open ? `без отметки: ${data.meals.open}` : 'подтверждённые приёмы'} href="/health" />
        <Metric icon={<Footprints className="size-3.5" />} label="Шаги" value={data.health.steps !== null ? data.health.steps.toLocaleString('ru-RU') : 'нет данных'} hint={data.health.steps === null ? 'добавить вручную' : undefined} href="/health#steps" />
        <Metric icon={<Dumbbell className="size-3.5" />} label="Тренировки" value={`${p.workouts.completed} из ${p.workouts.target}`} hint="за неделю" href="/workouts" />
        <Metric icon={<Scale className="size-3.5" />} label="Вес" value={data.health.weight !== null ? `${data.health.weight} кг` : 'нет данных'} hint={data.health.weight === null ? 'необязательно' : 'сегодня'} href="/health#weight" />
      </section>

      {!data.telegramConnected ? (
        <Card className="p-4 text-sm">
          <p className="font-medium">Напоминания</p>
          <p className="mt-1 text-muted">
            Сейчас напоминания видны внутри приложения (колокольчик). Для сообщений на телефон подключи Telegram или push в{' '}
            <Link href="/settings#notifications" className="text-accent">
              настройках
            </Link>
            .
          </p>
        </Card>
      ) : null}
    </div>
  );
}
