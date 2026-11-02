'use client';
import { Download, FileSpreadsheet, LogOut, Share, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';

const CONFIRM = 'УДАЛИТЬ';

export function InstallHint() {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2 text-muted">
          <Share className="size-5" />
        </div>
        <div className="min-w-0 text-sm">
          <p className="text-[15px] font-medium">Установить на iPhone</p>
          <p className="mt-0.5 text-muted">
            Открой Life OS в Safari → кнопка «Поделиться» → «На экран „Домой“». Приложение откроется без адресной строки, а push-уведомления на iOS работают
            только так (iOS 16.4+).
          </p>
        </div>
      </div>
    </Card>
  );
}

export function DataRights() {
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
    <Card className="p-4">
      <h2 className="font-medium">Мои данные</h2>
      <p className="mt-0.5 text-sm text-muted">Скачай копию перед удалением. Экспорт содержит только твои записи; фото и голос — как метаданные, файлы скачиваются по одному.</p>
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
      <Button variant="danger" block className="mt-3" icon={<Trash2 className="size-4" />} onClick={() => setOpen(true)}>
        Удалить все мои данные
      </Button>
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
            Из рабочей базы и хранилища данные удаляются сразу. Резервные копии сервера не переписываются: удалённое исчезнет из них, когда истечёт срок хранения
            бэкапов.
          </p>
          <Input label={`Чтобы подтвердить, введи ${CONFIRM}`} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" autoCapitalize="characters" />
        </div>
      </Sheet>
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
