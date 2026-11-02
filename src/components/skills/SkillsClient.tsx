'use client';
import { CheckCircle2, GraduationCap, Plus, Target, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { SkillsOverview } from '@/server/services/skills';
import { levelLabel, maxLevel, MAX_ACTIVE_SKILLS, shortLevel, type SkillPreset } from '@/domain/skills/skills';
import { addDays, formatDateRu, formatDateShortRu } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chips, Input, Select, Textarea } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { Sheet } from '@/components/ui/Sheet';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';

type Skill = SkillsOverview['skills'][number];
const STATUS: Record<string, string> = { active: 'активный', maintenance: 'поддержка', paused: 'пауза', done: 'достигнут' };

function SetupSheet({ preset, onClose }: { preset: SkillPreset | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const custom = !preset;
  const [title, setTitle] = useState(preset?.title ?? '');
  const [scale, setScale] = useState<'cefr' | 'five'>(preset?.scale ?? 'five');
  const area = preset?.area ?? 'other';
  const [current, setCurrent] = useState(1);
  const [target, setTarget] = useState(preset?.targetLevel ?? 3);
  const [weekly, setWeekly] = useState(preset?.weeklyMinutes ?? 60);
  const [session, setSession] = useState(preset?.sessionMinutes ?? 20);
  const [status, setStatus] = useState<'active' | 'maintenance'>('active');
  const [busy, setBusy] = useState(false);
  const levels = Array.from({ length: maxLevel(scale) }, (_, i) => i + 1);

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ note: string | null }>('/api/skills', {
        body: {
          title,
          area,
          why: preset?.why ?? null,
          targetDescription: preset?.targetDescription ?? null,
          levelScale: scale,
          currentLevel: current,
          targetLevel: Math.max(target, current),
          weeklyMinutes: weekly,
          sessionMinutes: session,
          status,
        },
      });
      onClose();
      router.refresh();
      toast.ok(r.note ?? 'Навык добавлен, занятия появятся в плане');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={custom ? 'Свой навык' : preset!.title}
      description={preset?.targetDescription ?? 'Уровень оцени честно по описанию — его потом меняют только контрольные задания.'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={save}>
            Добавить
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {custom ? (
          <>
            <Input label="Навык" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, делегирование" />
            <Segmented ariaLabel="Шкала" value={scale} onChange={setScale} options={[{ value: 'five', label: 'Шкала 1–5' }, { value: 'cefr', label: 'Язык (A1–C2)' }]} />
          </>
        ) : null}
        <Select label="Где ты сейчас" value={current} onChange={(e) => setCurrent(Number(e.target.value))}>
          {levels.map((l) => (
            <option key={l} value={l}>
              {levelLabel(scale, area, l)}
            </option>
          ))}
        </Select>
        <Select label="Цель" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {levels.map((l) => (
            <option key={l} value={l}>
              {levelLabel(scale, area, l)}
            </option>
          ))}
        </Select>
        <div className="space-y-2">
          <p className="text-sm font-medium">Минут в неделю</p>
          <Chips ariaLabel="Минут в неделю" options={[30, 40, 60, 90, 105, 150].map((m) => ({ value: m, label: String(m) }))} value={[weekly]} onChange={(v) => setWeekly(v[0]!)} />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Одно занятие</p>
          <Chips ariaLabel="Длительность занятия" options={[10, 15, 20, 30].map((m) => ({ value: m, label: `${m} мин` }))} value={[session]} onChange={(v) => setSession(v[0]!)} />
        </div>
        <Segmented ariaLabel="Режим" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Активный' }, { value: 'maintenance', label: 'На поддержке' }]} />
        <p className="text-xs text-muted">Занятия встанут в план как недельная норма (вечером, не позже 23:00) и будут переноситься при переработке.</p>
      </div>
    </Sheet>
  );
}

function SkillCard({ s }: { s: Skill }) {
  const { today } = useClientUser();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(s.sessionMinutes);
  const [activity, setActivity] = useState('');
  const [cpTitle, setCpTitle] = useState(s.checkpointIdeas[0] ?? '');
  const [cpDate, setCpDate] = useState(addDays(today, 30));
  const [result, setResult] = useState<{ id: string } | null>(null);
  const [resultLevel, setResultLevel] = useState(s.currentLevel);
  const [notes, setNotes] = useState('');
  const run = async (key: string, fn: () => Promise<{ note?: string | null } | unknown>, ok?: string) => {
    setBusy(key);
    try {
      const r = (await fn()) as { note?: string | null } | undefined;
      router.refresh();
      const msg = r && typeof r === 'object' && 'note' in r && r.note ? r.note : ok;
      if (msg) toast.ok(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const max = maxLevel(s.levelScale);
  const planned = s.checkpoints.filter((c) => c.status === 'planned');
  const done = s.checkpoints.filter((c) => c.status !== 'planned').slice(0, 3);

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{s.title}</h2>
            <Badge tone={s.status === 'active' ? 'accent' : 'neutral'}>{STATUS[s.status]}</Badge>
          </div>
          {s.why ? <p className="text-sm text-muted">{s.why}</p> : null}
        </div>
        <span className="tabular shrink-0 text-sm font-semibold">
          {shortLevel(s.levelScale, s.currentLevel)} → {shortLevel(s.levelScale, s.targetLevel)}
        </span>
      </div>

      <div className="space-y-1.5">
        <div className="flex gap-1" aria-label={`Уровень ${s.currentLevel} из ${max}, цель ${s.targetLevel}`}>
          {Array.from({ length: max }, (_, i) => i + 1).map((l) => (
            <span key={l} className={`h-2 flex-1 rounded-full ${l <= s.currentLevel ? 'bg-accent' : l <= s.targetLevel ? 'bg-accent-soft' : 'bg-surface-2'}`} />
          ))}
        </div>
        <p className="text-sm">
          <span className="text-muted">Сейчас:</span> {s.currentLabel}
        </p>
        <p className="text-sm">
          <span className="text-muted">Цель:</span> {s.targetLabel}
        </p>
        <p className="text-xs text-faint">Уровень меняется только после контрольного задания — не от количества занятий.</p>
      </div>

      <div className="rounded-2xl bg-surface-2 p-3">
        <div className="flex items-center justify-between text-sm">
          <span>Практика на этой неделе</span>
          <span className="tabular font-medium">
            {s.weekMinutes} {s.effectiveWeekly ? `из ${s.effectiveWeekly}` : ''} мин
          </span>
        </div>
        {s.effectiveWeekly ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round((s.weekMinutes / s.effectiveWeekly) * 100))}%` }} />
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chips ariaLabel="Минут" options={[10, 15, 20, 30].map((m) => ({ value: m, label: `${m}′` }))} value={[minutes]} onChange={(v) => setMinutes(v[0]!)} />
        </div>
        <div className="mt-2 flex gap-2">
          <Input aria-label="Что делал" placeholder={s.ideas[0] ? `например: ${s.ideas[0].toLowerCase()}` : 'Что делал (необязательно)'} value={activity} onChange={(e) => setActivity(e.target.value)} />
          <Button variant="primary" loading={busy === 'log'} onClick={() => run('log', () => api(`/api/skills/${s.id}/practice`, { body: { minutes, activity: activity || null } }).then(() => setActivity('')), 'Практика записана')}>
            Записать
          </Button>
        </div>
        {s.ideas.length ? <p className="mt-2 text-xs text-muted">Идеи: {s.ideas.join(' · ')}</p> : null}
      </div>

      <div className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Target className="size-4" /> Контрольные задания
        </h3>
        {planned.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate">{c.title}</p>
              {c.dueDate ? <p className="text-xs text-muted">до {formatDateRu(c.dueDate)}</p> : null}
            </div>
            <Button size="sm" onClick={() => setResult({ id: c.id })}>
              Итог
            </Button>
          </div>
        ))}
        {!planned.length ? (
          <div className="flex flex-wrap items-end gap-2">
            <Input aria-label="Задание" value={cpTitle} onChange={(e) => setCpTitle(e.target.value)} placeholder="Например: 5 минут разговора без подсказок" />
            <Input type="date" aria-label="К какому числу" value={cpDate} onChange={(e) => setCpDate(e.target.value)} className="w-auto" />
            <Button loading={busy === 'cp'} disabled={!cpTitle.trim()} onClick={() => run('cp', () => api(`/api/skills/${s.id}/checkpoints`, { body: { title: cpTitle, dueDate: cpDate || null } }), 'Контрольное задание назначено')}>
              Назначить
            </Button>
          </div>
        ) : null}
        {done.map((c) => (
          <p key={c.id} className="flex items-center gap-1.5 text-xs text-muted">
            <CheckCircle2 className={`size-3.5 ${c.status === 'passed' ? 'text-ok' : ''}`} />
            {c.title} — {c.status === 'passed' ? `сдано${c.resultLevel ? `, ${shortLevel(s.levelScale, c.resultLevel)}` : ''}` : 'пока нет'}
          </p>
        ))}
      </div>

      {s.recent.length ? (
        <details>
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-accent">История практики</summary>
          <ul className="divide-y divide-border text-sm">
            {s.recent.map((l) => (
              <li key={l.id} className="flex items-center gap-2 py-2">
                <span className="tabular w-16 text-muted">{formatDateShortRu(l.localDate)}</span>
                <span className="flex-1 truncate">
                  {l.minutes} мин{l.activity ? ` · ${l.activity}` : ''}
                </span>
                <button type="button" aria-label="Удалить запись" className="grid size-9 place-items-center rounded-lg text-faint hover:bg-surface-2" onClick={() => run('del', () => api(`/api/skills/practice/${l.id}`, { method: 'DELETE' }))}>
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Segmented
          ariaLabel="Режим навыка"
          value={s.status === 'done' ? 'paused' : s.status}
          onChange={(v) => run('status', () => api(`/api/skills/${s.id}`, { method: 'PATCH', body: { status: v } }), 'Режим обновлён, план перестроен')}
          options={[
            { value: 'active', label: 'Активный' },
            { value: 'maintenance', label: 'Поддержка' },
            { value: 'paused', label: 'Пауза' },
          ]}
        />
        <Button variant="ghost" size="sm" className="ml-auto" loading={busy === 'delete'} onClick={() => run('delete', () => api(`/api/skills/${s.id}`, { method: 'DELETE' }), 'Навык удалён')}>
          Удалить
        </Button>
      </div>

      {result ? (
        <Sheet
          open
          onClose={() => setResult(null)}
          title="Итог контрольного задания"
          description="Оцени честно по описанию уровня. Это единственный способ изменить уровень."
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" loading={busy === 'notyet'} onClick={() => run('notyet', () => api(`/api/skills/checkpoints/${result.id}/complete`, { body: { passed: false, notes: notes || null } }).then(() => setResult(null)), 'Записал: пока не получилось — это тоже прогресс')}>
                Пока не получилось
              </Button>
              <Button variant="primary" loading={busy === 'passed'} onClick={() => run('passed', () => api(`/api/skills/checkpoints/${result.id}/complete`, { body: { passed: true, resultLevel, notes: notes || null } }).then(() => setResult(null)), 'Сдано!')}>
                Сдал
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <Select label="Какой уровень показало задание" value={resultLevel} onChange={(e) => setResultLevel(Number(e.target.value))}>
              {Array.from({ length: max }, (_, i) => i + 1).map((l) => (
                <option key={l} value={l}>
                  {levelLabel(s.levelScale, s.area, l)}
                </option>
              ))}
            </Select>
            <Textarea label="Что получилось и что мешало" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </Sheet>
      ) : null}
    </Card>
  );
}

export function SkillsClient({ data }: { data: SkillsOverview }) {
  const [setup, setSetup] = useState<SkillPreset | null | 'custom'>(null);
  const usedTitles = new Set(data.skills.map((s) => s.title));
  const presets = data.presets.filter((p) => !usedTitles.has(p.title));
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Навыки</h1>
        <p className="text-sm text-muted">
          Не больше {MAX_ACTIVE_SKILLS} активных одновременно, остальные — на поддержке. Короткие занятия по 10–20 минут встают в план и переносятся при переработках.
        </p>
      </header>

      {data.skills.length ? data.skills.map((s) => <SkillCard key={s.id} s={s} />) : (
        <Card>
          <EmptyState icon={<GraduationCap className="size-6" />} title="Выбери 1–2 направления на месяц">
            Потом можно поменять акценты. Уровень растёт только после контрольных заданий.
          </EmptyState>
        </Card>
      )}

      <section className="space-y-2">
        <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Добавить</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {presets.map((p) => (
            <button key={p.key} type="button" onClick={() => setSetup(p)} className="rounded-2xl border border-border bg-surface p-4 text-left hover:bg-surface-2">
              <p className="font-medium">{p.title}</p>
              <p className="mt-0.5 text-sm text-muted">{p.why}</p>
              <p className="mt-1 text-xs text-faint">
                {p.weeklyMinutes} мин в неделю · по {p.sessionMinutes} мин
              </p>
            </button>
          ))}
          <button type="button" onClick={() => setSetup('custom')} className="flex items-center gap-2 rounded-2xl border border-dashed border-border p-4 text-left text-muted hover:bg-surface-2">
            <Plus className="size-4" /> Свой навык
          </button>
        </div>
      </section>
      {data.activeCount >= MAX_ACTIVE_SKILLS ? <Notice>Сейчас уже {MAX_ACTIVE_SKILLS} активных — новый навык встанет на поддержку.</Notice> : null}
      {setup ? <SetupSheet preset={setup === 'custom' ? null : setup} onClose={() => setSetup(null)} /> : null}
    </div>
  );
}
