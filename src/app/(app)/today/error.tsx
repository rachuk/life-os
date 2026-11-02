'use client';
import { RouteError } from '@/components/review/RouteError';

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} />;
}
