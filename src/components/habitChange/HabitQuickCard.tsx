'use client';
import { Hand, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { useToast } from '@/components/ui/Toaster';

export interface QuickProgram {
  id: string;
  title: string;
  unit: string;
  todayTotal: number | null;
  limit: number | null;
  phase: string;
  reasons: string[];
  alternatives: string[];
}

/** One tap «+1»; the reason is an optional second tap. No judgement in the copy. */
export function HabitQuickCard({ p }: { p: QuickProgram }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<'use' | 'urge' | null>(null);
  const [last, setLast] = useState<{ id: string; total: number } | null>(null);
  const [reasonSet, setReasonSet] = useState<string | null>(null);
  const total = last?.total ?? p.todayTotal ?? 0;
  const over = p.limit !== null && total > p.limit;

  async function log(kind: 'use' | 'urge_resisted') {
    setBusy(kind === 'use' ? 'use' : 'urge');
    try {
      const r = await api<{ id: string; todayTotal: number }>(`/api/habit-change/${p.id}/log`, { body: { kind } });
      if (kind === 'use') {
        setLast({ id: r.id, total: r.todayTotal });
        setReasonSet(null);
      } else {
        toast.ok(`Отмечено: удержался. ${p.alternatives[0] ? `Хорошая замена — «${p.alternatives[0].toLowerCase()}».` : ''}`);
      }
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function reason(r: string) {
    if (!last) return;
    setReasonSet(r);
    try {
      await api(`/api/habit-change/events/${last.id}`, { method: 'PATCH', body: { reason: r } });
    } catch (e) {
      setReasonSet(null);
      toast.error(errorMessage(e));
    }
  }

  async function undo() {
    if (!last) return;
    try {
      await api(`/api/habit-change/events/${last.id}`, { method: 'DELETE' });
      setLast(null);
      router.refresh();
      toast.ok('Отметка удалена');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <Link href="/habits" className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{p.title} · сегодня</p>
          <p className="tabular text-xl font-semibold">
            <span className={cn(over && 'text-warn')}>{total}</span>
            {p.limit !== null ? <span className="text-base font-normal text-muted"> из {p.limit}</span> : null}
            <span className="ml-1 text-sm font-normal text-muted">{p.unit}</span>
          </p>
          <p className="text-xs text-faint">{p.phase === 'baseline' ? 'неделя наблюдения — просто отмечай' : p.limit !== null ? 'лимит по твоему плану' : ''}</p>
        </Link>
        <Button variant="ghost" size="sm" loading={busy === 'urge'} onClick={() => log('urge_resisted')} icon={<Hand className="size-4" />} aria-label="Удержался">
          <span className="hidden sm:inline">Удержался</span>
        </Button>
        <Button variant="soft" size="lg" loading={busy === 'use'} onClick={() => log('use')} icon={<Plus className="size-5" />} aria-label={`Плюс один: ${p.unit}`}>
          1
        </Button>
      </div>
      {last ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p className="text-xs text-muted">{reasonSet ? `Причина: ${reasonSet}` : 'Причина? Необязательно — помогает в обзоре недели.'}</p>
          {!reasonSet ? (
            <div className="flex flex-wrap gap-1.5">
              {p.reasons.slice(0, 6).map((r) => (
                <button key={r} type="button" onClick={() => reason(r)} className="min-h-9 rounded-full border border-border px-3 text-sm hover:bg-surface-2">
                  {r}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" onClick={undo} className="text-xs text-muted underline underline-offset-2">
            Отменить отметку
          </button>
        </div>
      ) : null}
    </Card>
  );
}
