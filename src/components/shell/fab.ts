'use client';
import { useEffect } from 'react';

/** Hide the floating «+» while a screen needs the space (e.g. an active workout session). */
export function useHideFab(hidden: boolean) {
  useEffect(() => {
    if (!hidden) return;
    document.documentElement.dataset.hideFab = '1';
    return () => {
      delete document.documentElement.dataset.hideFab;
    };
  }, [hidden]);
}
