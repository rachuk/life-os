import type { ReactNode } from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';
import { cn } from './cn';

export function EmptyState({ title, children, icon, action, className }: { title: ReactNode; children?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">{icon ?? <Inbox className="size-6" />}</div>
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 max-w-sm text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ title = 'Не удалось загрузить', children, action }: { title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-2xl border border-border bg-surface px-6 py-8 text-center">
      <AlertTriangle className="mb-2 size-6 text-danger" />
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Notice({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'warn' | 'danger' | 'ok' | 'accent'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-surface-2 text-text',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
    ok: 'bg-ok-soft text-ok',
    accent: 'bg-accent-soft text-accent',
  } as const;
  return <div className={cn('rounded-xl px-3.5 py-2.5 text-sm', tones[tone], className)}>{children}</div>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-xl bg-surface-2', className)} />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Загрузка">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
