'use client';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

const control =
  'w-full min-h-11 rounded-xl border border-border bg-surface px-3 text-[16px] text-text placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60';

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null }>(
  function Input({ label, hint, error, className, id, ...rest }, ref) {
    const auto = useId();
    const iid = id ?? auto;
    const el = <input ref={ref} id={iid} aria-invalid={!!error || undefined} className={cn(control, className)} {...rest} />;
    return label ? (
      <Field label={label} hint={hint} error={error} htmlFor={iid}>
        {el}
      </Field>
    ) : (
      el
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null }>(
  function Textarea({ label, hint, error, className, id, ...rest }, ref) {
    const auto = useId();
    const iid = id ?? auto;
    const el = <textarea ref={ref} id={iid} aria-invalid={!!error || undefined} className={cn(control, 'min-h-24 py-2.5', className)} {...rest} />;
    return label ? (
      <Field label={label} hint={hint} error={error} htmlFor={iid}>
        {el}
      </Field>
    ) : (
      el
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null }>(
  function Select({ label, hint, error, className, id, children, ...rest }, ref) {
    const auto = useId();
    const iid = id ?? auto;
    const el = (
      <select ref={ref} id={iid} className={cn(control, 'appearance-none bg-[length:16px] pr-8', className)} {...rest}>
        {children}
      </select>
    );
    return label ? (
      <Field label={label} hint={hint} error={error} htmlFor={iid}>
        {el}
      </Field>
    ) : (
      el
    );
  },
);

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-1">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[15px]">{label}</span>
        {description ? <span className="block text-xs text-muted">{description}</span> : null}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-surface-3')}
      >
        <span className={cn('absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
      </button>
    </div>
  );
}

export function Chips<T extends string | number>({
  options,
  value,
  onChange,
  multiple,
  ariaLabel,
}: {
  options: { value: T; label: ReactNode }[];
  value: T[];
  onChange: (v: T[]) => void;
  multiple?: boolean;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(multiple ? (on ? value.filter((v) => v !== o.value) : [...value, o.value]) : [o.value])}
            className={cn(
              'min-h-10 rounded-full border px-3.5 text-sm font-medium transition-colors',
              on ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface text-text hover:bg-surface-2',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
