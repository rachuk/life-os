import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchOf } from '@/lib/patch';
import { taskPatchSchema } from '@/server/services/tasks';
import { mealTemplatePatchSchema } from '@/server/services/meals';
import { skillPatchSchema } from '@/server/services/skills';
import { goalPatchSchema, rewardsSettingsPatchSchema } from '@/server/services/rewards';
import { privacySchema } from '@/server/services/profile';

/** A PATCH must carry only what the client sent — defaults would overwrite stored values. */
describe('PATCH schemas never invent fields', () => {
  it('patchOf strips defaults and prefaults but keeps validation', () => {
    const s = patchOf(z.object({ a: z.boolean().default(false), b: z.number().min(1).default(7), c: z.object({}).prefault({}) }));
    expect(s.parse({})).toEqual({});
    expect(s.parse({ b: 3 })).toEqual({ b: 3 });
    expect(() => s.parse({ b: 0 })).toThrow();
  });

  it.each([
    ['task status', taskPatchSchema, { status: 'done' }],
    ['meal template toggle', mealTemplatePatchSchema, { enabled: false }],
    ['skill mode', skillPatchSchema, { status: 'maintenance' }],
    ['goal archive', goalPatchSchema, { status: 'archived' }],
    ['rewards settings', rewardsSettingsPatchSchema, { perWorkoutCents: 300 }],
    ['one privacy switch', patchOf(privacySchema), { aiVoiceConsent: true }],
  ] as const)('%s → exactly the sent keys', (_name, schema, body) => {
    expect((schema as z.ZodType).parse(body)).toEqual(body);
  });
});
