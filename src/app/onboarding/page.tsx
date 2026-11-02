import { requirePageUser } from '@/server/auth/current';
import { inUser } from '@/server/context';
import { contextToForm, onboardingDefaults } from '@/server/services/profile';
import { OnboardingWizard } from './OnboardingWizard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Первая настройка' };

export default async function OnboardingPage() {
  const user = await requirePageUser();
  const { initial, onboarded } = await inUser(user.id, async (_tx, ctx) => ({
    initial: ctx.profile.isOnboarded ? contextToForm(ctx) : onboardingDefaults(),
    onboarded: ctx.profile.isOnboarded,
  }));
  return (
    <div className="mx-auto max-w-2xl px-4 pb-16 pt-6">
      <OnboardingWizard initial={JSON.parse(JSON.stringify(initial))} editing={onboarded} />
    </div>
  );
}
