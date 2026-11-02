'use client';
import { Camera, Check, ImageUp, ScanSearch, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { MealProposal, MediaProposal, StepsProposal, WeightProposal } from '@/domain/media/evaluate';
import { addDays, formatDateRu } from '@/domain/time';
import { CONSUMPTION_LABELS, MEAL_SLOT_LABELS, type ConsumptionStatus, type MealSlot } from '@/domain/types';
import type { MealTarget, MediaPurpose } from '@/server/services/media';
import { api, ApiError, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chips, Input, Select } from '@/components/ui/Field';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';

const PURPOSES: { value: MediaPurpose; label: string; hint: string }[] = [
  { value: 'weight_photo', label: 'Вес', hint: 'Фото дисплея весов' },
  { value: 'steps_screenshot', label: 'Шаги', hint: 'Скриншот Apple Health / приложения шагов за день' },
  { value: 'meal_photo', label: 'Еда', hint: 'Фото тарелки — отметишь, сколько съел' },
  { value: 'progress_photo', label: 'Фото прогресса', hint: 'Только с отдельным согласием, без ИИ-анализа' },
  { value: 'receipt', label: 'Чек', hint: 'Хранится приватно, распознавание пока не выполняется' },
  { value: 'other', label: 'Другое', hint: 'Хранится приватно, распознавание не выполняется' },
];

interface UploadedMedia {
  id: string;
  kind: MediaPurpose;
  retentionUntil: string | null;
}
interface SignedFile {
  url: string;
  expiresAt: string;
}
type Phase = 'pick' | 'uploading' | 'stored' | 'done';

export interface PhotoCaptureProps {
  ai: { available: boolean; reason: 'not_configured' | 'no_consent' | null };
  bodyPhotosOptIn: boolean;
  mealOptions: MealTarget[];
  suggestedMeal: MealTarget;
  retention: { mealDays: number; screenshotDays: number };
  maxMb: number;
  initialPurpose: MediaPurpose | null;
}

const AI_REASON: Record<string, string> = {
  not_configured: 'Распознавание фото не подключено на сервере — введи значение вручную.',
  no_consent: 'Отправка фото в ИИ выключена в настройках приватности — введи значение вручную или включи согласие.',
};

export function PhotoCapture(props: PhotoCaptureProps) {
  const router = useRouter();
  const toast = useToast();
  const { today } = useClientUser();
  const [purpose, setPurpose] = useState<MediaPurpose | null>(props.initialPurpose);
  const [file, setFile] = useState<File | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('pick');
  const [media, setMedia] = useState<UploadedMedia | null>(null);
  const [signed, setSigned] = useState<SignedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneText, setDoneText] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const objectUrl = useRef<string | null>(null);

  function setPreviewFile(f: File | null) {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = f ? URL.createObjectURL(f) : null;
    setFile(f);
    setLocalUrl(objectUrl.current);
  }

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const purposeInfo = PURPOSES.find((p) => p.value === purpose) ?? null;
  const blockedBody = purpose === 'progress_photo' && !props.bodyPhotosOptIn;

  function reset() {
    setPreviewFile(null);
    setMedia(null);
    setSigned(null);
    setError(null);
    setDoneText(null);
    setPhase('pick');
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
  }

  function onPick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (f.size > props.maxMb * 1024 * 1024) {
      setError(`Файл больше ${props.maxMb} МБ — выбери фото поменьше.`);
      return;
    }
    setPreviewFile(f);
  }

  async function upload() {
    if (!file || !purpose) return;
    setPhase('uploading');
    setError(null);
    try {
      const fd = new FormData();
      fd.append('purpose', purpose);
      fd.append('file', file);
      const r = await api<{ media: UploadedMedia; file: SignedFile }>('/api/media/upload', { body: fd });
      setMedia(r.media);
      setSigned(r.file);
      setPhase('stored');
    } catch (e) {
      setError(errorMessage(e));
      setPhase('pick');
    }
  }

  async function refreshSigned() {
    if (!media) return;
    try {
      const r = await api<{ file: SignedFile | null }>(`/api/media/${media.id}`);
      if (r.file) setSigned(r.file);
    } catch {
      /* the preview is optional */
    }
  }

  async function remove() {
    if (!media) {
      reset();
      return;
    }
    try {
      await api(`/api/media/${media.id}`, { method: 'DELETE' });
      toast.ok('Фото удалено');
      reset();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function finished(text: string) {
    setDoneText(text);
    setPhase('done');
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <Link href="/health" className="text-sm text-accent">
          ← Здоровье
        </Link>
        <h1 className="text-2xl font-semibold">Фото и скриншоты</h1>
        <p className="text-sm text-muted">Сначала выбери, что на фото. Ничего не сохранится в дневник без твоего подтверждения.</p>
      </header>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {phase === 'done' ? (
        <Card className="space-y-3 p-4">
          <p className="flex items-center gap-2 font-medium text-ok">
            <Check className="size-5" /> {doneText}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={reset}>
              Ещё фото
            </Button>
            <Link href="/health" className="inline-flex min-h-11 items-center rounded-xl border border-border px-4 text-[15px] font-medium hover:bg-surface-2">
              К здоровью
            </Link>
          </div>
        </Card>
      ) : null}

      {phase === 'pick' || phase === 'uploading' ? (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Что на фото?</h2>
            <Chips ariaLabel="Назначение фото" options={PURPOSES.map((p) => ({ value: p.value, label: p.label }))} value={purpose ? [purpose] : []} onChange={(v) => setPurpose(v[0] ?? null)} />
            {purposeInfo ? <p className="text-xs text-muted">{purposeInfo.hint}</p> : null}
            {blockedBody ? (
              <Notice tone="warn">
                Фото тела сохраняются только с отдельным согласием.{' '}
                <Link href="/settings#privacy" className="font-medium underline">
                  Настройки → Приватность
                </Link>
                .
              </Notice>
            ) : null}
          </section>

          <Card className="space-y-3 p-4">
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => onPick(e.target.files?.[0])} />
            <input ref={galleryRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => onPick(e.target.files?.[0])} />
            {localUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- local blob preview, never leaves the device before upload
              <img src={localUrl} alt="Предпросмотр выбранного фото" className="max-h-80 w-full rounded-xl bg-surface-2 object-contain" />
            ) : (
              <div className="grid h-40 place-items-center rounded-xl border border-dashed border-border text-sm text-muted">Фото пока не выбрано</div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!purpose || blockedBody} onClick={() => cameraRef.current?.click()} icon={<Camera className="size-4" />}>
                Снять
              </Button>
              <Button variant="secondary" disabled={!purpose || blockedBody} onClick={() => galleryRef.current?.click()} icon={<ImageUp className="size-4" />}>
                Из галереи
              </Button>
              <Button variant="primary" className="ml-auto" disabled={!file || !purpose || blockedBody} loading={phase === 'uploading'} onClick={() => void upload()}>
                Отправить
              </Button>
            </div>
            <p className="flex items-start gap-2 text-xs text-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" /> Фото хранится приватно, геоданные и EXIF удаляются. До {props.maxMb} МБ. Удалить можно в любой момент.
            </p>
          </Card>
        </>
      ) : null}

      {phase === 'stored' && media ? (
        <>
          <Card className="space-y-3 p-4">
            {signed ? (
              // eslint-disable-next-line @next/next/no-img-element -- private signed URL (session + 5-minute signature), not for the image optimizer
              <img src={signed.url} alt="Загруженное фото" onError={() => void refreshSigned()} className="max-h-80 w-full rounded-xl bg-surface-2 object-contain" />
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge tone="accent">{PURPOSES.find((p) => p.value === media.kind)?.label ?? 'Фото'}</Badge>
              <Button variant="ghost" className="text-danger" onClick={() => void remove()} icon={<Trash2 className="size-4" />}>
                Удалить фото
              </Button>
            </div>
          </Card>

          {media.kind === 'weight_photo' || media.kind === 'steps_screenshot' ? (
            <MeasurementPanel mediaId={media.id} metric={media.kind === 'weight_photo' ? 'weight' : 'steps'} ai={props.ai} today={today} onDone={finished} onError={setError} />
          ) : media.kind === 'meal_photo' ? (
            <MealPanel mediaId={media.id} ai={props.ai} options={props.mealOptions} suggested={props.suggestedMeal} onDone={finished} onError={setError} />
          ) : (
            <Card className="p-4 text-sm">
              {media.kind === 'progress_photo' ? (
                <p>Сохранено приватно как фото прогресса. ИИ-анализ для фото тела не выполняется, в отчёты фото не попадает.</p>
              ) : (
                <p>Сохранено приватно на {Math.max(1, props.retention.screenshotDays)} дн. Распознавание для такого фото пока не выполняется.</p>
              )}
              <Button variant="primary" className="mt-3" onClick={() => finished('Фото сохранено')}>
                Готово
              </Button>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
function AnalyzeBlock({ ai, busy, onAnalyze, done }: { ai: PhotoCaptureProps['ai']; busy: boolean; onAnalyze: () => void; done: boolean }) {
  if (!ai.available) return <Notice>{AI_REASON[ai.reason ?? 'not_configured']}</Notice>;
  if (done) return null;
  return (
    <div className="space-y-1">
      <Button variant="soft" loading={busy} onClick={onAnalyze} icon={<ScanSearch className="size-4" />}>
        Распознать (ИИ)
      </Button>
      <p className="text-xs text-muted">Фото уйдёт внешнему сервису распознавания. Можно не отправлять и ввести вручную.</p>
    </div>
  );
}

function MeasurementPanel({
  mediaId,
  metric,
  ai,
  today,
  onDone,
  onError,
}: {
  mediaId: string;
  metric: 'weight' | 'steps';
  ai: PhotoCaptureProps['ai'];
  today: string;
  onDone: (t: string) => void;
  onError: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState<'analyze' | 'save' | null>(null);
  const [proposal, setProposal] = useState<WeightProposal | StepsProposal | null>(null);
  const [interpretationId, setInterpretationId] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [date, setDate] = useState(today);
  const [duplicate, setDuplicate] = useState<string | null>(null);

  async function analyze() {
    setBusy('analyze');
    onError(null);
    try {
      const r = await api<{ interpretationId: string; proposal: MediaProposal }>(`/api/media/${mediaId}/analyze`, { method: 'POST', body: {} });
      if (r.proposal.kind === 'weight' || r.proposal.kind === 'steps') {
        setProposal(r.proposal);
        setInterpretationId(r.interpretationId);
        if (r.proposal.kind === 'weight' && r.proposal.canSave && r.proposal.value !== null) setValue(String(r.proposal.value));
        if (r.proposal.kind === 'steps' && r.proposal.canSaveAsDaily && r.proposal.value !== null) {
          setValue(String(r.proposal.value));
          if (r.proposal.suggestedDate) setDate(r.proposal.suggestedDate);
        }
      }
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function save(replace = false) {
    const n = Number(value.replace(',', '.').replace(/\s/g, ''));
    if (!value.trim() || !Number.isFinite(n)) {
      onError(metric === 'weight' ? 'Введи вес числом, например 53.2' : 'Введи число шагов, например 8500');
      return;
    }
    setBusy('save');
    onError(null);
    try {
      await api(`/api/media/${mediaId}/confirm`, { body: { kind: 'measurement', metricType: metric, value: n, localDate: date, replace, interpretationId } });
      onDone(metric === 'weight' ? `Вес ${n} кг сохранён за ${formatDateRu(date)}` : `${n.toLocaleString('ru-RU')} шагов сохранено за ${formatDateRu(date)}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_FOR_DATE') setDuplicate(e.message);
      else onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const stepsWarn = proposal?.kind === 'steps' && !proposal.canSaveAsDaily;
  return (
    <Card className="space-y-4 p-4">
      <AnalyzeBlock ai={ai} busy={busy === 'analyze'} onAnalyze={() => void analyze()} done={!!proposal} />
      {proposal ? (
        <div className="space-y-1.5 rounded-xl bg-surface-2 p-3 text-sm" aria-live="polite">
          <p className={stepsWarn || (proposal.kind === 'weight' && !proposal.canSave) ? 'text-warn' : ''}>{proposal.message}</p>
          {proposal.hints.map((h) => (
            <p key={h} className="text-muted">
              {h}
            </p>
          ))}
          {proposal.kind === 'steps' && proposal.dateShown ? <p className="text-xs text-muted">На скриншоте: «{proposal.dateShown}»</p> : null}
          <p className="text-xs text-muted">Распознал, проверь — это предположение, не доказательство.</p>
        </div>
      ) : null}

      <div className="space-y-3">
        <p className="text-sm font-medium">{proposal ? 'Проверь и сохрани' : 'Ввести вручную'}</p>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={metric === 'weight' ? 'Вес, кг' : 'Шаги за день'}
            inputMode={metric === 'weight' ? 'decimal' : 'numeric'}
            placeholder={metric === 'weight' ? 'например 53.2' : 'например 8500'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-40"
          />
          <span className="self-center text-sm text-muted">{metric === 'weight' ? 'кг' : 'шагов'}</span>
          <Input type="date" aria-label="За какой день" value={date} max={today} min={addDays(today, -60)} onChange={(e) => setDate(e.target.value || today)} className="w-auto" />
        </div>
        {metric === 'steps' ? <p className="text-xs text-muted">Только дневное значение — не недельную сумму и не среднее.</p> : null}
        {duplicate ? (
          <Notice tone="warn">
            <p>{duplicate}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void save(true)}>
                Заменить
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDuplicate(null)}>
                Оставить старое
              </Button>
            </div>
          </Notice>
        ) : null}
        <Button variant="primary" loading={busy === 'save'} onClick={() => void save(false)}>
          Сохранить
        </Button>
      </div>
    </Card>
  );
}

const SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

function MealPanel({
  mediaId,
  ai,
  options,
  suggested,
  onDone,
  onError,
}: {
  mediaId: string;
  ai: PhotoCaptureProps['ai'];
  options: MealTarget[];
  suggested: MealTarget;
  onDone: (t: string) => void;
  onError: (e: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [proposal, setProposal] = useState<MealProposal | null>(null);
  const [interpretationId, setInterpretationId] = useState<string | null>(null);
  const [target, setTarget] = useState(suggested.eventId ? `ev:${suggested.eventId}` : `slot:${suggested.slot}`);
  const [description, setDescription] = useState('');

  async function analyze() {
    setBusy('analyze');
    onError(null);
    try {
      const r = await api<{ interpretationId: string; proposal: MediaProposal }>(`/api/media/${mediaId}/analyze`, { method: 'POST', body: {} });
      if (r.proposal.kind === 'meal') {
        setProposal(r.proposal);
        setInterpretationId(r.interpretationId);
        if (r.proposal.readable && !description) setDescription(r.proposal.detected.map((d) => d.name).join(', '));
      }
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function answer(status: ConsumptionStatus) {
    setBusy(status);
    onError(null);
    const [k, v] = target.split(':') as ['ev' | 'slot', string];
    try {
      await api(`/api/media/${mediaId}/confirm`, {
        body: { kind: 'meal', consumptionStatus: status, eventId: k === 'ev' ? v : null, slot: k === 'slot' ? v : undefined, description: description.trim() || null, interpretationId },
      });
      const label = k === 'ev' ? (options.find((o) => o.eventId === v)?.label ?? 'Приём пищи') : MEAL_SLOT_LABELS[v as MealSlot];
      onDone(`${label}: ${CONSUMPTION_LABELS[status].toLowerCase()}`);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <AnalyzeBlock ai={ai} busy={busy === 'analyze'} onAnalyze={() => void analyze()} done={!!proposal} />
      {proposal ? (
        <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-sm" aria-live="polite">
          <p className={proposal.readable ? '' : 'text-warn'}>{proposal.message}</p>
          {proposal.detected.length ? (
            <p>
              <span className="font-medium">Обнаружено: </span>
              {proposal.detected.map((d) => `${d.name} (${Math.round(d.confidence * 100)}%)`).join(', ')}
            </p>
          ) : null}
          {proposal.possible.length ? (
            <p>
              <span className="font-medium">Возможно: </span>
              {proposal.possible.join(', ')}
            </p>
          ) : null}
          {proposal.notVisible.length ? (
            <p>
              <span className="font-medium">Не видно: </span>
              {proposal.notVisible.join(', ')}
            </p>
          ) : null}
          {proposal.portionNote ? <p className="text-muted">{proposal.portionNote}</p> : null}
          {proposal.questions.length ? (
            <div>
              <p className="font-medium">Вопросы:</p>
              <ul className="list-disc pl-5">
                {proposal.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-xs text-muted">Без калорий и диагнозов — только то, что видно на фото.</p>
        </div>
      ) : null}

      <div className="space-y-3">
        <Select label="Какой приём пищи" value={target} onChange={(e) => setTarget(e.target.value)}>
          {options.map((o) => (
            <option key={o.eventId} value={`ev:${o.eventId}`}>
              {o.label} (по плану)
            </option>
          ))}
          {SLOTS.map((s) => (
            <option key={s} value={`slot:${s}`}>
              {MEAL_SLOT_LABELS[s]} (без плана)
            </option>
          ))}
        </Select>
        <Input label="Что было (необязательно)" placeholder="например, курица с рисом" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div>
          <p className="mb-2 text-sm font-medium">Сколько съел?</p>
          <div className="grid grid-cols-2 gap-2">
            {(['all', 'part', 'replaced', 'not_eaten'] as ConsumptionStatus[]).map((s) => (
              <Button key={s} variant={s === 'all' ? 'primary' : 'secondary'} loading={busy === s} disabled={!!busy && busy !== s} onClick={() => void answer(s)}>
                {s === 'replaced' ? 'Заменил' : CONSUMPTION_LABELS[s]}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Пока не ответишь, приём пищи не считается съеденным.</p>
        </div>
      </div>
    </Card>
  );
}
