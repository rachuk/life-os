'use client';
import { Archive, Gift, Plus, Settings, Trophy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RewardsSummary } from '@/server/services/rewards';
import { formatDateRu } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';
import { centsToInput, ENTRY_TYPE, formatEuro, LEDGER_STATUS, parseEuroInput } from './format';

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${y}`;
};

type Goal = RewardsSummary['goals'][number];
type Entry = RewardsSummary['ledger'][number];
type SheetState = { type: 'goal'; goal: Goal | null } | { type: 'fund'; entry: Entry } | { type: 'redeem'; goal: Goal } | { type: 'adjust' } | { type: 'settings' } | null;

export function RewardsClient({ data }: { data: RewardsSummary }) {
  const router = useRouter();
  const toast = useToast();
  const [sheet, setSheet] = useState<SheetState>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!data.enabled) {
    return (
      <Card>
        <EmptyState title="Награды выключены" icon={<Gift className="size-6" />}>
          На этом сервере раздел наград выключен. Ничего не начисляется и не учитывается.
        </EmptyState>
      </Card>
    );
  }

  async function ledger(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      const r = await api<{ message: string }>('/api/rewards/ledger', { body });
      toast.ok(r.message);
      setSheet(null);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function archive(goal: Goal) {
    setBusy(`archive:${goal.id}`);
    try {
      await api(`/api/rewards/goals/${goal.id}`, { method: 'PATCH', body: { status: 'archived' } });
      toast.ok('Цель в архиве');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const b = data.budget;
  const t = data.totals;
  const active = data.goals.filter((g) => g.status === 'active');
  const proposed = data.ledger.filter((e) => e.status === 'proposed');

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold leading-tight">Награды</h1>
        <p className="text-[15px] text-muted">Фонд желаний — виртуальный учёт твоего собственного бюджета. Приложение не переводит деньги и не хранит реквизиты.</p>
      </header>

      {/* budget & totals */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">Бюджет: {monthLabel(b.month)}</h2>
            {b.budgetCents === null ? (
              <p className="mt-0.5 text-sm text-muted">Бюджет не задан — денежные награды не предлагаются. Сумму выбираешь только ты.</p>
            ) : (
              <p className="tabular mt-0.5 text-sm text-muted">
                Начислено {formatEuro(b.usedCents)} из {formatEuro(b.budgetCents)} · осталось {formatEuro(b.remainingCents ?? 0)}
              </p>
            )}
          </div>
          <Button size="sm" variant="ghost" icon={<Settings className="size-4" />} onClick={() => setSheet({ type: 'settings' })} className="min-h-11">
            Правила
          </Button>
        </div>
        {b.budgetCents ? (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Использование бюджета" aria-valuenow={b.usedCents} aria-valuemin={0} aria-valuemax={b.budgetCents}>
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (b.usedCents / b.budgetCents) * 100)}%` }} />
          </div>
        ) : null}
        <dl className="tabular mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Stat label="Предложено" value={formatEuro(t.proposedCents)} hint="ждёт подтверждения" />
          <Stat label="Подтверждено" value={formatEuro(t.approvedCents)} hint="ещё не отложено" />
          <Stat label="Отложено" value={formatEuro(t.fundedCents)} hint="ты перевёл сам" strong />
          <Stat label="Потрачено" value={formatEuro(t.redeemedCents)} hint="на желания" />
        </dl>
        {data.unallocatedFundedCents ? <p className="mt-2 text-xs text-muted">Отложено без цели: {formatEuro(data.unallocatedFundedCents)}</p> : null}
      </Card>

      {/* wish goals */}
      <section aria-labelledby="goals" className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h2 id="goals" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            Желания
          </h2>
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setSheet({ type: 'goal', goal: null })} className="min-h-11">
            Добавить
          </Button>
        </div>
        {data.goals.length ? (
          <ul className="space-y-2">
            {data.goals.map((g) => (
              <li key={g.id}>
                <Card className={cn('p-4', g.status === 'redeemed' && 'opacity-70')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium leading-snug">{g.title}</p>
                      {g.link ? (
                        <a href={g.link} target="_blank" rel="noopener noreferrer nofollow" className="block truncate text-xs text-accent">
                          {g.link}
                        </a>
                      ) : null}
                      {g.notes ? <p className="mt-0.5 text-sm text-muted">{g.notes}</p> : null}
                    </div>
                    {g.status === 'redeemed' ? <Badge tone="ok">куплено</Badge> : g.priority ? <Badge>приоритет {g.priority}</Badge> : null}
                  </div>
                  <div className="mt-3">
                    <div className="tabular flex justify-between text-sm">
                      <span>Отложено {formatEuro(g.fundedCents)}</span>
                      <span className="text-muted">из {formatEuro(g.targetAmountCents)}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={`Прогресс «${g.title}»`} aria-valuenow={Math.round(g.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full rounded-full bg-ok" style={{ width: `${g.progress * 100}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-muted">Прогресс считается только по реально отложенным деньгам, не по виртуальным начислениям.</p>
                  </div>
                  {g.status === 'active' ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" variant="soft" className="min-h-11" onClick={() => setSheet({ type: 'redeem', goal: g })}>
                        Куплено
                      </Button>
                      <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setSheet({ type: 'goal', goal: g })}>
                        Изменить
                      </Button>
                      <Button size="sm" variant="ghost" className="min-h-11" icon={<Archive className="size-4" />} loading={busy === `archive:${g.id}`} onClick={() => archive(g)}>
                        В архив
                      </Button>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Card>
            <EmptyState title="Желаний пока нет" icon={<Gift className="size-6" />} action={<Button variant="primary" onClick={() => setSheet({ type: 'goal', goal: null })}>Добавить желание</Button>}>
              Например, приставка, поездка или одежда — с примерной ценой в евро.
            </EmptyState>
          </Card>
        )}
      </section>

      {/* ledger */}
      <section aria-labelledby="ledger" className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h2 id="ledger" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            Журнал
          </h2>
          <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setSheet({ type: 'adjust' })}>
            Корректировка
          </Button>
        </div>
        {proposed.length > 1 ? (
          <Button variant="soft" block loading={busy === 'approve-all'} onClick={() => ledger({ action: 'approve', entryIds: proposed.map((e) => e.id) }, 'approve-all')}>
            Подтвердить все предложенные ({formatEuro(proposed.reduce((s, e) => s + e.amountCents, 0))})
          </Button>
        ) : null}
        <Card className="p-1.5">
          {data.ledger.length ? (
            <ul className="divide-y divide-border">
              {data.ledger.map((e) => (
                <li key={e.id} className="px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[15px] leading-snug">{e.notes ?? ENTRY_TYPE[e.entryType]}</p>
                      <p className="text-xs text-muted">
                        {ENTRY_TYPE[e.entryType]}
                        {e.weekStart ? ` · неделя с ${formatDateRu(e.weekStart)}` : ` · ${new Date(e.createdAt).toLocaleDateString('ru-RU')}`}
                        {e.goalId ? ` · ${data.goals.find((g) => g.id === e.goalId)?.title ?? 'цель'}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className={cn('tabular font-medium', e.status === 'rejected' && 'text-faint line-through')}>
                        {e.entryType === 'redeemed' ? '−' : e.entryType === 'adjusted' && e.amountCents > 0 ? '+' : ''}
                        {formatEuro(e.entryType === 'redeemed' ? Math.abs(e.amountCents) : e.amountCents)}
                      </span>
                      <Badge tone={LEDGER_STATUS[e.status].tone}>{LEDGER_STATUS[e.status].label}</Badge>
                    </div>
                  </div>
                  {e.status === 'proposed' ? (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="soft" className="min-h-11 flex-1" loading={busy === `approve:${e.id}`} onClick={() => ledger({ action: 'approve', entryIds: [e.id] }, `approve:${e.id}`)}>
                        Подтвердить
                      </Button>
                      <Button size="sm" variant="ghost" className="min-h-11" loading={busy === `reject:${e.id}`} onClick={() => ledger({ action: 'reject', entryIds: [e.id] }, `reject:${e.id}`)}>
                        Отклонить
                      </Button>
                    </div>
                  ) : e.status === 'approved' ? (
                    <Button size="sm" variant="secondary" className="mt-2 min-h-11 w-full" onClick={() => setSheet({ type: 'fund', entry: e })}>
                      Я отложил эти деньги
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-sm text-muted">Записей пока нет. Начисления появятся после обзора недели — если задан бюджет и правила.</p>
          )}
        </Card>
      </section>

      {/* XP — secondary layer */}
      <section aria-labelledby="xp" className="space-y-2">
        <h2 id="xp" className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">
          Опыт и достижения
        </h2>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
              <Trophy className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                Уровень {data.xp.level} · <span className="tabular">{data.xp.total} XP</span>
              </p>
              <p className="tabular text-xs text-muted">
                до уровня {data.xp.level + 1}: {data.xp.nextAt - data.xp.total} XP · на этой неделе +{data.xp.thisWeek}
              </p>
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Прогресс уровня" aria-valuenow={data.xp.total - data.xp.currentFloor} aria-valuemin={0} aria-valuemax={data.xp.nextAt - data.xp.currentFloor}>
            <div className="h-full rounded-full bg-accent" style={{ width: `${((data.xp.total - data.xp.currentFloor) / (data.xp.nextAt - data.xp.currentFloor)) * 100}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted">XP — только за подтверждённые действия: завтрак, тренировка, обзор недели, разбор входящих, важное личное дело, новое впечатление. Никогда — за вес, калории или переработки.</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {data.achievements.map((a) => (
              <li key={a.key} className={cn('rounded-xl border p-3', a.achieved ? 'border-accent bg-accent-soft' : 'border-border')}>
                <p className={cn('text-sm font-medium', a.achieved ? 'text-accent' : '')}>{a.title}</p>
                <p className="text-xs text-muted">
                  {a.description}
                  {!a.achieved ? ` · ${a.progress.current} из ${a.progress.target}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {data.xp.recent.length ? (
            <details className="mt-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm text-accent">Последние начисления XP</summary>
              <ul className="space-y-1 text-sm">
                {data.xp.recent.map((r, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>
                      {r.reason} <span className="text-xs text-muted">· {formatDateRu(r.localDate)}</span>
                    </span>
                    <span className="tabular text-muted">+{r.points}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      </section>

      {sheet?.type === 'goal' ? <GoalSheet goal={sheet.goal} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'settings' ? <SettingsSheet settings={data.settings} onClose={() => setSheet(null)} /> : null}
      {sheet?.type === 'fund' ? (
        <FundSheet entry={sheet.entry} goals={active} busy={busy === 'fund'} onClose={() => setSheet(null)} onFund={(goalId) => ledger({ action: 'fund', entryIds: [sheet.entry.id], goalId }, 'fund')} />
      ) : null}
      {sheet?.type === 'redeem' ? (
        <Sheet
          open
          onClose={() => setSheet(null)}
          title={`Куплено: ${sheet.goal.title}`}
          description="Запись «потрачено» в журнале. Можно отметить, даже если отложено меньше цели."
          footer={
            <Button variant="primary" block loading={busy === 'redeem'} onClick={() => ledger({ action: 'redeem', goalId: sheet.goal.id }, 'redeem')}>
              Отметить покупку ({formatEuro(sheet.goal.fundedCents)})
            </Button>
          }
        >
          <p className="text-sm text-muted">Сумма покупки по журналу — отложенное на эту цель: {formatEuro(sheet.goal.fundedCents)}.</p>
        </Sheet>
      ) : null}
      {sheet?.type === 'adjust' ? <AdjustSheet busy={busy === 'adjust'} onClose={() => setSheet(null)} onSubmit={(amountCents, note, idempotencyKey) => ledger({ action: 'adjust', amountCents, note, idempotencyKey }, 'adjust')} /> : null}
    </div>
  );
}

function Stat({ label, value, hint, strong }: { label: string; value: string; hint: string; strong?: boolean }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('text-base', strong ? 'font-semibold' : 'font-medium')}>{value}</dd>
      <dd className="text-xs text-muted">{hint}</dd>
    </div>
  );
}

function GoalSheet({ goal, onClose }: { goal: Goal | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState(goal?.title ?? '');
  const [amount, setAmount] = useState(centsToInput(goal?.targetAmountCents));
  const [link, setLink] = useState(goal?.link ?? '');
  const [priority, setPriority] = useState(String(goal?.priority ?? 0));
  const [notes, setNotes] = useState(goal?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const cents = parseEuroInput(amount);
    if (!title.trim()) return setError('Название обязательно');
    if (cents === null || Number.isNaN(cents) || cents < 0) return setError('Укажи примерную стоимость в евро, например 450 или 99,90');
    setBusy(true);
    setError(null);
    try {
      const body = { title: title.trim(), targetAmountCents: cents, priority: Number(priority), link: link.trim() || null, notes: notes.trim() || null };
      if (goal) await api(`/api/rewards/goals/${goal.id}`, { method: 'PATCH', body });
      else await api('/api/rewards/goals', { body });
      toast.ok(goal ? 'Желание обновлено' : 'Желание добавлено');
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title={goal ? 'Изменить желание' : 'Новое желание'}
      footer={
        <Button variant="primary" block loading={busy} onClick={save}>
          Сохранить
        </Button>
      }
    >
      <div className="space-y-3">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Что хочется" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Например, игровая приставка" />
        <Input label="Примерная стоимость, €" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="450" />
        <Input label="Ссылка (необязательно)" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
        <Select label="Приоритет" value={priority} onChange={(e) => setPriority(e.target.value)}>
          {[0, 1, 2, 3, 4, 5].map((p) => (
            <option key={p} value={p}>
              {p === 0 ? 'Без приоритета' : `${p}${p === 5 ? ' — самое желанное' : ''}`}
            </option>
          ))}
        </Select>
        <Textarea label="Комментарий" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} className="min-h-16" />
      </div>
    </Sheet>
  );
}

function SettingsSheet({ settings, onClose }: { settings: RewardsSummary['settings']; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [budget, setBudget] = useState(centsToInput(settings.monthlyBudgetCents));
  const [perWorkout, setPerWorkout] = useState(centsToInput(settings.perWorkoutCents));
  const [maxWorkouts, setMaxWorkouts] = useState(String(settings.maxWorkoutsPerWeek));
  const [breakfast, setBreakfast] = useState(centsToInput(settings.breakfastBonusCents));
  const [minDays, setMinDays] = useState(String(settings.breakfastMinDays));
  const [review, setReview] = useState(centsToInput(settings.weeklyReviewCents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const vals = { budget: parseEuroInput(budget), perWorkout: parseEuroInput(perWorkout) ?? 0, breakfast: parseEuroInput(breakfast) ?? 0, review: parseEuroInput(review) ?? 0 };
    if (Object.values(vals).some((v) => v !== null && (Number.isNaN(v) || v < 0))) return setError('Суммы — в евро, например 20 или 2,50');
    setBusy(true);
    setError(null);
    try {
      await api('/api/rewards/settings', {
        method: 'PATCH',
        body: {
          monthlyBudgetCents: vals.budget,
          perWorkoutCents: vals.perWorkout,
          maxWorkoutsPerWeek: Number(maxWorkouts),
          breakfastBonusCents: vals.breakfast,
          breakfastMinDays: Number(minDays),
          weeklyReviewCents: vals.review,
        },
      });
      toast.ok('Правила наград сохранены');
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title="Правила наград"
      description="Твой бюджет и условия. Сумма за месяц никогда не превысит бюджет."
      footer={
        <Button variant="primary" block loading={busy} onClick={save}>
          Сохранить
        </Button>
      }
    >
      <div className="space-y-3">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Месячный бюджет, €" hint="Пусто — бюджет не задан, денежных начислений не будет" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="например, 40" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="За тренировку, €" inputMode="decimal" value={perWorkout} onChange={(e) => setPerWorkout(e.target.value)} />
          <Select label="Учитывать до" value={maxWorkouts} onChange={(e) => setMaxWorkouts(e.target.value)}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n} в неделю
              </option>
            ))}
          </Select>
          <Input label="За завтраки, €" inputMode="decimal" value={breakfast} onChange={(e) => setBreakfast(e.target.value)} />
          <Select label="Если завтраков от" value={minDays} onChange={(e) => setMinDays(e.target.value)}>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n} дн.
              </option>
            ))}
          </Select>
        </div>
        <Input label="За обзор недели, €" inputMode="decimal" value={review} onChange={(e) => setReview(e.target.value)} />
        <p className="text-xs text-muted">Начисления предлагаются при обзоре недели; ты подтверждаешь их, сам переводишь деньги и отмечаешь «отложено». За пропуски ничего не списывается.</p>
      </div>
    </Sheet>
  );
}

function FundSheet({ entry, goals, busy, onClose, onFund }: { entry: Entry; goals: Goal[]; busy: boolean; onClose: () => void; onFund: (goalId: string | null) => void }) {
  const [goalId, setGoalId] = useState(goals[0]?.id ?? '');
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Отложено ${formatEuro(entry.amountCents)}`}
      description="Отметь, когда сам перевёл деньги на свой счёт или в копилку."
      footer={
        <Button variant="primary" block loading={busy} onClick={() => onFund(goalId || null)}>
          Отметить «отложено»
        </Button>
      }
    >
      <div className="space-y-3">
        <Select label="На какое желание" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
          <option value="">Без цели (общий фонд)</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">Приложение ничего не переводит — это только отметка в твоём журнале.</p>
      </div>
    </Sheet>
  );
}

function AdjustSheet({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (amountCents: number, note: string, key: string) => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`));
  function submit() {
    const cents = parseEuroInput(amount);
    if (cents === null || Number.isNaN(cents) || cents === 0) return setError('Сумма в евро, со знаком минус для уменьшения: например −5 или 3,50');
    if (!note.trim()) return setError('Укажи причину корректировки');
    setError(null);
    onSubmit(cents, note.trim(), key);
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title="Корректировка"
      description="Исправить ошибочное начисление отдельной записью — история не переписывается."
      footer={
        <Button variant="primary" block loading={busy} onClick={submit}>
          Записать
        </Button>
      }
    >
      <div className="space-y-3">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Сумма, €" hint="Отрицательная — уменьшает начисленное" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace('−', '-'))} placeholder="-5" />
        <Input label="Причина" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Например, тренировка отмечена по ошибке" />
      </div>
    </Sheet>
  );
}
