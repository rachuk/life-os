import { requirePageUser } from '@/server/auth/current';
import { inUser } from '@/server/context';
import { listInApp } from '@/server/services/notifications';
import { NotificationsClient } from '@/components/settings/NotificationsClient';

export const metadata = { title: 'Уведомления' };

export default async function NotificationsPage() {
  const user = await requirePageUser();
  const items = await inUser(user.id, (tx) => listInApp(tx, user.id, 60));
  return <NotificationsClient items={items} />;
}
