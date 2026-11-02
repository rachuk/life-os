import { z } from 'zod';
import { isLocalTime, minutesToTime, normTime, timeToMinutes, type LocalTime } from '../time';
import type { EventKind, EventPriority } from '../types';

/**
 * Routine preferences = the user's real parameters (PRD §4). Everything here is editable;
 * defaults are neutral suggestions shown in onboarding, never silent laws.
 */

const time = z
  .string()
  .transform((v) => normTime(v))
  .refine(isLocalTime, 'Время в формате ЧЧ:ММ');

const mealWindow = z.object({
  start: time,
  duration: z.number().int().min(10).max(120),
  earliest: time,
  latest: time,
});

export const mealWindowsSchema = z.object({
  breakfastMinutes: z.number().int().min(5).max(60).default(20),
  lunch: mealWindow.default({ start: '13:00', duration: 45, earliest: '12:00', latest: '15:00' }),
  weekendLunch: mealWindow.default({ start: '13:30', duration: 45, earliest: '12:00', latest: '15:30' }),
  dinner: mealWindow.default({ start: '19:30', duration: 45, earliest: '18:30', latest: '21:30' }),
  snacks: z
    .object({
      enabled: z.boolean().default(true),
      times: z.array(time).max(4).default(['11:00', '16:00']),
      duration: z.number().int().min(5).max(30).default(10),
    })
    .default({ enabled: true, times: ['11:00', '16:00'], duration: 10 }),
});

export const weeklyTargetsSchema = z.object({
  workouts: z.number().int().min(0).max(7).default(2),
  workoutMinutes: z.number().int().min(20).max(180).default(60),
  gymFlexEarliest: time.default('18:30'),
  gymFlexLatest: time.default('22:30'),
  projectMinutes: z.number().int().min(0).max(3000).default(180),
  projectSessionMinutes: z.number().int().min(15).max(240).default(60),
  projectEarliest: time.default('18:15'),
  projectLatest: time.default('23:00'),
  projectPreferredStart: time.default('18:30'),
  projectWeekendEarliest: time.default('10:00'),
  stepsGoal: z.number().int().min(0).max(50000).nullable().default(null),
});

export const notificationPrefsSchema = z.object({
  channels: z
    .object({ in_app: z.boolean().default(true), telegram: z.boolean().default(true), web_push: z.boolean().default(true) })
    .default({ in_app: true, telegram: true, web_push: true }),
  repeatMinutes: z.number().int().min(5).max(60).default(15),
  maxRepeats: z.number().int().min(0).max(1).default(1),
  maxPerDay: z.number().int().min(1).max(50).default(14),
  eveningReviewTime: time.nullable().default(null), // null → bedTime − 45 min
  weeklyReviewDay: z.number().int().min(1).max(7).default(7),
  weeklyReviewTime: time.default('19:00'),
  workoutLeadMinutes: z.number().int().min(0).max(120).default(30),
  sleepReminder: z.boolean().default(true),
  snackReminders: z.boolean().default(true),
});

export type MealWindows = z.infer<typeof mealWindowsSchema>;
export type WeeklyTargets = z.infer<typeof weeklyTargetsSchema>;
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export interface RoutinePrefs {
  timezone: string;
  workDays: number[];
  workStart: LocalTime;
  workEnd: LocalTime;
  morningPrepMinutes: number;
  wakeTime: LocalTime;
  weekendWakeTime: LocalTime | null;
  bedTime: LocalTime;
  fallAsleepMinutes: number;
  meals: MealWindows;
  gymStart: LocalTime;
  gymEnd: LocalTime;
  gymTravelMinutes: number | null;
  gymDays: number[] | null;
  targets: WeeklyTargets;
  notifications: NotificationPrefs;
  overtimeWarnMinutes: number;
}

export function parseMealWindows(v: unknown): MealWindows {
  return mealWindowsSchema.parse(v ?? {});
}
export function parseWeeklyTargets(v: unknown): WeeklyTargets {
  return weeklyTargetsSchema.parse(v ?? {});
}
export function parseNotificationPrefs(v: unknown): NotificationPrefs {
  return notificationPrefsSchema.parse(v ?? {});
}

export function defaultRoutinePrefs(timezone = 'Europe/Lisbon'): RoutinePrefs {
  return {
    timezone,
    workDays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    morningPrepMinutes: 60,
    wakeTime: '08:00',
    weekendWakeTime: null,
    bedTime: '00:00',
    fallAsleepMinutes: 15,
    meals: parseMealWindows({}),
    gymStart: '21:00',
    gymEnd: '22:00',
    gymTravelMinutes: null,
    gymDays: null,
    targets: parseWeeklyTargets({}),
    notifications: parseNotificationPrefs({}),
    overtimeWarnMinutes: 300,
  };
}

/**
 * PL-03: the latest wake time that still leaves `morningPrepMinutes` before work.
 * The planner never schedules a later wake on work days.
 */
export function latestWorkdayWake(prefs: Pick<RoutinePrefs, 'workStart' | 'morningPrepMinutes'>): LocalTime {
  return minutesToTime(timeToMinutes(prefs.workStart) - prefs.morningPrepMinutes);
}

export function workdayWake(prefs: RoutinePrefs): LocalTime {
  const latest = timeToMinutes(latestWorkdayWake(prefs));
  const preferred = timeToMinutes(prefs.wakeTime);
  return minutesToTime(Math.min(preferred, latest));
}

export function weekendWake(prefs: RoutinePrefs): LocalTime {
  return prefs.weekendWakeTime ?? prefs.wakeTime;
}

export interface MorningCheck {
  ok: boolean;
  latestWake: LocalTime;
  message: string | null;
}

export function checkMorning(prefs: RoutinePrefs): MorningCheck {
  const latest = latestWorkdayWake(prefs);
  if (timeToMinutes(prefs.wakeTime) > timeToMinutes(latest)) {
    return {
      ok: false,
      latestWake: latest,
      message: `Чтобы успеть ${prefs.morningPrepMinutes} мин на утро до ${prefs.workStart}, в рабочие дни подъём нужен не позже ${latest}. В плане будних дней будет ${latest}.`,
    };
  }
  return { ok: true, latestWake: latest, message: null };
}

export function eveningReviewTime(prefs: RoutinePrefs): LocalTime {
  return prefs.notifications.eveningReviewTime ?? minutesToTime(timeToMinutes(prefs.bedTime) - 45);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type Recurrence =
  | { type: 'weekly'; days: number[] }
  | {
      type: 'weekly_quota';
      count: number;
      preferredDays: number[] | null;
      allowedDays: number[];
      avoidConsecutive: boolean;
      preferredStart: LocalTime;
      weekendEarliest?: LocalTime;
    };

export interface ReminderSpec {
  type: 'important' | 'soft' | 'review' | 'none';
  /** minutes before start (positive) */
  leadMinutes?: number;
  /** also remind at the end ("Завершил работу?") */
  atEnd?: boolean;
}

export interface TemplateSpec {
  id: string;
  key: string;
  kind: EventKind;
  title: string;
  recurrence: Recurrence;
  localStart: LocalTime | null;
  localEnd: LocalTime | null;
  durationMinutes: number;
  priorityClass: EventPriority;
  flexWindow: { earliest: LocalTime; latest: LocalTime } | null;
  reminder: ReminderSpec;
  enabled: boolean;
  sortOrder: number;
}

export type TemplateDraft = Omit<TemplateSpec, 'id'>;

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

function addMin(t: LocalTime, m: number): LocalTime {
  return minutesToTime(timeToMinutes(t) + m);
}

/** Build the standard template set from preferences (onboarding / settings save). */
export function buildTemplates(prefs: RoutinePrefs, opts: { enabledKeys?: Set<string> } = {}): TemplateDraft[] {
  const weekendDays = ALL_DAYS.filter((d) => !prefs.workDays.includes(d));
  const enabled = (key: string, dflt = true) => (opts.enabledKeys ? opts.enabledKeys.has(key) : dflt);
  const m = prefs.meals;
  const t = prefs.targets;
  const out: TemplateDraft[] = [];
  let order = 0;

  const wdWake = workdayWake(prefs);
  const weWake = weekendWake(prefs);

  if (prefs.workDays.length) {
    out.push({
      key: 'work',
      kind: 'work',
      title: 'Работа',
      recurrence: { type: 'weekly', days: prefs.workDays },
      localStart: prefs.workStart,
      localEnd: prefs.workEnd,
      durationMinutes: timeToMinutes(prefs.workEnd) - timeToMinutes(prefs.workStart),
      priorityClass: 'fixed',
      flexWindow: null,
      reminder: { type: 'important', atEnd: true },
      enabled: true,
      sortOrder: order++,
    });
    out.push({
      key: 'morning_workday',
      kind: 'morning_routine',
      title: 'Утро: гигиена и завтрак',
      recurrence: { type: 'weekly', days: prefs.workDays },
      localStart: wdWake,
      localEnd: addMin(wdWake, prefs.morningPrepMinutes),
      durationMinutes: prefs.morningPrepMinutes,
      priorityClass: 'protected',
      flexWindow: null,
      reminder: { type: 'none' },
      enabled: true,
      sortOrder: order++,
    });
    out.push({
      key: 'breakfast_workday',
      kind: 'meal_breakfast',
      title: 'Завтрак',
      recurrence: { type: 'weekly', days: prefs.workDays },
      localStart: addMin(wdWake, prefs.morningPrepMinutes - m.breakfastMinutes),
      localEnd: addMin(wdWake, prefs.morningPrepMinutes),
      durationMinutes: m.breakfastMinutes,
      priorityClass: 'protected',
      flexWindow: null,
      reminder: { type: 'important' },
      enabled: enabled('breakfast'),
      sortOrder: order++,
    });
    out.push({
      key: 'lunch_workday',
      kind: 'meal_lunch',
      title: 'Обед',
      recurrence: { type: 'weekly', days: prefs.workDays },
      localStart: m.lunch.start,
      localEnd: addMin(m.lunch.start, m.lunch.duration),
      durationMinutes: m.lunch.duration,
      priorityClass: 'protected',
      flexWindow: { earliest: m.lunch.earliest, latest: m.lunch.latest },
      reminder: { type: 'important' },
      enabled: enabled('lunch'),
      sortOrder: order++,
    });
    if (m.snacks.enabled) {
      m.snacks.times.forEach((st, i) => {
        out.push({
          key: `snack_${i + 1}`,
          kind: 'snack',
          title: 'Перекус',
          recurrence: { type: 'weekly', days: prefs.workDays },
          localStart: st,
          localEnd: addMin(st, m.snacks.duration),
          durationMinutes: m.snacks.duration,
          priorityClass: 'flexible',
          flexWindow: null,
          reminder: { type: prefs.notifications.snackReminders ? 'soft' : 'none' },
          enabled: enabled('snacks'),
          sortOrder: order++,
        });
      });
    }
  }

  if (weekendDays.length) {
    out.push({
      key: 'morning_weekend',
      kind: 'morning_routine',
      title: 'Утро',
      recurrence: { type: 'weekly', days: weekendDays },
      localStart: weWake,
      localEnd: addMin(weWake, prefs.morningPrepMinutes),
      durationMinutes: prefs.morningPrepMinutes,
      priorityClass: 'protected',
      flexWindow: null,
      reminder: { type: 'none' },
      enabled: true,
      sortOrder: order++,
    });
    out.push({
      key: 'breakfast_weekend',
      kind: 'meal_breakfast',
      title: 'Завтрак',
      recurrence: { type: 'weekly', days: weekendDays },
      localStart: addMin(weWake, prefs.morningPrepMinutes - m.breakfastMinutes),
      localEnd: addMin(weWake, prefs.morningPrepMinutes),
      durationMinutes: m.breakfastMinutes,
      priorityClass: 'protected',
      flexWindow: null,
      reminder: { type: 'soft' },
      enabled: enabled('breakfast'),
      sortOrder: order++,
    });
    out.push({
      key: 'lunch_weekend',
      kind: 'meal_lunch',
      title: 'Обед',
      recurrence: { type: 'weekly', days: weekendDays },
      localStart: m.weekendLunch.start,
      localEnd: addMin(m.weekendLunch.start, m.weekendLunch.duration),
      durationMinutes: m.weekendLunch.duration,
      priorityClass: 'protected',
      flexWindow: { earliest: m.weekendLunch.earliest, latest: m.weekendLunch.latest },
      reminder: { type: 'soft' },
      enabled: enabled('lunch'),
      sortOrder: order++,
    });
  }

  out.push({
    key: 'dinner',
    kind: 'meal_dinner',
    title: 'Ужин',
    recurrence: { type: 'weekly', days: ALL_DAYS },
    localStart: m.dinner.start,
    localEnd: addMin(m.dinner.start, m.dinner.duration),
    durationMinutes: m.dinner.duration,
    priorityClass: 'protected',
    flexWindow: { earliest: m.dinner.earliest, latest: m.dinner.latest },
    reminder: { type: 'important' },
    enabled: enabled('dinner'),
    sortOrder: order++,
  });

  if (t.workouts > 0) {
    const gymDuration = timeToMinutes(prefs.gymEnd) - timeToMinutes(prefs.gymStart) || t.workoutMinutes;
    out.push({
      key: 'gym',
      kind: 'workout',
      title: 'Силовая тренировка',
      recurrence: {
        type: 'weekly_quota',
        count: t.workouts,
        preferredDays: prefs.gymDays,
        allowedDays: ALL_DAYS,
        avoidConsecutive: true,
        preferredStart: prefs.gymStart,
      },
      localStart: prefs.gymStart,
      localEnd: prefs.gymEnd,
      durationMinutes: gymDuration,
      priorityClass: 'required_movable',
      flexWindow: { earliest: t.gymFlexEarliest, latest: t.gymFlexLatest },
      reminder: { type: 'important', leadMinutes: prefs.notifications.workoutLeadMinutes + (prefs.gymTravelMinutes ?? 0) },
      enabled: enabled('workouts'),
      sortOrder: order++,
    });
  }

  if (t.projectMinutes > 0) {
    const sessions = Math.max(1, Math.round(t.projectMinutes / t.projectSessionMinutes));
    out.push({
      key: 'own_project',
      kind: 'own_project',
      title: 'Свой проект',
      recurrence: {
        type: 'weekly_quota',
        count: Math.min(sessions, 7),
        preferredDays: null,
        allowedDays: ALL_DAYS,
        avoidConsecutive: false,
        preferredStart: t.projectPreferredStart,
        weekendEarliest: t.projectWeekendEarliest,
      },
      localStart: t.projectPreferredStart,
      localEnd: addMin(t.projectPreferredStart, t.projectSessionMinutes),
      durationMinutes: t.projectSessionMinutes,
      priorityClass: 'required_movable',
      flexWindow: { earliest: t.projectEarliest, latest: t.projectLatest },
      reminder: { type: 'soft' },
      enabled: enabled('own_project'),
      sortOrder: order++,
    });
  }

  const review = eveningReviewTime(prefs);
  out.push({
    key: 'evening_review',
    kind: 'review',
    title: 'Завершение дня и план на завтра',
    recurrence: { type: 'weekly', days: ALL_DAYS },
    localStart: review,
    localEnd: addMin(review, 15),
    durationMinutes: 15,
    priorityClass: 'flexible',
    flexWindow: null,
    reminder: { type: 'review' },
    enabled: true,
    sortOrder: order++,
  });

  out.push({
    key: 'weekly_review',
    kind: 'weekly_review',
    title: 'Обзор недели и план',
    recurrence: { type: 'weekly', days: [prefs.notifications.weeklyReviewDay] },
    localStart: prefs.notifications.weeklyReviewTime,
    localEnd: addMin(prefs.notifications.weeklyReviewTime, 30),
    durationMinutes: 30,
    priorityClass: 'flexible',
    flexWindow: null,
    reminder: { type: 'review' },
    enabled: true,
    sortOrder: order++,
  });

  out.push({
    key: 'sleep',
    kind: 'sleep',
    title: 'Сон',
    recurrence: { type: 'weekly', days: ALL_DAYS },
    localStart: prefs.bedTime,
    localEnd: wdWake,
    durationMinutes: 0, // computed per night from the next morning
    priorityClass: 'protected',
    flexWindow: null,
    reminder: { type: prefs.notifications.sleepReminder ? 'soft' : 'none', leadMinutes: 30 },
    enabled: true,
    sortOrder: order++,
  });

  return out;
}
