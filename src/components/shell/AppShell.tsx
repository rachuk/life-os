'use client';
import { Bell, Briefcase, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { QuickCapture } from '@/components/capture/QuickCapture';
import { ExtraWorkSheet } from '@/components/plan/ExtraWorkSheet';
import { MORE_PREFIXES, PRIMARY_NAV, SECONDARY_NAV } from './nav';

function isActive(pathname: string, href: string) {
  if (href === '/more') return MORE_PREFIXES.some((p) => pathname.startsWith(p));
  return pathname === href || pathname.startsWith(href + '/');
}

export interface ShellProps {
  children: ReactNode;
  aside?: ReactNode;
  unread: number;
  displayName: string | null;
  today: string;
}

function UrlTriggers({ onCapture, onExtra }: { onCapture: () => void; onExtra: () => void }) {
  const params = useSearchParams();
  useEffect(() => {
    if (params.get('capture') === '1') onCapture();
    if (params.get('extra') === '1') onExtra();
  }, [params, onCapture, onExtra]);
  return null;
}

function ShellInner({ children, aside, unread, displayName, today }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const [extraMinutes, setExtraMinutes] = useState<number | undefined>(undefined);
  const [captureItem, setCaptureItem] = useState<string | undefined>(undefined);
  const openC = useCallback(() => setCaptureOpen(true), []);
  const openX = useCallback(() => setExtraOpen(true), []);

  useEffect(() => {
    const onCapture = (e: Event) => {
      setCaptureItem((e as CustomEvent<{ itemId?: string }>).detail?.itemId);
      setCaptureOpen(true);
    };
    const onExtra = (e: Event) => {
      setExtraMinutes((e as CustomEvent<{ minutes?: number }>).detail?.minutes);
      setExtraOpen(true);
    };
    window.addEventListener('lifeos:capture', onCapture);
    window.addEventListener('lifeos:extra-work', onExtra);
    return () => {
      window.removeEventListener('lifeos:capture', onCapture);
      window.removeEventListener('lifeos:extra-work', onExtra);
    };
  }, []);

  const closeWithParam = (key: string, set: (v: boolean) => void) => () => {
    set(false);
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get(key)) router.replace(pathname);
  };

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_340px]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-surface px-3 py-5 lg:flex">
        <Link href="/today" className="mb-6 flex items-center gap-2 px-3 text-[17px] font-semibold">
          <span className="grid size-8 place-items-center rounded-xl bg-accent text-sm text-accent-fg">L</span>
          Life OS
        </Link>
        <div className="mb-4 space-y-2 px-1">
          <button type="button" onClick={() => { setCaptureItem(undefined); setCaptureOpen(true); }} className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-accent px-3 text-[15px] font-medium text-accent-fg hover:bg-accent-hover">
            <Plus className="size-5" /> Быстрый ввод
          </button>
          <button type="button" onClick={() => setExtraOpen(true)} className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-border px-3 text-[15px] font-medium hover:bg-surface-2">
            <Briefcase className="size-5" /> Нужно поработать
          </button>
        </div>
        <nav aria-label="Основная навигация" className="space-y-0.5">
          {[...PRIMARY_NAV.filter((n) => n.href !== '/more'), ...SECONDARY_NAV].map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(pathname, n.href) ? 'page' : undefined}
              className={cn(
                'flex min-h-10 items-center gap-3 rounded-xl px-3 text-[15px]',
                isActive(pathname, n.href) ? 'bg-surface-2 font-semibold text-text' : 'text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              <n.icon className="size-[18px]" />
              {n.label}
            </Link>
          ))}
          <Link
            href="/notifications"
            className={cn('flex min-h-10 items-center gap-3 rounded-xl px-3 text-[15px]', pathname.startsWith('/notifications') ? 'bg-surface-2 font-semibold' : 'text-muted hover:bg-surface-2 hover:text-text')}
          >
            <Bell className="size-[18px]" /> Уведомления
            {unread ? <span className="ml-auto rounded-full bg-accent px-2 text-xs text-accent-fg tabular">{unread}</span> : null}
          </Link>
        </nav>
        <div className="mt-auto px-3 text-xs text-faint">{displayName ?? 'Личный аккаунт'}</div>
      </aside>

      {/* Main column */}
      <div className="min-w-0">
        <header className="pt-safe sticky top-0 z-30 flex items-center justify-between border-b border-border bg-bg/90 px-4 backdrop-blur lg:hidden">
          <Link href="/today" className="flex min-h-12 items-center gap-2 font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-accent text-xs text-accent-fg">L</span>
            <span className="text-sm text-muted">{today}</span>
          </Link>
          <Link href="/notifications" aria-label={`Уведомления${unread ? `, непрочитанных: ${unread}` : ''}`} className="relative grid size-11 place-items-center rounded-full hover:bg-surface-2">
            <Bell className="size-5" />
            {unread ? <span className="absolute right-2 top-2 size-2.5 rounded-full bg-accent" /> : null}
          </Link>
        </header>
        <main className="mx-auto w-full max-w-3xl px-4 xl:max-w-4xl pb-[calc(110px+env(safe-area-inset-bottom))] pt-4 lg:px-8 lg:pb-12 lg:pt-8">{children}</main>
      </div>

      {/* Desktop context panel */}
      {aside ? <aside className="sticky top-0 hidden h-dvh overflow-y-auto border-l border-border bg-surface/50 p-5 xl:block">{aside}</aside> : null}

      {/* Mobile FAB + bottom tabs */}
      <button
        type="button"
        onClick={() => { setCaptureItem(undefined); setCaptureOpen(true); }}
        aria-label="Быстрый ввод: текст, голос или фото"
        className="fixed bottom-[calc(76px+env(safe-area-inset-bottom))] right-4 z-40 grid size-14 place-items-center rounded-full bg-accent text-accent-fg shadow-lg hover:bg-accent-hover lg:hidden"
      >
        <Plus className="size-7" />
      </button>
      <nav aria-label="Вкладки" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur lg:hidden">
        <ul className="mx-auto grid max-w-lg grid-cols-5">
          {PRIMARY_NAV.map((n) => {
            const active = isActive(pathname, n.href);
            return (
              <li key={n.href}>
                <Link href={n.href} aria-current={active ? 'page' : undefined} className={cn('flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]', active ? 'font-semibold text-accent' : 'text-muted')}>
                  <n.icon className="size-[22px]" strokeWidth={active ? 2.2 : 1.8} />
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Suspense fallback={null}>
        <UrlTriggers onCapture={openC} onExtra={openX} />
      </Suspense>
      {captureOpen ? <QuickCapture open itemId={captureItem} onClose={closeWithParam('capture', setCaptureOpen)} /> : null}
      {extraOpen ? <ExtraWorkSheet open initialMinutes={extraMinutes} onClose={closeWithParam('extra', setExtraOpen)} /> : null}
    </div>
  );
}

export function AppShell(props: ShellProps) {
  return <ShellInner {...props} />;
}
