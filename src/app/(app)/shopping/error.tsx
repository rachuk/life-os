'use client';
import { SegmentError } from '@/components/health/SegmentError';

export default function ShoppingError({ error, retry }: { error: unknown; retry: () => void }) {
  return <SegmentError error={error} retry={retry} what="покупки" />;
}
