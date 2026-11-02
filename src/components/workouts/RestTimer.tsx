'use client';
import { Timer } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';

export interface RestTimerHandle {
  start: (seconds?: number) => void;
}

const PRESETS = [60, 90, 120, 180];

function beep() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
    o.onended = () => void ctx.close();
  } catch {
    /* sound is optional */
  }
}

/**
 * In-page rest timer (PRD §10.2). It is honest about its limits: it runs while the screen is open —
 * no background or lock-screen alerts are promised without a native app.
 */
export function RestTimer({ ref }: { ref?: Ref<RestTimerHandle> }) {
  const [preset, setPreset] = useState(90);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [left, setLeft] = useState(0);
  const [done, setDone] = useState(false);
  const fired = useRef(false);

  useImperativeHandle(ref, () => ({
    start: (seconds?: number) => {
      const s = seconds ?? preset;
      fired.current = false;
      setDone(false);
      setLeft(s);
      setEndsAt(Date.now() + s * 1000);
    },
  }));

  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => {
      const ms = endsAt - Date.now();
      setLeft(Math.max(0, Math.ceil(ms / 1000)));
      if (ms <= 0 && !fired.current) {
        fired.current = true;
        setEndsAt(null);
        setDone(true);
        navigator.vibrate?.([200, 100, 200]);
        beep();
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [endsAt]);

  const running = endsAt !== null;
  const mm = String(Math.floor(left / 60));
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className={cn('rounded-2xl border border-border bg-surface p-3', done && 'border-accent')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Timer className="size-4 text-muted" />
          <span className="text-sm font-medium">Отдых</span>
        </div>
        <span className={cn('tabular text-2xl font-semibold', !running && !done && 'text-faint')} aria-live="polite" aria-atomic="true">
          {running ? `${mm}:${ss}` : done ? 'Можно!' : `${Math.floor(preset / 60)}:${String(preset % 60).padStart(2, '0')}`}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={preset === p}
            onClick={() => setPreset(p)}
            className={cn('min-h-11 rounded-xl border px-3 text-sm', preset === p ? 'border-accent bg-accent-soft text-accent' : 'border-border hover:bg-surface-2')}
          >
            {p < 120 ? `${p} с` : `${p / 60} мин`}
          </button>
        ))}
        {running ? (
          <Button variant="ghost" onClick={() => setEndsAt(null)} className="ml-auto">
            Стоп
          </Button>
        ) : (
          <Button
            variant="soft"
            className="ml-auto"
            onClick={() => {
              fired.current = false;
              setDone(false);
              setLeft(preset);
              setEndsAt(Date.now() + preset * 1000);
            }}
          >
            Старт
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted">Таймер работает, пока экран открыт. Фоновых напоминаний на iPhone без приложения не обещаем.</p>
    </div>
  );
}
