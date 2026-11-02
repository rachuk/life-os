import Link from 'next/link';

export const metadata = { title: 'Восстановление доступа' };

export default function RecoverPage() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4 rounded-3xl border border-border bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold">Восстановление доступа</h1>
        <p className="text-sm text-muted">
          Life OS работает на личном сервере без почтовой рассылки, поэтому письмо со ссылкой не придёт. Новый пароль задаёт администратор сервера — старые сессии при
          этом закрываются.
        </p>
        <details className="rounded-xl bg-surface-2 p-3 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">Если администратор — ты</summary>
          <p className="mt-1 text-muted">Выполни на сервере:</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-surface p-3 text-xs">pnpm user:reset-password you@example.com</pre>
          <p className="mt-2 text-muted">Подробнее — в README, в таблице команд.</p>
        </details>
        <Link href="/login" className="inline-flex min-h-11 items-center text-sm font-medium text-accent">
          ← Ко входу
        </Link>
      </div>
    </div>
  );
}
