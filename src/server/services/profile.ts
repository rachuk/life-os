import { z } from 'zod';
import {
  buildTemplates,
  checkMorning,
  defaultRoutinePrefs,
  mealWindowsSchema,
  notificationPrefsSchema,
  parseMealWindows,
  parseNotificationPrefs,
  parseWeeklyTargets,
  weeklyTargetsSchema,
  type RoutinePrefs,
  type TemplateSpec,
} from '@/domain/planner/prefs';
import { isLocalTime, isValidZone, normTime, timeToMinutes } from '@/domain/time';
import type { Tx } from '../db';
import { AppError } from '../http';
import { EXAMPLE_MEAL_TEMPLATES } from '@/domain/nutrition/catalog';
import { DEFAULT_WORKOUT_PLAN } from '@/domain/fitness/catalog';
import { audit } from './audit';

const time = z.string().transform(normTime).refine(isLocalTime, 'Время в формате ЧЧ:ММ');

export const privacySchema = z.object({
  bodyPhotosOptIn: z.boolean().default(false),
  aiImagesConsent: z.boolean().default(false),
  aiVoiceConsent: z.boolean().default(false),
  aiTextConsent: z.boolean().default(false),
  storeVoiceAudio: z.boolean().default(false),
  mealPhotoRetentionDays: z.number().int().min(1).max(365).default(30),
  screenshotRetentionDays: z.number().int().min(0).max(365).default(7),
  autoApplyLowRisk: z.boolean().default(false),
});
export type PrivacySettings = z.infer<typeof privacySchema>;

export const habitsToggleSchema = z.object({
  breakfast: z.boolean().default(true),
  lunch: z.boolean().default(true),
  dinner: z.boolean().default(true),
  snacks: z.boolean().default(true),
  water: z.boolean().default(true),
  steps: z.boolean().default(true),
  noWorkInBed: z.boolean().default(true),
  sleep: z.boolean().default(true),
  workouts: z.boolean().default(true),
  own_project: z.boolean().default(true),
});

export const onboardingSchema = z
  .object({
    displayName: z.string().trim().max(80).nullable().default(null),
    timezone: z.string().refine(isValidZone, 'Неизвестный часовой пояс').default('Europe/Lisbon'),
    workDays: z.array(z.number().int().min(1).max(7)).max(7).default([1, 2, 3, 4, 5]),
    workStart: time.default('09:00'),
    workEnd: time.default('18:00'),
    morningPrepMinutes: z.number().int().min(10).max(240),
    wakeTime: time,
    weekendWakeTime: time.nullable().default(null),
    bedTime: time,
    fallAsleepMinutes: z.number().int().min(0).max(120).default(15),
    meals: mealWindowsSchema.partial().default({}),
    gymStart: time.default('21:00'),
    gymEnd: time.default('22:00'),
    gymTravelMinutes: z.number().int().min(0).max(180).nullable().default(null),
    gymDays: z.array(z.number().int().min(1).max(7)).max(7).nullable().default(null),
    targets: weeklyTargetsSchema.partial().default({}),
    notifications: notificationPrefsSchema.partial().default({}),
    overtimeWarnMinutes: z.number().int().min(0).max(3000).default(300),
    quietHours: z.object({ start: time, end: time }).nullable().default(null),
    habits: habitsToggleSchema.prefault({}),
    privacy: privacySchema.partial().default({}),
  })
  .superRefine((v, ctx) => {
    if (v.workDays.length && timeToMinutes(v.workEnd) <= timeToMinutes(v.workStart)) {
      ctx.addIssue({ code: 'custom', path: ['workEnd'], message: 'Конец работы должен быть позже начала' });
    }
    if (timeToMinutes(v.gymEnd) <= timeToMinutes(v.gymStart)) {
      ctx.addIssue({ code: 'custom', path: ['gymEnd'], message: 'Конец тренировки должен быть позже начала' });
    }
  });

export type OnboardingInput = z.input<typeof onboardingSchema>;

export interface ProfileRow {
  userId: string;
  displayName: string | null;
  locale: string;
  timezone: string;
  isOnboarded: boolean;
  quietHours: { start: string; end: string } | null;
  privacySettings: Record<string, unknown>;
  featureFlags: Record<string, unknown>;
}

export interface UserContext {
  userId: string;
  profile: ProfileRow;
  prefs: RoutinePrefs;
  privacy: PrivacySettings;
  templates: TemplateSpec[];
  tz: string;
}

interface PrefsRow {
  workDays: number[];
  workStart: string;
  workEnd: string;
  morningPrepMinutes: number;
  wakeTime: string;
  weekendWakeTime: string | null;
  bedTime: string;
  fallAsleepMinutes: number;
  mealWindows: unknown;
  gymPreferredStart: string;
  gymPreferredEnd: string;
  gymTravelMinutes: number | null;
  gymDays: number[] | null;
  weeklyTargets: unknown;
  notificationPreferences: unknown;
  overtimeWeeklyWarnMinutes: number;
}

export function prefsFromRow(row: PrefsRow | undefined, tz: string): RoutinePrefs {
  if (!row) return defaultRoutinePrefs(tz);
  return {
    timezone: tz,
    workDays: row.workDays,
    workStart: normTime(row.workStart),
    workEnd: normTime(row.workEnd),
    morningPrepMinutes: row.morningPrepMinutes,
    wakeTime: normTime(row.wakeTime),
    weekendWakeTime: row.weekendWakeTime ? normTime(row.weekendWakeTime) : null,
    bedTime: normTime(row.bedTime),
    fallAsleepMinutes: row.fallAsleepMinutes,
    meals: parseMealWindows(row.mealWindows),
    gymStart: normTime(row.gymPreferredStart),
    gymEnd: normTime(row.gymPreferredEnd),
    gymTravelMinutes: row.gymTravelMinutes,
    gymDays: row.gymDays,
    targets: parseWeeklyTargets(row.weeklyTargets),
    notifications: parseNotificationPrefs(row.notificationPreferences),
    overtimeWarnMinutes: row.overtimeWeeklyWarnMinutes,
  };
}

interface TemplateRow {
  id: string;
  key: string;
  kind: TemplateSpec['kind'];
  title: string;
  recurrence: TemplateSpec['recurrence'];
  localStart: string | null;
  localEnd: string | null;
  durationMinutes: number | null;
  priorityClass: TemplateSpec['priorityClass'];
  flexWindow: TemplateSpec['flexWindow'];
  reminder: TemplateSpec['reminder'];
  enabled: boolean;
  sortOrder: number;
}

export function templateFromRow(r: TemplateRow): TemplateSpec {
  return {
    id: r.id,
    key: r.key,
    kind: r.kind,
    title: r.title,
    recurrence: r.recurrence,
    localStart: r.localStart ? normTime(r.localStart) : null,
    localEnd: r.localEnd ? normTime(r.localEnd) : null,
    durationMinutes: r.durationMinutes ?? 0,
    priorityClass: r.priorityClass,
    flexWindow: r.flexWindow,
    reminder: r.reminder ?? { type: 'none' },
    enabled: r.enabled,
    sortOrder: r.sortOrder,
  };
}

export async function loadContext(tx: Tx, userId: string): Promise<UserContext> {
  const [profile] = await tx<ProfileRow[]>`
    select user_id, display_name, locale, timezone, is_onboarded, quiet_hours, privacy_settings, feature_flags
    from profiles where user_id = ${userId}`;
  if (!profile) throw new AppError('NO_PROFILE', 'Профиль не найден', 404);
  const [prefsRow] = await tx<PrefsRow[]>`select * from routine_preferences where user_id = ${userId}`;
  const templates = (await tx<TemplateRow[]>`select * from schedule_templates where user_id = ${userId} order by sort_order`).map(
    templateFromRow,
  );
  return {
    userId,
    profile,
    prefs: prefsFromRow(prefsRow, profile.timezone),
    privacy: privacySchema.parse(profile.privacySettings ?? {}),
    templates,
    tz: profile.timezone,
  };
}

function prefsFromInput(v: z.output<typeof onboardingSchema>): RoutinePrefs {
  return {
    timezone: v.timezone,
    workDays: [...new Set(v.workDays)].sort(),
    workStart: v.workStart,
    workEnd: v.workEnd,
    morningPrepMinutes: v.morningPrepMinutes,
    wakeTime: v.wakeTime,
    weekendWakeTime: v.weekendWakeTime,
    bedTime: v.bedTime,
    fallAsleepMinutes: v.fallAsleepMinutes,
    meals: parseMealWindows(v.meals),
    gymStart: v.gymStart,
    gymEnd: v.gymEnd,
    gymTravelMinutes: v.gymTravelMinutes,
    gymDays: v.gymDays && v.gymDays.length ? [...new Set(v.gymDays)].sort() : null,
    targets: parseWeeklyTargets(v.targets),
    notifications: parseNotificationPrefs(v.notifications),
    overtimeWarnMinutes: v.overtimeWarnMinutes,
  };
}

function enabledKeysFromHabits(h: z.output<typeof habitsToggleSchema>): Set<string> {
  const keys = new Set<string>();
  if (h.breakfast) keys.add('breakfast');
  if (h.lunch) keys.add('lunch');
  if (h.dinner) keys.add('dinner');
  if (h.snacks) keys.add('snacks');
  if (h.workouts) keys.add('workouts');
  if (h.own_project) keys.add('own_project');
  return keys;
}

/** Upsert the standard templates by stable key, keeping ids (events keep their template link). */
export async function syncTemplates(tx: Tx, userId: string, prefs: RoutinePrefs, enabledKeys?: Set<string>): Promise<void> {
  const drafts = buildTemplates(prefs, { enabledKeys });
  const keys = drafts.map((d) => d.key);
  for (const d of drafts) {
    await tx`
      insert into schedule_templates
        (user_id, key, kind, title, recurrence, local_start, local_end, duration_minutes, timezone,
         priority_class, flex_window, reminder, enabled, sort_order)
      values (${userId}, ${d.key}, ${d.kind}, ${d.title}, ${tx.json(d.recurrence as never)}, ${d.localStart}, ${d.localEnd},
              ${d.durationMinutes}, ${prefs.timezone}, ${d.priorityClass}, ${d.flexWindow ? tx.json(d.flexWindow) : null},
              ${tx.json(d.reminder as never)}, ${d.enabled}, ${d.sortOrder})
      on conflict (user_id, key) do update set
        kind = excluded.kind, title = excluded.title, recurrence = excluded.recurrence,
        local_start = excluded.local_start, local_end = excluded.local_end, duration_minutes = excluded.duration_minutes,
        timezone = excluded.timezone, priority_class = excluded.priority_class, flex_window = excluded.flex_window,
        reminder = excluded.reminder, enabled = excluded.enabled, sort_order = excluded.sort_order`;
  }
  // standard templates that no longer apply (e.g. snacks switched off) are disabled, not deleted
  await tx`update schedule_templates set enabled = false where user_id = ${userId} and not (key = any(${keys})) and key not like 'skill:%'`;
}

async function savePrefs(tx: Tx, userId: string, p: RoutinePrefs): Promise<void> {
  await tx`
    insert into routine_preferences
      (user_id, work_days, work_start, work_end, morning_prep_minutes, wake_time, weekend_wake_time, bed_time,
       fall_asleep_minutes, meal_windows, gym_preferred_start, gym_preferred_end, gym_travel_minutes, gym_days,
       weekly_targets, notification_preferences, overtime_weekly_warn_minutes)
    values (${userId}, ${p.workDays}, ${p.workStart}, ${p.workEnd}, ${p.morningPrepMinutes}, ${p.wakeTime},
            ${p.weekendWakeTime}, ${p.bedTime}, ${p.fallAsleepMinutes}, ${tx.json(p.meals as never)}, ${p.gymStart},
            ${p.gymEnd}, ${p.gymTravelMinutes}, ${p.gymDays}, ${tx.json(p.targets as never)},
            ${tx.json(p.notifications as never)}, ${p.overtimeWarnMinutes})
    on conflict (user_id) do update set
      work_days = excluded.work_days, work_start = excluded.work_start, work_end = excluded.work_end,
      morning_prep_minutes = excluded.morning_prep_minutes, wake_time = excluded.wake_time,
      weekend_wake_time = excluded.weekend_wake_time, bed_time = excluded.bed_time,
      fall_asleep_minutes = excluded.fall_asleep_minutes, meal_windows = excluded.meal_windows,
      gym_preferred_start = excluded.gym_preferred_start, gym_preferred_end = excluded.gym_preferred_end,
      gym_travel_minutes = excluded.gym_travel_minutes, gym_days = excluded.gym_days,
      weekly_targets = excluded.weekly_targets, notification_preferences = excluded.notification_preferences,
      overtime_weekly_warn_minutes = excluded.overtime_weekly_warn_minutes`;
}

const HABIT_SEED = (h: z.output<typeof habitsToggleSchema>, prefs: RoutinePrefs) => [
  { key: 'breakfast', name: 'Завтрак', type: 'scheduled_checkin', rule: { eventKind: 'meal_breakfast' }, target: null, unit: null, mode: 'event', on: h.breakfast },
  { key: 'lunch', name: 'Обед', type: 'scheduled_checkin', rule: { eventKind: 'meal_lunch' }, target: null, unit: null, mode: 'event', on: h.lunch },
  { key: 'dinner', name: 'Ужин', type: 'scheduled_checkin', rule: { eventKind: 'meal_dinner' }, target: null, unit: null, mode: 'event', on: h.dinner },
  { key: 'snacks', name: 'Перекусы', type: 'scheduled_checkin', rule: { eventKind: 'snack' }, target: null, unit: null, mode: 'event', on: h.snacks },
  { key: 'water', name: 'Вода рядом и с едой', type: 'quantitative', rule: { quickAddMl: 250 }, target: null, unit: 'мл', mode: 'quantity', on: h.water },
  { key: 'steps', name: 'Шаги', type: 'quantitative', rule: { approach: 'baseline_first' }, target: prefs.targets.stepsGoal, unit: 'шагов', mode: 'quantity', on: h.steps },
  { key: 'no_work_in_bed', name: 'Не работаю в кровати', type: 'daily_rule', rule: { askAt: 'evening' }, target: null, unit: null, mode: 'check', on: h.noWorkInBed },
  { key: 'sleep', name: 'Сон', type: 'quantitative', rule: { bedTime: prefs.bedTime, wakeTime: prefs.wakeTime }, target: null, unit: 'ч', mode: 'quantity', on: h.sleep },
  { key: 'workouts', name: 'Силовые тренировки', type: 'weekly_quota', rule: { perWeek: prefs.targets.workouts }, target: prefs.targets.workouts, unit: 'раз/нед', mode: 'event', on: h.workouts },
  { key: 'overtime_boundary', name: 'Переработки не выше порога', type: 'negative_boundary', rule: { maxMinutesPerWeek: prefs.overtimeWarnMinutes }, target: prefs.overtimeWarnMinutes, unit: 'мин/нед', mode: 'check', on: true },
];

export interface OnboardingResult {
  morning: ReturnType<typeof checkMorning>;
  templates: number;
}

export async function saveOnboarding(tx: Tx, userId: string, raw: OnboardingInput): Promise<OnboardingResult> {
  const v = onboardingSchema.parse(raw);
  const prefs = prefsFromInput(v);
  const privacy = privacySchema.parse(v.privacy);
  await savePrefs(tx, userId, prefs);
  await tx`
    update profiles set display_name = ${v.displayName}, timezone = ${v.timezone},
      quiet_hours = ${v.quietHours ? tx.json(v.quietHours) : null},
      privacy_settings = ${tx.json(privacy as never)},
      is_onboarded = true, onboarded_at = coalesce(onboarded_at, now())
    where user_id = ${userId}`;
  await syncTemplates(tx, userId, prefs, enabledKeysFromHabits(v.habits));

  let order = 0;
  for (const h of HABIT_SEED(v.habits, prefs)) {
    await tx`
      insert into habit_definitions (user_id, key, name, type, schedule_rule, target, unit, enabled, tracking_mode, sort_order)
      values (${userId}, ${h.key}, ${h.name}, ${h.type}, ${tx.json(h.rule as never)}, ${h.target}, ${h.unit}, ${h.on}, ${h.mode}, ${order++})
      on conflict (user_id, key) do update set enabled = excluded.enabled, target = coalesce(habit_definitions.target, excluded.target),
        schedule_rule = excluded.schedule_rule`;
  }

  const [{ n: mealCount } = { n: 0 }] = await tx<{ n: number }[]>`select count(*)::int as n from meal_templates where user_id = ${userId}`;
  if (!mealCount) {
    for (const m of EXAMPLE_MEAL_TEMPLATES) {
      await tx`
        insert into meal_templates (user_id, title, category, ingredients_json, prep_minutes, notes, is_example)
        values (${userId}, ${m.title}, ${m.category}, ${tx.json(m.ingredients as never)}, ${m.prepMinutes}, ${m.notes}, true)`;
    }
  }
  const [{ n: planCount } = { n: 0 }] = await tx<{ n: number }[]>`select count(*)::int as n from workout_plans where user_id = ${userId}`;
  if (!planCount) {
    await tx`
      insert into workout_plans (user_id, name, days_per_week, routines_json, notes)
      values (${userId}, ${DEFAULT_WORKOUT_PLAN.name}, ${prefs.targets.workouts}, ${tx.json(DEFAULT_WORKOUT_PLAN.routines as never)}, ${DEFAULT_WORKOUT_PLAN.notes})`;
  }
  await audit(tx, userId, 'profile', userId, 'onboarding_saved', { workDays: prefs.workDays, timezone: prefs.timezone }, 'web');
  const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`select count(*)::int as n from schedule_templates where user_id = ${userId} and enabled`;
  return { morning: checkMorning(prefs), templates: n };
}

export function onboardingDefaults(): z.output<typeof onboardingSchema> {
  const d = defaultRoutinePrefs();
  return onboardingSchema.parse({
    morningPrepMinutes: d.morningPrepMinutes,
    wakeTime: d.wakeTime,
    bedTime: d.bedTime,
    gymDays: [2, 4],
  });
}

/** Current settings in the onboarding/settings form shape. */
export function contextToForm(ctx: UserContext): z.output<typeof onboardingSchema> {
  const p = ctx.prefs;
  const enabled = (key: string) => ctx.templates.some((t) => t.key.startsWith(key) && t.enabled);
  return onboardingSchema.parse({
    displayName: ctx.profile.displayName,
    timezone: ctx.tz,
    workDays: p.workDays,
    workStart: p.workStart,
    workEnd: p.workEnd,
    morningPrepMinutes: p.morningPrepMinutes,
    wakeTime: p.wakeTime,
    weekendWakeTime: p.weekendWakeTime,
    bedTime: p.bedTime,
    fallAsleepMinutes: p.fallAsleepMinutes,
    meals: p.meals,
    gymStart: p.gymStart,
    gymEnd: p.gymEnd,
    gymTravelMinutes: p.gymTravelMinutes,
    gymDays: p.gymDays,
    targets: p.targets,
    notifications: p.notifications,
    overtimeWarnMinutes: p.overtimeWarnMinutes,
    quietHours: ctx.profile.quietHours,
    habits: {
      breakfast: enabled('breakfast'),
      lunch: enabled('lunch'),
      dinner: enabled('dinner'),
      snacks: enabled('snack'),
      workouts: enabled('gym'),
      own_project: enabled('own_project'),
    },
    privacy: ctx.privacy,
  });
}

export async function updatePrivacy(tx: Tx, userId: string, patch: Partial<PrivacySettings>): Promise<PrivacySettings> {
  const [p] = await tx<{ privacySettings: unknown }[]>`select privacy_settings from profiles where user_id = ${userId}`;
  const next = privacySchema.parse({ ...(p?.privacySettings as object), ...patch });
  await tx`update profiles set privacy_settings = ${tx.json(next as never)} where user_id = ${userId}`;
  await audit(tx, userId, 'profile', userId, 'privacy_updated', patch, 'web');
  return next;
}
