import { z } from 'zod';

type PatchShape<T extends z.ZodRawShape> = { [K in keyof T]: z.ZodOptional<T[K]> };

/**
 * Schema for a PATCH body: every field optional and **without its default**.
 *
 * zod 4's `.partial()` keeps `.default()`/`.prefault()`, so `{status}` parses into
 * `{status, category: 'personal', priority: 'normal', …}` and silently overwrites fields the
 * client never sent. Use this instead of `.partial()` for anything merged onto stored data.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<PatchShape<T>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    let f = field as z.ZodType;
    while (f instanceof z.ZodDefault || f instanceof z.ZodPrefault) f = f.unwrap() as z.ZodType;
    shape[key] = f.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<T>>;
}

/** Drops keys whose value is `undefined`, so `{...current, ...patch}` keeps current values. */
export function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}
