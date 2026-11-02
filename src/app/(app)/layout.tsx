import { redirect } from 'next/navigation';
import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { unreadCount } from '@/server/services/notifications';
import { formatDateRu, localDateOf } from '@/domain/time';
import { AppShell } from '@/components/shell/AppShell';
import { UserProvider } from '@/components/shell/UserContext';
import { ContextPanel } from '@/components/shell/ContextPanel';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const { ctx, unread } = await inUser(user.id, async (tx, ctx) => ({ ctx, unread: await unreadCount(tx, user.id) }));
  if (!ctx.profile.isOnboarded) redirect('/onboarding');
  const today = localDateOf(now(), ctx.tz);
  return (
    <UserProvider
      value={{ tz: ctx.tz, today, workEnd: ctx.prefs.workEnd, workStart: ctx.prefs.workStart, workDays: ctx.prefs.workDays, gymStart: ctx.prefs.gymStart }}
    >
      <AppShell unread={unread} displayName={ctx.profile.displayName ?? user.email} today={formatDateRu(today, { long: true })} aside={<ContextPanel userId={user.id} />}>
        {children}
      </AppShell>
    </UserProvider>
  );
}
