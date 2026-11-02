'use client';
import { CalendarClock, ChevronLeft, ChevronRight, RefreshCw, ScrollText, ShoppingBasket, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { WeekFacts, WeeklyReviewView } from '@/server/services/weeklyReview';
import { formatDateRu, formatDuration } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';
import { formatEuro, LEDGER_STATUS } from '@/components/rewards/format';

type Review = NonNullable<WeeklyReviewView['review']>;
type ProposalView = Review['proposals'][number];

const dayMonth = (d: string) => formatDateRu(d).split(', ')[1] ?? d;
const NO_DATA = 'нет данных';

/** Two columns from 1024px so lines stay readable; a single stacked column on phones. */
function Columns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="space-y-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0">
      <div className="min-w-0 space-y-5">{left}</div>
      <div className="min-w-0 space-y-5">{right}</div>
    </div>
  );
}

export function WeeklyReviewClient({ view, extra }: { view: WeeklyReviewView; extra?: ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy('generate');
    setError(null);
    try {
      await api('/api/reviews/weekly/generate', { body: { weekStart: view.weekStart } });
      toast.ok(view.review ? 'Факты обновлены, решения сохранены' : 'Обзор недели готов');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const firstReview = formatDateRu(view.firstReviewDate).toLowerCase();
  const beforeAccount = view.weekStart < view.firstWeek;
  const firstWeekRunning = view.weekStart === view.firstWeek && view.today < view.firstReviewDate;

  const aside = (
    <>
      <WeekRewards view={view} />
      <Link href="/shopping" className="flex min-h-14 items-center gap-3 rounded-2xl border border-border bg-surface px-4 hover:bg-surface-2">
        <ShoppingBasket className="size-5 text-muted" />
        <span className="flex-1">
          <span className="block text-[15px] font-medium">Покупки и меню на новую неделю</span>
          <span className="block text-xs text-muted">Воскресный список продуктов</span>
        </span>
        <ChevronRight className="size-4 text-muted" />
      </Link>
    </>
  );

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-2">
        {view.prevWeek ? (
          <Link href={`/review/week?week=${view.prevWeek}`} aria-label="Предыдущая неделя" className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface-2">
            <ChevronLeft className="size-5" />
          </Link>
        ) : (
          <span className="size-11" aria-hidden="true" />
        )}
        <div className="min-w-0 text-center">
          <h1 className="text-2xl font-semibold leading-tight">Обзор недели</h1>
          <p className="tabular text-sm text-muted">
            {dayMonth(view.weekStart)} – {dayMonth(view.weekEnd)}
            {view.isCurrentWeek ? ' · текущая' : ''}
          </p>
        </div>
        {view.nextWeek ? (
          <Link href={`/review/week?week=${view.nextWeek}`} aria-label="Следующая неделя" className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface-2">
            <ChevronRight className="size-5" />
          </Link>
        ) : (
          <span className="size-11" aria-hidden="true" />
        )}
      </header>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {view.review ? (
        <ReviewBody
          key={`${view.review.generatedAt}:${view.review.status}`}
          view={view}
          review={view.review}
          onRegenerate={generate}
          regenerating={busy === 'generate'}
          extra={extra}
          aside={aside}
        />
      ) : (
        <Columns
          left={
            <>
              <Card>
                {beforeAccount ? (
                  <EmptyState
                    title={`Первый обзор — ${firstReview}`}
                    icon={<CalendarClock className="size-6" />}
                    action={
                      <Link href={`/review/week?week=${view.firstWeek}`} className="inline-flex min-h-11 items-center rounded-xl px-4 text-[15px] font-medium text-accent hover:bg-surface-2">
                        К первой неделе
                      </Link>
                    }
                  >
                    На этой неделе Life OS ещё не вёл твой план — обозревать нечего.
                  </EmptyState>
                ) : firstWeekRunning ? (
                  <EmptyState title={`Первый обзор — ${firstReview}`} icon={<CalendarClock className="size-6" />}>
                    В воскресенье посчитаем, что было запланировано и что отмечено, и предложим 2–3 правки. Ничего не применится без твоего решения.
                  </EmptyState>
                ) : (
                  <EmptyState
                    title="Обзор этой недели ещё не собран"
                    icon={<ScrollText className="size-6" />}
                    action={
                      <Button variant="primary" size="lg" loading={busy === 'generate'} onClick={generate}>
                        Собрать обзор
                      </Button>
                    }
                  >
                    Посчитаем, что было запланировано и что отмечено, найдём 2–3 закономерности и предложим 2–3 правки. Ничего не применится без твоего решения.
                    <span className="mt-2 block text-xs">{view.ai.reason}</span>
                  </EmptyState>
                )}
              </Card>
              {extra}
            </>
          }
          right={aside}
        />
      )}
    </div>
  );
}

function ReviewBody({
  view,
  review,
  onRegenerate,
  regenerating,
  extra,
  aside,
}: {
  view: WeeklyReviewView;
  review: Review;
  onRegenerate: () => void;
  regenerating: boolean;
  extra?: ReactNode;
  aside: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const f = review.facts;
  const [choice, setChoice] = useState<Record<string, 'accept' | 'reject'>>({});
  const [note, setNote] = useState(review.note ?? '');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = review.proposals.filter((p) => !p.decision);
  const accepted = open.filter((p) => choice[p.id] === 'accept');
  const decided = review.status === 'decided';

  async function decide(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const r = await api<{ applied: { proposalId: string }[]; regenerated: { removed: number; created: number } | null }>('/api/reviews/weekly/decide', {
        body: { weekStart: view.weekStart, note: note.trim() || null, ...body },
      });
      setConfirmOpen(false);
      toast.ok(r.applied.length ? `Применено изменений: ${r.applied.length}${r.regenerated ? ' — будущие события перестроены' : ''}` : 'Решения сохранены');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setConfirmOpen(false);
    } finally {
      setBusy(null);
    }
  }
  const submitChoices = () =>
    decide({ decisions: Object.entries(choice).filter(([id]) => open.some((p) => p.id === id)).map(([proposalId, d]) => ({ proposalId, decision: d })) }, 'apply');

  const left = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-muted">
        <span>
          {decided ? <Badge tone="ok">Обзор завершён</Badge> : <Badge>Ждёт решений</Badge>}{' '}
          собран {new Date(review.generatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
        <Button size="sm" variant="ghost" loading={regenerating} onClick={onRegenerate} icon={<RefreshCw className="size-4" />} className="min-h-11">
          Обновить факты
        </Button>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!f.isComplete ? <Notice>Неделя ещё идёт: прошло {f.daysElapsed} из 7 дней, будущие события помечены как «впереди».</Notice> : null}

      <Card className="p-4">
        <h2 className="font-medium">Итог по фактам</h2>
        <ul className="mt-2 space-y-1.5 text-[15px]">
          {f.summaryLines.map((l) => (
            <li key={l} className="flex gap-2">
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-faint" />
              <span>{l}</span>
            </li>
          ))}
        </ul>
      </Card>

      <FactTiles f={f} />
      <EventsTable f={f} />

      {review.patterns.length ? (
        <section aria-labelledby="patterns" className="space-y-2">
          <h2 id="patterns" className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">
            Что заметно
          </h2>
          <Card className="divide-y divide-border">
            {review.patterns.map((p) => (
              <div key={p.key} className="p-4">
                <p className="text-[15px]">{p.text}</p>
                <p className="mt-1 text-xs text-muted">Основание: {p.basedOn}</p>
              </div>
            ))}
          </Card>
        </section>
      ) : (
        <Notice>Закономерностей пока не видно — для выводов нужно больше отметок. Это нормально для первой недели.</Notice>
      )}

      <AiBlock review={review} reason={view.ai.reason} eligible={view.ai.eligible} />
      {extra}
    </>
  );

  return (
    <>
      <Columns
        left={left}
        right={
          <>
            <section aria-labelledby="proposals" className="space-y-2">
              <h2 id="proposals" className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">
                Предложения на следующую неделю
              </h2>
              {review.proposals.length ? (
                <ul className="space-y-2">
                  {review.proposals.map((p) => (
                    <ProposalCard key={p.id} p={p} choice={choice[p.id]} onChoice={(c) => setChoice((x) => ({ ...x, [p.id]: c }))} />
                  ))}
                </ul>
              ) : (
                <Notice>Предложений нет: по фактам этой недели менять распорядок не нужно.</Notice>
              )}
              <Card className="space-y-3 p-4">
                <Textarea
                  label="Что было новым или приятным?"
                  hint="Необязательно. Впечатления тоже часть недели."
                  value={note}
                  maxLength={1000}
                  onChange={(e) => setNote(e.target.value)}
                  className="min-h-16"
                />
                <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
                  {open.length ? (
                    <Button variant="primary" size="lg" className="sm:flex-1" disabled={!Object.keys(choice).length} onClick={() => (accepted.length ? setConfirmOpen(true) : submitChoices())} loading={busy === 'apply'}>
                      {accepted.length ? `Принять изменения (${accepted.length})` : 'Сохранить решения'}
                    </Button>
                  ) : (
                    <Button variant="primary" size="lg" className="sm:flex-1" loading={busy === 'finish'} onClick={() => decide({}, 'finish')}>
                      {decided ? 'Сохранить заметку' : 'Завершить обзор'}
                    </Button>
                  )}
                  {open.length ? (
                    <Button loading={busy === 'keep'} onClick={() => decide({ keepAsIs: true }, 'keep')}>
                      Оставить как есть
                    </Button>
                  ) : null}
                </div>
                {open.length ? (
                  <p className="text-xs text-muted">«Оставить как есть» ничего не меняет в плане. Принятые изменения касаются только будущих событий, которые ты не трогал.</p>
                ) : null}
              </Card>
            </section>
            {aside}
          </>
        }
      />

      <Sheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Что изменится"
        description="Проверь изменения перед применением"
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Назад
            </Button>
            <Button variant="primary" className="flex-1" loading={busy === 'apply'} onClick={submitChoices}>
              Применить
            </Button>
          </div>
        }
      >
        <ul className="space-y-3">
          {accepted.map((p) => (
            <li key={p.id} className="rounded-xl border border-border p-3">
              <p className="font-medium">{p.title}</p>
              <DiffTable diff={p.diff} />
              <p className="mt-1 text-xs text-muted">{p.affects.note}</p>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}

function ProposalCard({ p, choice, onChoice }: { p: ProposalView; choice: 'accept' | 'reject' | undefined; onChoice: (c: 'accept' | 'reject') => void }) {
  const d = p.decision;
  return (
    <li>
      <Card className={cn('p-4', choice === 'accept' && 'border-accent')}>
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium leading-snug">{p.title}</h3>
          {d ? <Badge tone={d.decision === 'accepted' ? 'ok' : 'neutral'}>{d.decision === 'accepted' ? 'принято' : d.decision === 'rejected' ? 'отклонено' : 'оставлено как есть'}</Badge> : null}
        </div>
        <p className="mt-1 text-sm">
          <span className="text-muted">Почему: </span>
          {p.why}
        </p>
        <DiffTable diff={p.diff} />
        <p className="mt-2 text-sm text-muted">{p.consequences}</p>
        <p className="mt-1 text-xs text-muted">
          {p.affects.note}
          {p.affects.dates.length ? `: ${p.affects.dates.slice(0, 5).map((x) => formatDateRu(x)).join(', ')}${p.affects.dates.length > 5 ? '…' : ''}` : ''}
        </p>
        {!d ? (
          <div className="mt-3 flex gap-2">
            <Button variant={choice === 'accept' ? 'soft' : 'secondary'} aria-pressed={choice === 'accept'} onClick={() => onChoice('accept')} className="flex-1">
              Принять
            </Button>
            <Button variant={choice === 'reject' ? 'soft' : 'ghost'} aria-pressed={choice === 'reject'} onClick={() => onChoice('reject')} className="flex-1">
              Отклонить
            </Button>
          </div>
        ) : null}
      </Card>
    </li>
  );
}

function DiffTable({ diff }: { diff: ProposalView['diff'] }) {
  return (
    <dl className="mt-2 space-y-1 rounded-xl bg-surface-2 p-3 text-sm">
      {diff.map((x) => (
        <div key={x.label} className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-muted">{x.label}:</dt>
          <dd className="tabular">
            <span className="text-muted line-through decoration-faint">{x.from}</span> → <span className="font-medium">{x.to}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const none = value === NO_DATA;
  return (
    <div className="rounded-2xl border border-border bg-surface p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('tabular mt-1 text-lg font-semibold', none && 'text-base font-medium text-muted')}>{value}</div>
      {hint ? <div className="text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

function FactTiles({ f }: { f: WeekFacts }) {
  const w = f.weight;
  const n = f.notifications;
  return (
    <section aria-label="Показатели недели" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
      <Tile
        label="Тренировки"
        value={f.workouts.planned || f.workouts.completed ? `${f.workouts.completed} из ${f.workouts.target}` : NO_DATA}
        hint={f.workouts.unknown ? `без ответа ${f.workouts.unknown}` : f.workouts.skipped ? `пропущено ${f.workouts.skipped}` : `цель ${f.workouts.target}`}
      />
      <Tile
        label="Завтрак"
        value={f.meals.anyData ? `${f.meals.confirmedBreakfastDays} дн.` : NO_DATA}
        hint={f.meals.anyData ? `все приёмы: ${f.meals.daysWithAllMain} дн.` : undefined}
      />
      <Tile
        label="Вес"
        value={w.enough ? `${w.average} кг` : w.count ? 'мало данных' : NO_DATA}
        hint={w.enough ? `среднее, ${w.change! > 0 ? '+' : ''}${w.change} кг за неделю` : w.count ? `${w.count} изм., нужно от 3` : undefined}
      />
      <Tile
        label="Шаги"
        value={f.steps.average !== null ? f.steps.average.toLocaleString('ru-RU') : NO_DATA}
        hint={f.steps.daysWithData ? `среднее за ${f.steps.daysWithData} дн.${f.steps.unknownDays ? `, без данных ${f.steps.unknownDays}` : ''}` : undefined}
      />
      <Tile label="Сон" value={f.sleep.averageMinutes !== null ? formatDuration(f.sleep.averageMinutes) : NO_DATA} hint={f.sleep.daysWithData ? `за ${f.sleep.daysWithData} дн.` : undefined} />
      <Tile label="Энергия" value={f.energy.average !== null ? `${f.energy.average} из 5` : NO_DATA} hint={f.energy.daysWithData ? `за ${f.energy.daysWithData} дн.` : undefined} />
      <Tile
        label="Доп. работа"
        value={f.extraWork.sessions ? formatDuration(f.extraWork.plannedMinutes) : 'не было'}
        hint={f.extraWork.sessions ? `подтверждено ${formatDuration(f.extraWork.actualMinutes)}` : undefined}
      />
      <Tile
        label="Свои проекты"
        value={f.ownProject.completedMinutes ? formatDuration(f.ownProject.completedMinutes) : f.ownProject.plannedMinutes ? '0 мин' : NO_DATA}
        hint={`цель ${formatDuration(f.ownProject.targetMinutes)}`}
      />
      <Tile label="Ответы на напоминания" value={n.rate !== null ? `${Math.round(n.rate * 100)}%` : NO_DATA} hint={n.sent ? `${n.acknowledged} из ${n.sent}` : 'не отправлялись'} />
    </section>
  );
}

function EventsTable({ f }: { f: WeekFacts }) {
  const [open, setOpen] = useState(false);
  const reasons = [...f.reasons.reschedule.map((r) => ({ ...r, t: 'перенос' })), ...f.reasons.skip.map((r) => ({ ...r, t: 'пропуск' }))];
  return (
    <Card className="p-4">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-h-11 w-full items-center justify-between text-left">
        <span className="font-medium">План и факт по типам</span>
        <span className="text-sm text-accent">{open ? 'Скрыть' : 'Показать'}</span>
      </button>
      {open ? (
        <div className="mt-2 space-y-4">
          {f.events.byKind.length ? (
            <div className="-mx-1 overflow-x-auto">
              <table className="tabular w-full min-w-[22rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="px-1 py-1 font-medium">Тип</th>
                    <th className="px-1 py-1 text-right font-medium">План</th>
                    <th className="px-1 py-1 text-right font-medium">Готово</th>
                    <th className="px-1 py-1 text-right font-medium">Пропуск</th>
                    <th className="px-1 py-1 text-right font-medium">Без ответа</th>
                    <th className="px-1 py-1 text-right font-medium">Впереди</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {f.events.byKind.map((k) => (
                    <tr key={k.kind}>
                      <td className="px-1 py-1.5">{k.label}</td>
                      <td className="px-1 py-1.5 text-right">{k.planned}</td>
                      <td className="px-1 py-1.5 text-right">{k.completed}</td>
                      <td className="px-1 py-1.5 text-right">{k.skipped}</td>
                      <td className="px-1 py-1.5 text-right">{k.unknown + k.started + k.needsReschedule}</td>
                      <td className="px-1 py-1.5 text-right">{k.upcoming}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">В плане недели не было событий — нет данных.</p>
          )}
          <div>
            <p className="text-sm font-medium">Причины переносов и пропусков</p>
            {reasons.length ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {reasons.map((r) => (
                  <Badge key={`${r.t}:${r.reason}`}>
                    {r.reason} · {r.t} ×{r.count}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Причины не указывались.</p>
            )}
          </div>
          <p className="text-sm">
            Дела: создано {f.tasks.created}, закрыто {f.tasks.completed}
            {f.tasks.importantCompleted ? ` (важных ${f.tasks.importantCompleted})` : ''}, ждут ответа {f.tasks.waitingNow}, просрочено {f.tasks.overdue}.
          </p>
          <p className="text-sm text-muted">
            Вечерних обзоров: {f.eveningReviews.done}
            {f.eveningReviews.skipped ? `, пропущено ${f.eveningReviews.skipped}` : ''}
            {f.habits.noWorkInBed ? `. Без работы в кровати: ${f.habits.noWorkInBed.kept} из ${f.habits.noWorkInBed.kept + f.habits.noWorkInBed.broken} отмеченных дней` : ''}.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function AiBlock({ review, reason, eligible }: { review: Review; reason: string; eligible: boolean }) {
  const ai = review.aiInsights;
  if (ai?.source === 'ai') {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" />
          <h2 className="font-medium">{ai.label}</h2>
        </div>
        {ai.summary ? <p className="mt-2 text-[15px]">{ai.summary}</p> : null}
        {ai.observations.length ? (
          <ul className="mt-2 space-y-1.5 text-sm">
            {ai.observations.map((o) => (
              <li key={o.text}>
                {o.text} <span className="text-xs text-muted">— {o.basedOn}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {ai.suggestions.length ? (
          <ul className="mt-2 space-y-1.5 text-sm">
            {ai.suggestions.map((s) => (
              <li key={s.text}>
                {s.text} <span className="text-xs text-muted">— {s.why}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3 text-xs text-muted">ИИ видит только агрегированные счётчики и ничего не меняет. Применяются лишь предложения ниже — после твоего решения.</p>
      </Card>
    );
  }
  if (ai?.error) return <Notice>{ai.error}</Notice>;
  return eligible ? null : <p className="px-1 text-xs text-muted">{reason}</p>;
}

function WeekRewards({ view }: { view: WeeklyReviewView }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const r = view.rewards;
  if (!r.enabled) return <Notice>Награды выключены на этом сервере.</Notice>;
  const proposed = r.entries.filter((e) => e.status === 'proposed');
  async function approve() {
    setBusy(true);
    try {
      const res = await api<{ message: string }>('/api/rewards/ledger', { body: { action: 'approve', entryIds: proposed.map((e) => e.id) } });
      toast.ok(res.message);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Награды недели</h2>
        <Link href="/rewards" className="flex min-h-11 items-center text-sm text-accent">
          Фонд желаний
        </Link>
      </div>
      <p className="text-sm text-muted">+{r.xpPoints} XP за подтверждённые действия</p>
      {r.entries.length ? (
        <ul className="mt-2 divide-y divide-border">
          {r.entries.map((e) => (
            <li key={e.id} className="flex min-h-11 items-center justify-between gap-2 py-1.5 text-sm">
              <span className="min-w-0">{e.notes}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="tabular font-medium">{formatEuro(e.amountCents)}</span>
                <Badge tone={LEDGER_STATUS[e.status].tone}>{LEDGER_STATUS[e.status].label}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">
          {r.budgetSet ? 'Денежных начислений за эту неделю нет: условия не выполнены или правила не заданы.' : 'Месячный бюджет наград не задан — денежные начисления не предлагаются.'}
        </p>
      )}
      {proposed.length ? (
        <Button variant="soft" className="mt-3 w-full" loading={busy} onClick={approve}>
          Подтвердить начисления ({formatEuro(proposed.reduce((s, e) => s + e.amountCents, 0))})
        </Button>
      ) : null}
      <p className="mt-2 text-xs text-muted">Это виртуальный учёт твоего бюджета: приложение не переводит деньги.</p>
    </Card>
  );
}
