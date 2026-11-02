import Link from 'next/link';

export const metadata = { title: 'Восстановление доступа' };

export default function RecoverPage() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4 rounded-3xl border border-border bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold">Восстановление доступа</h1>
        <p className="text-sm text-muted">
          Life OS — личный сервер без почтовой рассылки, поэтому письмо со ссылкой не отправляется. Новый пароль задаётся на сервере
          командой (старые сессии при этом закрываются):
        </p>
        <pre className="overflow-x-auto rounded-xl bg-surface-2 p-3 text-xs">pnpm user:reset-password you@example.com</pre>
        <p className="text-sm text-muted">В Docker: <code className="text-xs">docker compose exec app pnpm user:reset-password you@example.com</code></p>
        <Link href="/login" className="inline-block text-sm font-medium text-accent">
          ← Ко входу
        </Link>
      </div>
    </div>
  );
}
