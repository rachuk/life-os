'use client';
import { Download, LogOut, Moon, Smartphone, Sun, SunMoon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { IntegrationStatus } from '@/server/env';
import type { NotificationPrefs } from '@/domain/planner/prefs';
import { formatTime, formatDateShortRu, localDateOf } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { Input, Switch } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';

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

const STATUS_RU: Record<string, string> = {
  scheduled: 'запланировано',
  sent: 'отправлено',
  delivered_unknown: 'принято push-сервисом',
  failed: 'ошибка',
  acknowledged: 'отвечено',
  cancelled: 'отменено',
  skipped: 'пропущено',
};
const CHANNEL_RU: Record<string, string> = { in_app: 'в приложении', telegram: 'Telegram', web_push: 'push' };

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
  const setTheme = (_t: 'system' | 'light' | 'dark') => themeListeners.forEach((l) => l());
  const apply = (t: 'system' | 'light' | 'dark') => {
    try {
      if (t === 'system') localStorage.removeItem('lifeos-theme');
      else localStorage.setItem('lifeos-theme', t);
    } catch {
      /* storage unavailable */
    }
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    setTheme(t);
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

export function SettingsClient({
  email,
  privacy: initialPrivacy,
  notifications,
  quietHours,
  tz,
  diagnostics,
  integrations,
  channels,
}: {
  email: string;
  privacy: Privacy;
  notifications: NotificationPrefs;
  quietHours: { start: string; end: string } | null;
  tz: string;
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
  const [confirmDelete, setConfirmDelete] = useState('');
  const [deleting, setDeleting] = useState(false);

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
      toast.ok('Настройки уведомлений сохранены, напоминания пересчитаны');
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

  async function deleteAll() {
    setDeleting(true);
    try {
      await api('/api/me/data', { method: 'DELETE', body: { confirm: confirmDelete } });
      router.replace('/login');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setDeleting(false);
    }
  }

  const aiConfigured = (key: string) => integrations.find((i) => i.key === key)?.configured ?? false;

  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-2xl font-semibold">Настройки</h1>
        <p className="text-sm text-muted">{email}</p>
      </header>

      <Section title="Распорядок">
        <Card className="space-y-3 p-4">
          <p className="text-sm text-muted">Рабочий график, утро, сон, еда, тренировки, свои проекты и пробные привычки. После сохранения будущие нетронутые блоки перестроятся.</p>
          <Link href="/onboarding" className="inline-flex min-h-11 items-center rounded-xl bg-accent-soft px-4 text-[15px] font-medium text-accent">
            Изменить распорядок
          </Link>
        </Card>
      </Section>

      <Section title="Уведомления">
        <Card id="notifications" className="space-y-4 p-4">
          <p className="text-sm text-muted">Внутри приложения напоминания приходят всегда (колокольчик). Telegram и push — когда подключены. Если подключены оба, push используется только при неактивном Telegram, чтобы не дублировать.</p>
          <div className="divide-y divide-border">
            <Switch label="Telegram" checked={n.channels.telegram} onChange={(v) => setN({ ...n, channels: { ...n.channels, telegram: v } })} />
            <Switch label="Push в браузере / PWA" checked={n.channels.web_push} onChange={(v) => setN({ ...n, channels: { ...n.channels, web_push: v } })} />
            <Switch label="Напоминание о перекусах" checked={n.snackReminders} onChange={(v) => setN({ ...n, snackReminders: v })} />
            <Switch label="Напоминание «скоро отбой»" checked={n.sleepReminder} onChange={(v) => setN({ ...n, sleepReminder: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input type="number" label="Повтор важного через, мин" min={5} max={60} value={n.repeatMinutes} onChange={(e) => setN({ ...n, repeatMinutes: Number(e.target.value) || 15 })} />
            <Input type="number" label="Повторов" hint="0 или 1 (не больше одного)" min={0} max={1} value={n.maxRepeats} onChange={(e) => setN({ ...n, maxRepeats: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })} />
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
          <Button variant="primary" loading={savingN} onClick={saveNotifications}>
            Сохранить уведомления
          </Button>
          <p className="text-xs text-muted">Для пробуждения используй будильник iPhone — Telegram и push не гарантируют громкий сигнал.</p>
        </Card>
        {channels}
      </Section>

      <Section title="Приватность и ИИ">
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
      </Section>

      <Section title="Интеграции">
        <Card className="divide-y divide-border">
          {integrations.map((i) => (
            <div key={i.key} className="flex items-start justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-[15px]">{i.label}</p>
                <p className="text-xs text-muted">{i.detail}</p>
              </div>
              <Badge tone={i.configured && i.enabled ? 'ok' : 'neutral'}>{!i.enabled ? 'выключено' : i.configured ? 'подключено' : 'не подключено'}</Badge>
            </div>
          ))}
        </Card>
      </Section>

      <Section title="Установка на iPhone">
        <Card className="space-y-2 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <Smartphone className="size-4" /> Добавь Life OS на экран «Домой»
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>Открой сайт в Safari.</li>
            <li>Нажми «Поделиться» → «На экран „Домой“».</li>
            <li>Запусти Life OS с иконки — после этого можно включить push.</li>
          </ol>
          <p className="text-xs text-faint">Это веб-приложение (PWA), не приложение из App Store.</p>
        </Card>
      </Section>

      <Section title="Внешний вид">
        <Card className="p-4">
          <ThemeSwitch />
        </Card>
      </Section>

      <Section title="Доставка уведомлений">
        <Card className="p-1.5">
          {diagnostics.length ? (
            <ul className="divide-y divide-border text-sm">
              {diagnostics.map((d) => (
                <li key={d.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate">{d.title || d.reminderType}</p>
                    <p className="text-xs text-muted">
                      {CHANNEL_RU[d.channel] ?? d.channel} · {formatDateShortRu(localDateOf(d.scheduledAt, tz))} {formatTime(d.scheduledAt, tz)}
                      {d.reminderType === 'repeat' ? ' · повтор' : ''}
                      {d.lastError ? ` · ${d.lastError}` : ''}
                      {d.cancelReason ? ` · ${d.cancelReason}` : ''}
                    </p>
                  </div>
                  <Badge tone={d.status === 'failed' ? 'danger' : d.status === 'acknowledged' ? 'ok' : 'neutral'}>{STATUS_RU[d.status] ?? d.status}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-sm text-muted">Пока нет запланированных напоминаний.</p>
          )}
        </Card>
      </Section>

      <Section title="Мои данные">
        <Card className="space-y-4 p-4">
          <a href="/api/export" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-[15px] font-medium hover:bg-surface-2">
            <Download className="size-4" /> Скачать все данные (JSON)
          </a>
          <div className="space-y-2 rounded-xl bg-danger-soft p-3">
            <p className="text-sm font-medium text-danger">Удалить аккаунт и все данные</p>
            <p className="text-xs text-danger">Удаляются все записи и приватные файлы. Сначала скачай экспорт. Чтобы подтвердить, введи УДАЛИТЬ.</p>
            <div className="flex gap-2">
              <Input aria-label="Подтверждение удаления" value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder="УДАЛИТЬ" />
              <Button variant="danger" loading={deleting} disabled={confirmDelete !== 'УДАЛИТЬ'} onClick={deleteAll}>
                Удалить
              </Button>
            </div>
          </div>
        </Card>
      </Section>

      <Button variant="ghost" icon={<LogOut className="size-4" />} onClick={logout}>
        Выйти
      </Button>
      {integrations.every((i) => !i.configured) ? <Notice>Сейчас работает ручной режим без внешних ключей: все функции сохраняют данные, ИИ и Telegram просто не используются.</Notice> : null}
    </div>
  );
}
