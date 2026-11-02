'use client';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/States';

/** error.tsx body for the health / shopping / workouts segments (Next 16 passes `retry`). */
export function SegmentError({ error, retry, what }: { error: unknown; retry: () => void; what: string }) {
  const digest = error instanceof Error && 'digest' in error ? String((error as { digest?: string }).digest ?? '') : '';
  return (
    <ErrorState
      title={`Не удалось загрузить: ${what}`}
      action={
        <Button variant="primary" onClick={() => retry()}>
          Попробовать ещё раз
        </Button>
      }
    >
      Проверь соединение и попробуй ещё раз. Введённые ранее данные не потеряны.
      {digest ? <span className="mt-1 block text-xs text-faint">Код: {digest}</span> : null}
    </ErrorState>
  );
}
