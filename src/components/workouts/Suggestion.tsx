'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EXERCISE_BY_KEY } from '@/domain/fitness/catalog';
import type { ProgressionOffer } from '@/domain/fitness/session';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';

/** Progression is a suggestion only (PRD §10.3): «Принять» changes the next prefill, «Не сейчас» hides it. */
export function Suggestion({ offer, showName, className }: { offer: ProgressionOffer; showName?: boolean; className?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(decision: 'accepted' | 'dismissed') {
    setBusy(decision);
    try {
      await api('/api/workouts/suggestions', {
        body: { exerciseKey: offer.exerciseKey, basedOnSessionId: offer.basedOnSessionId, decision, weightKg: offer.weightKg },
      });
      toast.ok(decision === 'accepted' ? 'Принято — вес подставится в следующий подход' : 'Хорошо, не сейчас');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={cn('rounded-xl bg-accent-soft px-3 py-2.5 text-sm', className)}>
      {showName ? <p className="font-medium">{EXERCISE_BY_KEY[offer.exerciseKey]?.name}</p> : null}
      <p>{offer.message}</p>
      <div className="mt-2 flex gap-2">
        {offer.weightKg !== null ? (
          <Button size="md" variant="primary" loading={busy === 'accepted'} onClick={() => decide('accepted')}>
            Принять{offer.weightKg !== null ? ` ${offer.weightKg} кг` : ''}
          </Button>
        ) : null}
        <Button size="md" variant="ghost" loading={busy === 'dismissed'} onClick={() => decide('dismissed')}>
          Не сейчас
        </Button>
      </div>
    </div>
  );
}
