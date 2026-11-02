import Link from 'next/link';
import { Card, Section } from '@/components/ui/Card';

export interface WeekHabitFact {
  id: string;
  title: string;
  unit: string;
  phase: string;
  daysWithData: number;
  average: number | null;
  withinLimit: number;
  overLimit: number;
  patterns: { key: string; text: string; basedOn: string }[];
}

export interface WeekSkillFact {
  id: string;
  title: string;
  status: string;
  minutes: number;
  targetMinutes: number;
  sessions: number;
}

/** Habit change + skills facts for the weekly review (aggregates from SQL; no invented numbers). */
export function WeekChangeBlock({ habits, skills }: { habits: WeekHabitFact[]; skills: WeekSkillFact[] }) {
  if (!habits.length && !skills.length) return null;
  return (
    <div className="mt-6 space-y-6">
      {habits.length ? (
        <Section title="Изменение привычек" action={<Link href="/habits" className="text-sm text-accent">Открыть</Link>}>
          <div className="space-y-2">
            {habits.map((h) => (
              <Card key={h.id} className="space-y-1 p-4 text-sm">
                <p className="text-[15px] font-semibold">{h.title}</p>
                {h.daysWithData ? (
                  <p>
                    В среднем {h.average} {h.unit} в день · дней с данными: {h.daysWithData} из 7
                    {h.phase === 'reducing' || h.phase === 'quit' ? ` · в пределах лимита: ${h.withinLimit}, выше: ${h.overLimit}` : ' · неделя наблюдения'}
                  </p>
                ) : (
                  <p className="text-muted">Нет данных за эту неделю.</p>
                )}
                {h.patterns.map((p) => (
                  <p key={p.key} className="text-muted">
                    {p.text} <span className="text-xs text-faint">({p.basedOn})</span>
                  </p>
                ))}
              </Card>
            ))}
          </div>
        </Section>
      ) : null}
      {skills.length ? (
        <Section title="Навыки" action={<Link href="/skills" className="text-sm text-accent">Открыть</Link>}>
          <Card className="divide-y divide-border">
            {skills.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 truncate">{s.title}</span>
                <span className="tabular shrink-0 text-muted">
                  {s.minutes ? `${s.minutes} из ${s.targetMinutes} мин · занятий: ${s.sessions}` : s.targetMinutes ? `нет занятий (цель ${s.targetMinutes} мин)` : 'поддержка'}
                </span>
              </div>
            ))}
          </Card>
        </Section>
      ) : null}
    </div>
  );
}
