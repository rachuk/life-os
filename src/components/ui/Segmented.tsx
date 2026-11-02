'use client';
import type { ReactNode } from 'react';
import { cn } from './cn';

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number }[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1 [scrollbar-width:none]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'min-h-9 shrink-0 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition-colors',
            value === o.value ? 'bg-surface text-text shadow-card' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
          {o.count ? <span className="ml-1.5 tabular text-xs text-faint">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
