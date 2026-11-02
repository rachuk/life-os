import type { Metadata } from 'next';
import { OfflinePlan } from './OfflinePlan';

export const dynamic = 'force-static';
export const metadata: Metadata = { title: 'Нет соединения', robots: { index: false } };

/**
 * Static offline fallback (served by the service worker when a navigation fails). It contains no
 * user data itself; the client part reads the last plan snapshot the service worker kept on this device.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Нет соединения</h1>
        <p className="text-sm text-muted">
          Life OS сейчас недоступен. Ниже — последний загруженный на этом устройстве план, только для просмотра: отметить или изменить что-то можно, когда связь вернётся.
        </p>
      </header>
      <OfflinePlan />
    </main>
  );
}
