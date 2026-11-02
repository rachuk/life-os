import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { env } from '@/server/env';
import { aiImagesAvailable, mealTargets, MEDIA_PURPOSES, type MediaPurpose } from '@/server/services/media';
import { PhotoCapture } from '@/components/media/PhotoCapture';

export const metadata = { title: 'Фото' };

/** Photo / screenshot capture with explicit purpose (PRD §11.1): weight, steps, meal, progress, receipt, other. */
export default async function HealthPhotoPage({ searchParams }: { searchParams: Promise<{ purpose?: string }> }) {
  const user = await requirePageUser();
  const { purpose } = await searchParams;
  const data = await inUser(user.id, async (tx, ctx) => {
    const { options, suggested } = await mealTargets(tx, ctx, now());
    return {
      ai: aiImagesAvailable(ctx.privacy),
      bodyPhotosOptIn: ctx.privacy.bodyPhotosOptIn,
      mealOptions: options,
      suggestedMeal: suggested,
      retention: { mealDays: ctx.privacy.mealPhotoRetentionDays, screenshotDays: ctx.privacy.screenshotRetentionDays },
    };
  });
  const initial = (MEDIA_PURPOSES as readonly string[]).includes(purpose ?? '') ? (purpose as MediaPurpose) : null;
  return <PhotoCapture {...data} maxMb={env().MAX_UPLOAD_MB} initialPurpose={initial} />;
}
