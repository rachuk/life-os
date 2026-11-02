'use client';
import { Check, Copy, ExternalLink, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { formatDateRu, localDateOf } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Spinner';
import { ErrorState, Notice, Skeleton } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';

interface Integration {
  key: string;
  enabled: boolean;
  configured: boolean;
  detail: string;
}
interface MeResponse {
  channels: { telegram: { username: string | null; connectedAt: string; notificationsEnabled: boolean } | null };
  integrations: Integration[];
}
interface LinkStart {
  deepLink: string;
  command: string;
  botUsername: string;
  expiresAt: string;
}

const POLL_MS = 3000;

/**
 * Settings block «Telegram» (PRD §12.1, §19.1): status, one-time pairing link (10 min), notification
 * toggle and disconnect. Honest "не подключено" state when the server has no bot token (NT-07).
 */
export function TelegramConnect() {
  const toast = useToast();
  const { tz } = useClientUser();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkStart | null>(null);
  const [busy, setBusy] = useState<'link' | 'toggle' | 'unlink' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await api<MeResponse>('/api/me');
      setMe(r);
      setLoadError(null);
      return r;
    } catch (e) {
      setLoadError(errorMessage(e));
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api<MeResponse>('/api/me')
      .then((r) => alive && setMe(r))
      .catch((e) => alive && setLoadError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, []);

  const tg = me?.channels.telegram ?? null;
  const expired = !!link && new Date(link.expiresAt).getTime() <= nowMs;

  // while a link is open, wait for the /start in Telegram
  useEffect(() => {
    if (!link || tg) return;
    const t = setInterval(async () => {
      setNowMs(Date.now());
      if (new Date(link.expiresAt).getTime() <= Date.now()) return;
      const r = await load();
      if (r?.channels.telegram) {
        setLink(null);
        toast.ok('Telegram подключён');
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [link, tg, load, toast]);

  async function startLink() {
    setBusy('link');
    setError(null);
    try {
      setLink(await api<LinkStart>('/api/telegram/connect/start', { method: 'POST', body: {} }));
      setNowMs(Date.now());
      setCopied(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(enabled: boolean) {
    setBusy('toggle');
    setError(null);
    try {
      await api('/api/telegram/notifications', { body: { enabled } });
      await load();
      toast.ok(enabled ? 'Уведомления в Telegram включены' : 'Уведомления в Telegram выключены');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function unlink() {
    setBusy('unlink');
    setError(null);
    try {
      await api('/api/telegram/disconnect', { method: 'POST', body: {} });
      setConfirmUnlink(false);
      await load();
      toast.ok('Telegram отвязан');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast.error('Не удалось скопировать — выдели команду вручную');
    }
  }

  if (!me && !loadError) return <Skeleton className="h-28 w-full" />;
  if (!me) {
    return (
      <ErrorState
        title="Не удалось загрузить статус Telegram"
        action={
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        }
      >
        {loadError}
      </ErrorState>
    );
  }

  const integration = me.integrations.find((i) => i.key === 'telegram');

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-semibold">
            <Send className="size-4 text-accent" /> Telegram
          </p>
          <p className="mt-0.5 text-sm text-muted">Напоминания с кнопками, быстрые записи текстом, голосом и фото.</p>
        </div>
        {tg ? <Badge tone="ok" className="shrink-0">подключён</Badge> : integration?.enabled && integration.configured ? <Badge className="shrink-0">не подключён</Badge> : <Badge className="shrink-0">не настроен</Badge>}
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {!integration?.enabled ? (
        <Notice>Telegram выключен на сервере. Напоминания приходят внутри приложения.</Notice>
      ) : !integration.configured ? (
        <Notice>
          <p className="font-medium">Telegram не настроен на сервере</p>
          <p className="mt-1">Напоминания продолжают приходить внутри приложения. Подключить чат можно будет, когда бот появится на сервере.</p>
        </Notice>
      ) : tg ? (
        <div className="space-y-2">
          <p className="text-sm">
            {tg.username ? <span className="font-medium">@{tg.username}</span> : 'Чат подключён'}
            <span className="text-muted"> · с {formatDateRu(localDateOf(tg.connectedAt, tz))}</span>
          </p>
          <Switch
            checked={tg.notificationsEnabled}
            disabled={busy === 'toggle'}
            onChange={(v) => void toggle(v)}
            label="Напоминания в Telegram"
            description="Команды /today, /now, /work работают и без уведомлений"
          />
          {confirmUnlink ? (
            <div className="rounded-xl bg-surface-2 p-3 text-sm">
              <p>Отвязать чат? Бот перестанет видеть твой план, пока не подключишь снова.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="danger" loading={busy === 'unlink'} onClick={() => void unlink()}>
                  Да, отвязать
                </Button>
                <Button variant="ghost" onClick={() => setConfirmUnlink(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" className="text-danger" onClick={() => setConfirmUnlink(true)}>
              Отвязать Telegram
            </Button>
          )}
          <p className="text-xs text-muted">У ботов Telegram нет сквозного шифрования — не отправляй туда пароли и рабочие секреты.</p>
        </div>
      ) : link && !expired ? (
        <div className="space-y-3">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Открой бота и нажми «Start»:
              <div className="mt-2">
                <a
                  href={link.deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-[15px] font-medium text-accent-fg hover:bg-accent-hover"
                >
                  <ExternalLink className="size-4" /> Открыть @{link.botUsername}
                </a>
              </div>
            </li>
            <li>
              Или отправь боту команду:
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2.5 text-sm">{link.command}</code>
                <Button variant="secondary" onClick={() => void copy(link.command)} aria-label="Скопировать команду" icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </Button>
              </div>
            </li>
          </ol>
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-4" /> Жду подтверждения из Telegram… Ссылка одноразовая и действует до{' '}
            {new Date(link.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })}.
          </p>
          <Button variant="ghost" onClick={() => setLink(null)}>
            Отмена
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {expired ? <Notice tone="warn">Ссылка устарела — создай новую.</Notice> : null}
          <Button variant="primary" loading={busy === 'link'} onClick={() => void startLink()} icon={<Send className="size-4" />}>
            Подключить Telegram
          </Button>
          <p className="text-xs text-muted">Создам одноразовую ссылку на 10 минут. Бот отвечает только привязанному чату.</p>
        </div>
      )}
    </Card>
  );
}
