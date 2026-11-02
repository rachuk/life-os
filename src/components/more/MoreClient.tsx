'use client';
import { LogOut, Share } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toaster';

type InstallState = 'unknown' | 'installed' | 'browser';

function readInstallState(): InstallState {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone ? 'installed' : 'browser';
}
const noopSubscribe = () => () => {};

/** «Установить на iPhone» — only in a browser tab; nothing on the server or inside the installed PWA. */
export function InstallHint() {
  const state = useSyncExternalStore<InstallState>(noopSubscribe, readInstallState, () => 'unknown');
  if (state !== 'browser') return null;
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-muted">
          <Share className="size-5" />
        </div>
        <div className="min-w-0 text-sm">
          <p className="text-[15px] font-medium">Установить на iPhone</p>
          <p className="mt-0.5 max-w-prose text-muted">
            Открой Life OS в Safari → «Поделиться» → «На экран „Домой“». Приложение откроется без адресной строки, а push на iPhone работают только так (iOS 16.4+).
          </p>
        </div>
      </div>
    </Card>
  );
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();
  async function logout() {
    setBusy(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
      router.replace('/login');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Button variant="ghost" block loading={busy} onClick={logout} icon={<LogOut className="size-4" />}>
      Выйти
    </Button>
  );
}
