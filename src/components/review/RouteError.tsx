'use client';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/States';

/** Segment error boundary body for review / rewards / more (Next 16 passes `retry`). */
export function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && 'digest' in error ? String((error as Error & { digest?: string }).digest ?? '') : '';
  return (
    <ErrorState
      title="Не удалось загрузить экран"
      action={
        <Button variant="primary" onClick={() => retry()}>
          Попробовать ещё раз
        </Button>
      }
    >
      Данные не потеряны. Проверь соединение и повтори.{digest ? <span className="mt-1 block text-xs text-faint">Код: {digest}</span> : null}
    </ErrorState>
  );
}
