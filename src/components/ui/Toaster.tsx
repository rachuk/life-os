'use client';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cn } from './cn';

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
  action?: { label: string; onClick: () => void };
}

const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

export function useToast() {
  const push = useContext(Ctx);
  return {
    ok: (text: string, action?: Toast['action']) => push({ text, tone: 'ok', action }),
    error: (text: string) => push({ text, tone: 'error' }),
    info: (text: string, action?: Toast['action']) => push({ text, tone: 'info', action }),
  };
}

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.action ? 7000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'animate-in pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl px-4 py-3 text-sm shadow-lg',
              t.tone === 'error' ? 'bg-danger text-white' : 'bg-text text-bg',
            )}
          >
            <span>{t.text}</span>
            {t.action ? (
              <button type="button" className="font-semibold underline underline-offset-2" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
