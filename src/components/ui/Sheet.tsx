'use client';
import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * Bottom sheet on phones, centred dialog on larger screens. Built on <dialog> for native focus
 * trapping, Esc handling and accessibility.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="sheet-title"
      className={cn(
        'm-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-3xl border border-border bg-surface p-0 text-text shadow-xl',
        'sm:m-auto sm:rounded-3xl',
        size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        open && 'sheet-in',
      )}
    >
      {open ? (
        <div className="flex max-h-[92dvh] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 pb-3 pt-4">
            <div className="min-w-0">
              <h2 id="sheet-title" className="text-lg font-semibold leading-snug">
                {title}
              </h2>
              {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
            </div>
            <button type="button" onClick={onClose} aria-label="Закрыть" className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2">
              <X className="size-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="border-t border-border px-5 pb-safe pt-3 [&]:pb-[max(12px,env(safe-area-inset-bottom))]">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
