'use client';
import { ChevronDown, Download, FileSpreadsheet, LogOut, Moon, Sun, SunMoon, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { IntegrationStatus } from '@/server/env';
import type { NotificationPrefs } from '@/domain/planner/prefs';
import { formatTime, formatDateShortRu, localDateOf } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Switch } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';
import { InstallHint } from '@/components/more/MoreClient';

interface Privacy {
  bodyPhotosOptIn: boolean;
  aiImagesConsent: boolean;
  aiVoiceConsent: boolean;
  aiTextConsent: boolean;
  storeVoiceAudio: boolean;
  mealPhotoRetentionDays: number;
  screenshotRetentionDays: number;
  autoApplyLowRisk: boolean;
}

interface Diag {
  id: string;
  channel: string;
  reminderType: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  cancelReason: string | null;
  title: string;
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

const SECTIONS = [
  { id: 'routine', label: 'Распорядок' },
  { id: 'notifications', label: 'Уведомления' },
  { id: 'privacy', label: 'Приватность' },
  { id: 'data', label: 'Данные' },
  { id: 'about', label: 'О приложении' },
] as const;

const CHANNEL_RU: Record<string, string> = { in_app: 'в приложении', telegram: 'Telegram', web_push: 'push' };

const STATUS_RU: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: 'запланировано', tone: 'neutral' },
  sent: { label: 'отправлено', tone: 'neutral' },
  delivered_unknown: { label: 'передано push-сервису', tone: 'neutral' },
  failed: { label: 'не удалось отправить', tone: 'danger' },
  acknowledged: { label: 'отвечено', tone: 'ok' },
  cancelled: { label: 'отменено', tone: 'neutral' },
  skipped: { label: 'пропущено', tone: 'neutral' },
};

const REASON_RU: Record<string, { label: string; tone: Tone }> = {
  answered_or_removed: { label: 'уже отмечено', tone: 'ok' },
  plan_changed: { label: 'план изменился', tone: 'neutral' },
  stale: { label: 'пропущено: устарело', tone: 'neutral' },
  quiet_hours: { label: 'тихие часы', tone: 'neutral' },
  daily_limit: { label: 'дневной лимит', tone: 'neutral' },
  telegram_disconnected: { label: 'Telegram отключён', tone: 'neutral' },
  no_push_subscription: { label: 'нет подписки на push', tone: 'neutral' },
};

/** A scheduled reminder this much past its time was not sent (worker down or backlog). */
const OVERDUE_MS = 5 * 60_000;

/** Human state of one outbox row — never raw codes like `answered:complete`. */
function deliveryState(d: Diag, nowMs: number): { label: string; tone: Tone } {
  if (d.status === 'scheduled') {
    return new Date(d.scheduledAt).getTime() < nowMs - OVERDUE_MS ? { label: 'не отправлено', tone: 'warn' } : STATUS_RU.scheduled!;
  }
  if ((d.status === 'cancelled' || d.status === 'skipped') && d.cancelReason) {
    if (d.cancelReason.startsWith('answered:')) return { label: 'отвечено в приложении', tone: 'ok' };
    const r = REASON_RU[d.cancelReason];
    if (r) return r;
  }
  return STATUS_RU[d.status] ?? { label: 'неизвестно', tone: 'neutral' };
}

function errorHint(d: Diag): string | null {
  if (!d.lastError) return null;
  if (/not configured/i.test(d.lastError)) return 'канал не настроен на сервере';
  if (/^push/i.test(d.lastError)) return 'push-сервис не принял';
  return 'ошибка отправки';
}

function readTheme(): 'system' | 'light' | 'dark' {
  try {
    const t = localStorage.getItem('lifeos-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}
const themeListeners = new Set<() => void>();
function subscribeTheme(cb: () => void) {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'system' as const);
  const apply = (t: 'system' | 'light' | 'dark') => {
    try {
      if (t === 'system') localStorage.removeItem('lifeos-theme');
      else localStorage.setItem('lifeos-theme', t);
    } catch {
      /* storage unavailable */
    }
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    themeListeners.forEach((l) => l());
  };
  return (
    <Segmented
      ariaLabel="Тема"
      value={theme}
      onChange={apply}
      options={[
        { value: 'system', label: <span className="inline-flex items-center gap-1"><SunMoon className="size-4" />Авто</span> },
        { value: 'light', label: <span className="inline-flex items-center gap-1"><Sun className="size-4" />Светлая</span> },
        { value: 'dark', label: <span className="inline-flex items-center gap-1"><Moon className="size-4" />Тёмная</span> },
      ]}
    />
  );
}

function SettingsSection({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-2 lg:scroll-mt-8">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 id={`${id}-title`} className="text-[13px] font-semibold uppercase tracking-wide text-muted">
          {title}
        </h2>
        {note ? <span className="text-xs text-muted">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** Compares only what the notifications form edits, so key order from the server never fakes «unsaved». */
function notificationsSig(n: NotificationPrefs, quiet: { start: string; end: string } | null): string {
  return JSON.stringify([
    n.channels.telegram,
    n.channels.web_push,
    n.snackReminders,
    n.sleepReminder,
    n.repeatMinutes,
    n.maxRepeats,
    n.maxPerDay,
    n.workoutLeadMinutes,
    quiet?.start ?? null,
    quiet?.end ?? null,
  ]);
}

export function SettingsClient({
  email,
  privacy: initialPrivacy,
  notifications,
  quietHours,
  tz,
  nowIso,
  diagnostics,
  integrations,
  channels,
}: {
  email: string;
  privacy: Privacy;
  notifications: NotificationPrefs;
  quietHours: { start: string; end: string } | null;
  tz: string;
  nowIso: string;
  diagnostics: Diag[];
  integrations: IntegrationStatus[];
  channels: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [privacy, setPrivacy] = useState(initialPrivacy);
  const [n, setN] = useState(notifications);
  const [quiet, setQuiet] = useState(quietHours);
  const [savingN, setSavingN] = useState(false);
  const [logShown, setLogShown] = useState(false);

  const dirty = notificationsSig(n, quiet) !== notificationsSig(notifications, quietHours);
  const integration = (key: string) => integrations.find((i) => i.key === key);
  const ready = (key: string) => {
    const i = integration(key);
    return !!i && i.enabled && i.configured;
  };
  const aiConfigured = (key: string) => integration(key)?.configured ?? false;
  const tgReady = ready('telegram');
  const pushReady = ready('web_push');
  const nowMs = new Date(nowIso).getTime();

  async function patchPrivacy(patch: Partial<Privacy>) {
    const prev = privacy;
    setPrivacy({ ...privacy, ...patch });
    try {
      const r = await api<{ privacy: Privacy }>('/api/me/privacy', { method: 'PATCH', body: patch });
      setPrivacy(r.privacy);
    } catch (e) {
      setPrivacy(prev);
      toast.error(errorMessage(e));
    }
  }

  async function saveNotifications() {
    setSavingN(true);
    try {
      await api('/api/me/notifications', { method: 'PATCH', body: { notifications: n, quietHours: quiet } });
      toast.ok('Уведомления сохранены, напоминания пересчитаны');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingN(false);
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="space-y-7">
      <header className="space-y-3">
        <div>
          <h1 className="text-2xl font-semibold">Настройки</h1>
          <p className="text-sm text-muted">{email}</p>
        </div>
        <nav aria-label="Разделы настроек" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0">
          <ul className="flex w-max gap-1.5">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="group flex min-h-11 items-center">
                  <span className="rounded-full border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text group-hover:bg-surface-2">{s.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <SettingsSection id="routine" title="Распорядок">
        <Card className="space-y-3 p-4">
          <p className="max-w-prose text-sm text-muted">Рабочий график, утро, сон, еда, тренировки, свои проекты и пробные привычки. После сохранения будущие нетронутые блоки перестроятся.</p>
          <Link href="/onboarding" className="inline-flex min-h-11 items-center rounded-xl bg-accent-soft px-4 text-[15px] font-medium text-accent">
            Изменить распорядок
          </Link>
        </Card>
      </SettingsSection>

      <SettingsSection id="notifications" title="Уведомления">
        <Card className="space-y-4 p-4">
          <p className="max-w-prose text-sm text-muted">
            В приложении (колокольчик) напоминания приходят всегда. Telegram и push — дополнительно, когда подключены; если подключены оба, push идёт только при неактивном Telegram.
          </p>

          <div>
            <h3 className="text-sm font-semibold">Каналы</h3>
            <div className="divide-y divide-border">
              <div className={cn(!tgReady && 'opacity-60')}>
                <Switch
                  label="Telegram"
                  description={tgReady ? undefined : 'Telegram не настроен на сервере'}
                  disabled={!tgReady}
                  checked={tgReady && n.channels.telegram}
                  onChange={(v) => setN({ ...n, channels: { ...n.channels, telegram: v } })}
                />
              </div>
              <div className={cn(!pushReady && 'opacity-60')}>
                <Switch
                  label="Push в браузере / на iPhone"
                  description={pushReady ? undefined : 'Push не настроен на сервере'}
                  disabled={!pushReady}
                  checked={pushReady && n.channels.web_push}
                  onChange={(v) => setN({ ...n, channels: { ...n.channels, web_push: v } })}
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">Что напоминать</h3>
            <div className="divide-y divide-border">
              <Switch label="Перекусы" checked={n.snackReminders} onChange={(v) => setN({ ...n, snackReminders: v })} />
              <Switch label="«Скоро отбой»" checked={n.sleepReminder} onChange={(v) => setN({ ...n, sleepReminder: v })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input type="number" label="Повтор важного через, мин" min={5} max={60} value={n.repeatMinutes} onChange={(e) => setN({ ...n, repeatMinutes: Number(e.target.value) || 15 })} />
            <Input type="number" label="Повторов" hint="0 или 1" min={0} max={1} value={n.maxRepeats} onChange={(e) => setN({ ...n, maxRepeats: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} />
            <Input type="number" label="Не больше сообщений в день" min={1} max={50} value={n.maxPerDay} onChange={(e) => setN({ ...n, maxPerDay: Number(e.target.value) || 14 })} />
            <Input type="number" label="Тренировка: напомнить за, мин" min={0} max={120} value={n.workoutLeadMinutes} onChange={(e) => setN({ ...n, workoutLeadMinutes: Number(e.target.value) || 0 })} />
          </div>
          <Switch label="Часы тишины" description={quiet ? `${quiet.start}–${quiet.end}` : 'выключены'} checked={!!quiet} onChange={(v) => setQuiet(v ? { start: '00:30', end: '07:30' } : null)} />
          {quiet ? (
            <div className="grid grid-cols-2 gap-3">
              <Input type="time" label="С" value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} />
              <Input type="time" label="До" value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-4">
            <Button variant="primary" loading={savingN} disabled={!dirty} onClick={saveNotifications}>
              Сохранить уведомления
            </Button>
            <p className={cn('text-sm', dirty ? 'text-warn' : 'text-muted')} aria-live="polite">
              {dirty ? 'Есть несохранённые изменения' : 'Изменения в этом блоке сохраняются кнопкой'}
            </p>
          </div>
        </Card>

        {channels}

        <Card className="p-1.5">
          <button
            type="button"
            onClick={() => setLogShown((v) => !v)}
            aria-expanded={logShown}
            aria-controls="delivery-log"
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 text-left hover:bg-surface-2"
          >
            <span>
              <span className="block text-[15px] font-medium">Журнал доставки</span>
              <span className="block text-xs text-muted">Последние напоминания и что с ними стало</span>
            </span>
            <ChevronDown className={cn('size-4 shrink-0 text-muted transition-transform', logShown && 'rotate-180')} />
          </button>
          {logShown ? (
            diagnostics.length ? (
              <ul id="delivery-log" className="divide-y divide-border border-t border-border text-sm">
                {diagnostics.map((d) => {
                  const st = deliveryState(d, nowMs);
                  const err = d.status === 'failed' || d.status === 'scheduled' ? errorHint(d) : null;
                  return (
                    <li key={d.id} className="px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 truncate">{d.title || 'Напоминание'}</p>
                        <Badge tone={st.tone} className="shrink-0 whitespace-nowrap">
                          {st.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted">
                        {CHANNEL_RU[d.channel] ?? 'канал'} · {formatDateShortRu(localDateOf(d.scheduledAt, tz))} {formatTime(d.scheduledAt, tz)}
                        {d.reminderType === 'repeat' ? ' · повтор' : ''}
                        {err ? ` · ${err}` : ''}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p id="delivery-log" className="border-t border-border px-3 py-3 text-sm text-muted">
                Пока нет запланированных напоминаний.
              </p>
            )
          ) : null}
        </Card>
        <p className="max-w-prose px-1 text-xs text-muted">Для пробуждения используй будильник iPhone — Telegram и push не гарантируют громкий сигнал.</p>
      </SettingsSection>

      <SettingsSection id="privacy" title="Приватность и ИИ" note="сохраняется сразу">
        <Card className="divide-y divide-border px-4">
          <Switch
            label="Разбирать текст с помощью ИИ"
            description={aiConfigured('ai_intent') ? 'текст сообщений уходит выбранному провайдеру ИИ' : 'ИИ не подключён — работает встроенный разбор по правилам'}
            checked={privacy.aiTextConsent}
            onChange={(v) => patchPrivacy({ aiTextConsent: v })}
          />
          <Switch
            label="Распознавать голос"
            description={aiConfigured('ai_voice') ? 'аудио уходит сервису распознавания' : 'распознавание не подключено'}
            checked={privacy.aiVoiceConsent}
            onChange={(v) => patchPrivacy({ aiVoiceConsent: v })}
          />
          <Switch label="Хранить исходные голосовые" description="по умолчанию удаляются после распознавания" checked={privacy.storeVoiceAudio} onChange={(v) => patchPrivacy({ storeVoiceAudio: v })} />
          <Switch
            label="Анализировать фото весов, шагов и еды"
            description={aiConfigured('ai_images') ? 'фото уходят модели распознавания; результат — только предложение' : 'распознавание фото не подключено — ввод вручную'}
            checked={privacy.aiImagesConsent}
            onChange={(v) => patchPrivacy({ aiImagesConsent: v })}
          />
          <Switch label="Разрешить фото прогресса (тела)" description="только по желанию, не анализируются ИИ, можно удалить в любой момент" checked={privacy.bodyPhotosOptIn} onChange={(v) => patchPrivacy({ bodyPhotosOptIn: v })} />
          <Switch label="Сохранять покупки и идеи без подтверждения" description="только низкорисковые однозначные записи" checked={privacy.autoApplyLowRisk} onChange={(v) => patchPrivacy({ autoApplyLowRisk: v })} />
          <div className="grid grid-cols-2 gap-3 py-3">
            <Input
              type="number"
              label="Хранить фото еды, дней"
              min={1}
              max={365}
              value={privacy.mealPhotoRetentionDays}
              onChange={(e) => setPrivacy({ ...privacy, mealPhotoRetentionDays: Number(e.target.value) || 30 })}
              onBlur={() => patchPrivacy({ mealPhotoRetentionDays: privacy.mealPhotoRetentionDays })}
            />
            <Input
              type="number"
              label="Хранить скриншоты, дней"
              hint="0 — удалить после подтверждения"
              min={0}
              max={365}
              value={privacy.screenshotRetentionDays}
              onChange={(e) => setPrivacy({ ...privacy, screenshotRetentionDays: Number(e.target.value) || 0 })}
              onBlur={() => patchPrivacy({ screenshotRetentionDays: privacy.screenshotRetentionDays })}
            />
          </div>
        </Card>
      </SettingsSection>

      <SettingsSection id="data" title="Мои данные">
        <DataRights />
      </SettingsSection>

      <SettingsSection id="about" title="О приложении">
        <Card className="space-y-2 p-4">
          <p className="text-sm font-medium">Тема</p>
          <ThemeSwitch />
        </Card>
        <InstallHint />
        <Card className="divide-y divide-border">
          <p className="px-4 pb-1 pt-3 text-sm font-medium">Подключения сервера</p>
          {integrations.map((i) => (
            <div key={i.key} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[15px]">{i.label}</p>
                <p className="text-xs text-muted">{i.detail}</p>
              </div>
              <Badge tone={i.configured && i.enabled ? 'ok' : 'neutral'} className="shrink-0">
                {!i.enabled ? 'выключено' : i.configured ? 'подключено' : 'не настроено'}
              </Badge>
            </div>
          ))}
        </Card>
        {integrations.every((i) => !i.configured) ? (
          <Notice>Внешние сервисы не подключены. Всё работает и сохраняется: напоминания приходят в приложении, записи разбираются по правилам.</Notice>
        ) : null}
        <Button variant="ghost" icon={<LogOut className="size-4" />} onClick={logout}>
          Выйти
        </Button>
      </SettingsSection>
    </div>
  );
}

const CONFIRM = 'УДАЛИТЬ';

function DataRights() {
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/me/data', { method: 'DELETE', body: { confirm: text.trim() } });
      toast.ok('Все данные удалены');
      router.replace('/login');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Card className="p-4">
        <p className="max-w-prose text-sm text-muted">Копия только твоих записей. Фото и голос попадают в экспорт как описания, сами файлы скачиваются по одному.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <a href="/api/export" download className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-medium hover:bg-surface-2">
            <Download className="size-4" /> Экспорт JSON
          </a>
          <a
            href="/api/export?format=csv&table=health_measurements"
            download
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-[15px] font-medium hover:bg-surface-2"
          >
            <FileSpreadsheet className="size-4" /> Измерения CSV
          </a>
        </div>
      </Card>
      <Card className="space-y-3 p-4">
        <div>
          <p className="text-[15px] font-medium">Удалить аккаунт и все данные</p>
          <p className="mt-0.5 max-w-prose text-sm text-muted">Необратимо. Сначала скачай экспорт.</p>
        </div>
        <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setOpen(true)}>
          Удалить все мои данные
        </Button>
      </Card>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Удалить все данные?"
        description="Это необратимо."
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button variant="danger" className="flex-1" disabled={text.trim() !== CONFIRM} loading={busy} onClick={remove}>
              Удалить навсегда
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <p>Будут удалены аккаунт, план, дела, привычки, измерения, питание, тренировки, обзоры, награды, подключение Telegram и все приватные файлы (фото, скриншоты, голос).</p>
          <p className="text-muted">
            Из рабочей базы и хранилища данные удаляются сразу. Резервные копии сервера не переписываются: удалённое исчезнет из них, когда истечёт срок хранения бэкапов.
          </p>
          <Input label={`Чтобы подтвердить, введи ${CONFIRM}`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="characters" />
        </div>
      </Sheet>
    </>
  );
}
