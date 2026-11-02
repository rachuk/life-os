'use client';
import { Camera, Check, Mic, Square } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ACTION_LABELS, type ProposedAction } from '@/domain/capture/schema';
import { formatDateRu } from '@/domain/time';
import { MEAL_SLOT_LABELS } from '@/domain/types';
import { api, ApiError, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { openExtraWork } from '@/components/shell/events';

interface Proposal {
  index: number;
  action: ProposedAction;
  status: string;
  result?: { message: string } | null;
}
interface InboxItem {
  id: string;
  parser: string | null;
  proposalsJson: Proposal[];
  error: string | null;
  processingStatus: string;
}

function titleOf(a: ProposedAction): string {
  switch (a.type) {
    case 'note':
      return a.text;
    case 'log_weight':
      return `${a.value} кг`;
    case 'log_steps':
      return `${a.value} шагов`;
    case 'log_meal':
      return `${MEAL_SLOT_LABELS[a.slot]}${a.description ? `: ${a.description}` : ''}`;
    case 'extra_work':
      return `+${a.durationMinutes} мин`;
    default:
      return a.title;
  }
}

function ProposalEditor({ p, selected, onToggle, onChange }: { p: Proposal; selected: boolean; onToggle: () => void; onChange: (a: ProposedAction) => void }) {
  const a = p.action;
  const set = (patch: Partial<ProposedAction>) => onChange({ ...a, ...patch } as ProposedAction);
  return (
    <li className="rounded-2xl border border-border p-3">
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Выполнить: ${titleOf(a)}`} className="mt-3 size-5 shrink-0 accent-[var(--accent)]" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{ACTION_LABELS[a.type]}</Badge>
            {a.needsConfirmation ? <Badge tone="warn">проверь</Badge> : null}
          </div>
          {'title' in a ? (
            <Input aria-label="Название" value={a.title} onChange={(e) => set({ title: e.target.value } as Partial<ProposedAction>)} />
          ) : a.type === 'note' ? (
            <Input aria-label="Текст" value={a.text} onChange={(e) => set({ text: e.target.value } as Partial<ProposedAction>)} />
          ) : (
            <p className="text-[15px] font-medium">{titleOf(a)}</p>
          )}
          {(a.type === 'create_task' || a.type === 'schedule_workout') && a.dateLocal ? (
            <p className="text-sm font-medium text-accent">
              {formatDateRu(a.dateLocal)}
              {a.timeLocal ? `, ${a.timeLocal}` : ''}
            </p>
          ) : null}
          {a.type === 'create_task' || a.type === 'schedule_workout' ? (
            <div className="flex flex-wrap gap-2">
              <Input type="date" aria-label="Дата" value={a.dateLocal ?? ''} onChange={(e) => set({ dateLocal: e.target.value || null } as Partial<ProposedAction>)} className="w-auto" />
              <Input type="time" aria-label="Время" value={a.timeLocal ?? ''} onChange={(e) => set({ timeLocal: e.target.value || null } as Partial<ProposedAction>)} className="w-auto" />
            </div>
          ) : null}
          {a.type === 'create_waiting' ? (
            <Input type="date" aria-label="Проверить ответ" value={a.followUpDate ?? ''} onChange={(e) => set({ followUpDate: e.target.value || null } as Partial<ProposedAction>)} className="w-auto" />
          ) : null}
          {a.type === 'add_shopping_item' ? (
            <div className="flex gap-2">
              <Input
                aria-label="Количество"
                inputMode="decimal"
                placeholder="Кол-во"
                value={a.quantity ?? ''}
                onChange={(e) => set({ quantity: e.target.value ? Number(e.target.value.replace(',', '.')) : null } as Partial<ProposedAction>)}
                className="w-24"
              />
              <Input aria-label="Единица" placeholder="ед." value={a.unit ?? ''} onChange={(e) => set({ unit: e.target.value || null } as Partial<ProposedAction>)} className="w-20" />
              <select
                aria-label="Корзина"
                value={a.listType}
                onChange={(e) => set({ listType: e.target.value as 'personal' } as Partial<ProposedAction>)}
                className="min-h-11 rounded-xl border border-border bg-surface px-2 text-sm"
              >
                <option value="personal">Личная</option>
                <option value="household">Общая домашняя</option>
              </select>
            </div>
          ) : null}
          {a.type === 'log_weight' || a.type === 'log_steps' ? (
            <div className="flex flex-wrap gap-2">
              <Input aria-label="Значение" inputMode="decimal" value={String(a.value)} onChange={(e) => set({ value: Number(e.target.value.replace(',', '.')) || 0 } as Partial<ProposedAction>)} className="w-28" />
              <Input type="date" aria-label="Дата" value={a.dateLocal ?? ''} onChange={(e) => set({ dateLocal: e.target.value || null } as Partial<ProposedAction>)} className="w-auto" />
            </div>
          ) : null}
          {'dateLocal' in a && a.dateLocal && a.type !== 'create_task' && a.type !== 'schedule_workout' && a.type !== 'log_weight' && a.type !== 'log_steps' ? (
            <p className="text-sm text-muted">{formatDateRu(a.dateLocal)}</p>
          ) : null}
          {a.reason ? <p className="text-sm text-warn">{a.reason}</p> : null}
        </div>
      </div>
    </li>
  );
}

export function QuickCapture({ open, onClose, itemId }: { open: boolean; onClose: () => void; itemId?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState('');
  const [item, setItem] = useState<InboxItem | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [edits, setEdits] = useState<Record<string, ProposedAction>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [askReplace, setAskReplace] = useState<string | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [idem] = useState(() => crypto.randomUUID());
  const idemKey = useRef<string>(idem);

  useEffect(() => {
    if (!itemId) return;
    api<{ items: InboxItem[] }>('/api/inbox')
      .then((r) => {
        const found = r.items.find((i) => i.id === itemId);
        if (found) {
          setItem(found);
          setSelected(found.proposalsJson.map((p) => p.index));
        }
      })
      .catch((e) => setError(errorMessage(e)));
  }, [itemId]);

  async function parse() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ item: InboxItem; note: string | null; autoApplied: boolean }>('/api/inbox', { body: { text, idempotencyKey: idemKey.current } });
      if (res.autoApplied) {
        toast.ok('Сохранено');
        router.refresh();
        onClose();
        return;
      }
      setItem(res.item);
      setNote(res.note ?? res.item.error);
      setSelected(res.item.proposalsJson.map((p) => p.index));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(replaceMeasurements = false) {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ applied: Proposal[]; deferred: Proposal[]; alreadyProcessed: boolean }>(`/api/inbox/${item.id}/confirm`, {
        body: { selected, edits, replaceMeasurements },
      });
      router.refresh();
      onClose();
      const n = res.applied.length;
      const parts = res.applied.slice(0, 3).map((p) => {
        const a = p.action;
        if (a.type === 'create_task') return `дело${a.dateLocal ? ` на ${formatDateRu(a.dateLocal)}` : ''}`;
        if (a.type === 'add_shopping_item') return `${a.title} → покупки`;
        if (a.type === 'schedule_workout') return `тренировка${a.dateLocal ? ` ${formatDateRu(a.dateLocal)}` : ''}`;
        if (a.type === 'idea') return 'идея';
        if (a.type === 'log_weight') return `вес ${String(a.value).replace('.', ',')} кг`;
        if (a.type === 'log_steps') return 'шаги';
        return ACTION_LABELS[a.type].toLowerCase();
      });
      toast.ok(
        res.alreadyProcessed
          ? 'Уже было сохранено'
          : n
            ? `Сохранено: ${parts.join(' · ')}${n > 3 ? ` и ещё ${n - 3}` : ''}`
            : 'Ничего не выбрано',
      );
      const xw = res.deferred.find((d) => d.action.type === 'extra_work');
      if (xw && xw.action.type === 'extra_work') setTimeout(() => openExtraWork(xw.action.type === 'extra_work' ? xw.action.durationMinutes : undefined), 300);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_FOR_DATE') setAskReplace(e.message);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (item) await api(`/api/inbox/${item.id}/reject`, { method: 'POST', body: {} }).catch(() => {});
    onClose();
  }

  async function toggleRecording() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Запись голоса недоступна в этом браузере. Можно продиктовать с клавиатуры iPhone (значок микрофона).');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' });
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append('file', blob, rec.mimeType.includes('mp4') ? 'voice.m4a' : 'voice.webm');
          const r = await api<{ text: string }>('/api/voice/transcribe', { body: fd });
          setText((t) => (t ? `${t}\n${r.text}` : r.text));
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setTranscribing(false);
        }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setError('Нет доступа к микрофону. Разреши доступ в настройках браузера.');
    }
  }

  const proposals = item?.proposalsJson ?? [];

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (item && item.processingStatus === 'proposed') toast.info('Сохранил во входящие — подтвердить можно позже в «Делах»');
        onClose();
      }}
      title={item ? 'Проверь и подтверди' : 'Быстрый ввод'}
      description={item ? 'Ничего не сохранится, пока ты не подтвердишь.' : 'Дела, покупки, идеи, вес, шаги — одним сообщением.'}
      footer={
        item ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={reject}>
              Отклонить
            </Button>
            <Button variant="secondary" onClick={() => setItem(null)}>
              Изменить текст
            </Button>
            <Button variant="primary" loading={busy} disabled={!selected.length} onClick={() => confirm(false)} icon={<Check className="size-4" />}>
              {selected.length === proposals.length ? 'Создать всё' : `Создать выбранное (${selected.length})`}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant={recording ? 'danger' : 'secondary'} onClick={toggleRecording} loading={transcribing} aria-label={recording ? 'Остановить запись' : 'Записать голос'} icon={recording ? <Square className="size-4" /> : <Mic className="size-4" />}>
              {recording ? 'Стоп' : 'Голос'}
            </Button>
            <Link href="/health/photo" onClick={onClose} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-[15px] font-medium hover:bg-surface-2">
              <Camera className="size-4" /> Фото
            </Link>
            <Button variant="primary" className="ml-auto" loading={busy} disabled={!text.trim()} onClick={parse}>
              Разобрать
            </Button>
          </div>
        )
      }
    >
      {error ? (
        <Notice tone="danger" className="mb-3">
          {error}
        </Notice>
      ) : null}
      {askReplace ? (
        <Notice tone="warn" className="mb-3">
          <p>{askReplace}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => confirm(true)}>
              Заменить значение
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAskReplace(null)}>
              Оставить старое
            </Button>
          </div>
        </Notice>
      ) : null}
      {!item ? (
        <div className="space-y-2">
          <Textarea
            data-autofocus
            aria-label="Текст"
            placeholder={'Например: завтра написать брокеру, купить бананы и молоко, в четверг в зал в 21'}
            value={text}
            rows={5}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) parse();
            }}
          />
          {recording ? <p className="text-sm text-danger">● Идёт запись…</p> : null}
          <p className="hidden text-xs text-muted [@media(hover:hover)]:block">⌘/Ctrl + Enter — разобрать.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {note ? <Notice tone="neutral">{note}</Notice> : null}
          <p className="text-xs text-muted">Разбор: {item.parser === 'rules' ? 'встроенные правила (без ИИ)' : `ИИ (${item.parser}) — распознал, проверь`}</p>
          <ul className="space-y-2">
            {proposals.map((p) => (
              <ProposalEditor
                key={p.index}
                p={{ ...p, action: edits[String(p.index)] ?? p.action }}
                selected={selected.includes(p.index)}
                onToggle={() => setSelected((s) => (s.includes(p.index) ? s.filter((i) => i !== p.index) : [...s, p.index]))}
                onChange={(a) => setEdits((e) => ({ ...e, [String(p.index)]: a }))}
              />
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}
