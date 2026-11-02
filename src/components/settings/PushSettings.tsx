'use client';
import { Bell, BellOff, Send, Share } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorState, Notice, Skeleton } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';

interface PushStatus {
  enabled: boolean;
  configured: boolean;
  publicKey: string | null;
  devices: number;
}

type Support = 'checking' | 'supported' | 'ios_install' | 'insecure' | 'unsupported';

function detectSupport(): Support {
  if (typeof window === 'undefined') return 'checking';
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!window.isSecureContext) return 'insecure';
  // iOS/iPadOS 16.4+: push only for a web app added to the Home Screen and opened from its icon
  if (isIOS && !standalone) return 'ios_install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'supported';
}

const noopSubscribe = () => () => {};

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
}

/**
 * Settings block «Push-уведомления» (PRD §12.1): support detection (incl. the iPhone Home Screen
 * requirement), subscribe / unsubscribe this device, send a test. Push is a convenience channel —
 * delivery is not guaranteed and it never replaces the system alarm.
 */
export function PushSettings() {
  const toast = useToast();
  // browser capabilities don't change while the page is open; 'checking' during SSR/hydration
  const support = useSyncExternalStore<Support>(noopSubscribe, detectSupport, () => 'checking');
  const [server, setServer] = useState<PushStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [busy, setBusy] = useState<'sub' | 'unsub' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDevice = useCallback(async (): Promise<{ permission: NotificationPermission | null; subscribed: boolean | null }> => {
    if (detectSupport() !== 'supported') return { permission: null, subscribed: null };
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      return { permission: Notification.permission, subscribed: !!(await reg?.pushManager.getSubscription()) };
    } catch {
      return { permission: Notification.permission, subscribed: false };
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setServer(await api<PushStatus>('/api/push'));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
    const d = await loadDevice();
    setPermission(d.permission);
    setSubscribed(d.subscribed);
  }, [loadDevice]);

  useEffect(() => {
    let alive = true;
    Promise.all([api<PushStatus>('/api/push'), loadDevice()])
      .then(([srv, d]) => {
        if (!alive) return;
        setServer(srv);
        setPermission(d.permission);
        setSubscribed(d.subscribed);
      })
      .catch((e) => alive && setLoadError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [loadDevice]);

  async function subscribe() {
    if (!server?.publicKey) return;
    setBusy('sub');
    setError(null);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError(perm === 'denied' ? 'Уведомления запрещены в настройках браузера для этого сайта. Разреши их там и попробуй снова.' : 'Разрешение не выдано.');
        return;
      }
      const reg = await registration();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(server.publicKey) }));
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      await api('/api/push/subscribe', { body: { endpoint: json.endpoint, keys: json.keys } });
      setSubscribed(true);
      toast.ok('Push включены на этом устройстве');
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function unsubscribe() {
    setBusy('unsub');
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? null;
      await sub?.unsubscribe().catch(() => false);
      if (endpoint) await api('/api/push/unsubscribe', { body: { endpoint } });
      setSubscribed(false);
      toast.ok('Push выключены на этом устройстве');
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setError(null);
    try {
      const r = await api<{ accepted: number; failed: number; removed: number }>('/api/push/test', { body: {} });
      if (r.accepted) toast.ok(`Отправлено (${r.accepted}). Доставка зависит от устройства и не гарантирована.`);
      else setError(`Push-сервис не принял сообщение${r.removed ? ': подписка устарела и удалена — включи push заново' : ''}.`);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (support === 'checking' || (!server && !loadError)) return <Skeleton className="h-28 w-full" />;
  if (!server) {
    return (
      <ErrorState
        title="Не удалось загрузить статус push"
        action={
          <Button variant="secondary" onClick={() => void refresh()}>
            Повторить
          </Button>
        }
      >
        {loadError}
      </ErrorState>
    );
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-semibold">
            <Bell className="size-4 text-accent" /> Push-уведомления
          </p>
          <p className="mt-0.5 text-sm text-muted">Уведомления от установленного веб-приложения. Если подключён Telegram, напоминания идут туда.</p>
        </div>
        {subscribed ? <Badge tone="ok">включены</Badge> : <Badge>выключены</Badge>}
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {!server.enabled ? (
        <Notice>Push выключены настройкой сервера (ENABLE_WEB_PUSH=false).</Notice>
      ) : !server.configured ? (
        <Notice>
          <p className="font-medium">Не подключено: на сервере не заданы VAPID-ключи</p>
          <p className="mt-1">
            Сгенерируй их командой <code>pnpm vapid</code> и добавь VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY в окружение сервера. Напоминания пока видны внутри приложения.
          </p>
        </Notice>
      ) : support === 'ios_install' ? (
        <Notice tone="accent">
          <p className="flex items-center gap-2 font-medium">
            <Share className="size-4" /> Сначала добавь на экран «Домой»
          </p>
          <p className="mt-1">
            На iPhone push работают только у веб-приложения, добавленного на главный экран (iOS 16.4+): Safari → «Поделиться» → «На экран Домой», затем открой Life OS с иконки и
            вернись сюда.
          </p>
        </Notice>
      ) : support === 'insecure' ? (
        <Notice>Push работают только по HTTPS. Открой приложение по защищённому адресу.</Notice>
      ) : support === 'unsupported' ? (
        <Notice>Этот браузер не поддерживает push-уведомления. Используй Telegram или напоминания внутри приложения.</Notice>
      ) : (
        <div className="space-y-2">
          {permission === 'denied' ? (
            <Notice tone="warn">Уведомления для этого сайта запрещены в настройках браузера — разреши их там, затем включи здесь.</Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {subscribed ? (
              <>
                <Button variant="secondary" loading={busy === 'test'} onClick={() => void test()} icon={<Send className="size-4" />}>
                  Проверить
                </Button>
                <Button variant="ghost" loading={busy === 'unsub'} onClick={() => void unsubscribe()} icon={<BellOff className="size-4" />}>
                  Выключить на этом устройстве
                </Button>
              </>
            ) : (
              <Button variant="primary" loading={busy === 'sub'} disabled={permission === 'denied'} onClick={() => void subscribe()} icon={<Bell className="size-4" />}>
                Включить на этом устройстве
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">
            Подписанных устройств: {server.devices}. Доставка push не гарантируется — для пробуждения используй обычный будильник.
          </p>
        </div>
      )}
    </Card>
  );
}
