'use client';

/** Open global sheets (quick capture, extra work) from any client component. */
export function openCapture(itemId?: string): void {
  window.dispatchEvent(new CustomEvent('lifeos:capture', { detail: { itemId } }));
}

export function openExtraWork(minutes?: number): void {
  window.dispatchEvent(new CustomEvent('lifeos:extra-work', { detail: { minutes } }));
}
