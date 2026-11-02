import { describe, expect, it } from 'vitest';
import { previewExtraWork } from '@/domain/planner/extraWork';
import { checkMorning, workdayWake } from '@/domain/planner/prefs';
import { isoWeekday, localTimeOf, weekStartOf, zoned } from '@/domain/time';
import { lisbon, local, materializeWeek, prefs, TZ } from '../helpers/plan';

const NOW_SUNDAY = lisbon('2026-11-01T20:00');

describe('time helpers', () => {
  it('interprets local wall-clock time in Europe/Lisbon across seasons', () => {
    expect(zoned('2026-11-02', '09:00', TZ).toISO()).toBe('2026-11-02T09:00:00.000Z'); // WET = UTC+0
    expect(zoned('2026-07-01', '09:00', TZ).toISO()).toBe('2026-07-01T08:00:00.000Z'); // WEST = UTC+1
    expect(weekStartOf('2026-11-08')).toBe('2026-11-02');
    expect(weekStartOf('2026-11-02')).toBe('2026-11-02');
  });
});

describe('PL-01 / PL-02 weekly materialisation', () => {
  const { events } = materializeWeek(prefs(), '2026-11-02', '2026-11-08', NOW_SUNDAY);

  it('creates the 09:00–18:00 work block Mon–Fri and none on the weekend', () => {
    const work = events.filter((e) => e.kind === 'work');
    expect(work.map((e) => e.localDate)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    for (const w of work) {
      expect(localTimeOf(w.startAt, TZ)).toBe('09:00');
      expect(localTimeOf(w.endAt, TZ)).toBe('18:00');
      expect(w.priorityClass).toBe('fixed');
    }
  });

  it('keeps lunch as an allowed break inside work and never auto-plans the gym into work hours', () => {
    const lunches = events.filter((e) => e.kind === 'meal_lunch' && isoWeekday(e.localDate) <= 5);
    expect(lunches).toHaveLength(5);
    for (const l of lunches) expect(local(l).slice(11)).toBe('13:00–13:45');
    const gyms = events.filter((e) => e.kind === 'workout');
    expect(gyms).toHaveLength(2);
    for (const g of gyms) {
      const start = localTimeOf(g.startAt, TZ);
      expect(start >= '18:00').toBe(true);
    }
    expect(gyms.map((g) => g.localDate)).toEqual(['2026-11-03', '2026-11-05']); // preferred Tue/Thu
    expect(gyms.map((g) => localTimeOf(g.startAt, TZ))).toEqual(['21:00', '21:00']);
  });

  it('is idempotent: re-running with existing events creates nothing new', () => {
    const again = materializeWeek(prefs(), '2026-11-02', '2026-11-08', NOW_SUNDAY, events);
    expect(again.events).toHaveLength(0);
  });

  it('places own-project sessions in free evening windows without overlaps', () => {
    const projects = events.filter((e) => e.kind === 'own_project');
    expect(projects.length).toBe(3);
    for (const p of projects) {
      const clash = events.find(
        (e) => e.id !== p.id && e.kind !== 'sleep' && e.startAt < p.endAt && p.startAt < e.endAt,
      );
      expect(clash, `project ${local(p)} overlaps ${clash ? local(clash) : ''}`).toBeUndefined();
    }
  });
});

describe('PL-03 morning preparation', () => {
  it('does not schedule an 08:30 wake-up when 60 minutes are needed before 09:00', () => {
    const p = prefs({ wakeTime: '08:30', morningPrepMinutes: 60 });
    expect(workdayWake(p)).toBe('08:00');
    expect(checkMorning(p).ok).toBe(false);
    const { events } = materializeWeek(p, '2026-11-02', '2026-11-02', NOW_SUNDAY);
    const morning = events.find((e) => e.kind === 'morning_routine')!;
    expect(local(morning)).toBe('2026-11-02 08:00–09:00');
    const breakfast = events.find((e) => e.kind === 'meal_breakfast')!;
    expect(local(breakfast)).toBe('2026-11-02 08:40–09:00');
  });

  it('respects an earlier preferred wake time and uses the user value on weekends', () => {
    const p = prefs({ wakeTime: '07:30', morningPrepMinutes: 45, weekendWakeTime: '09:30' });
    const { events } = materializeWeek(p, '2026-11-06', '2026-11-07', NOW_SUNDAY);
    expect(local(events.find((e) => e.kind === 'morning_routine' && e.localDate === '2026-11-06')!)).toBe('2026-11-06 07:30–08:15');
    expect(local(events.find((e) => e.kind === 'morning_routine' && e.localDate === '2026-11-07')!)).toBe('2026-11-07 09:30–10:15');
  });
});

describe('PL-09 DST transitions keep local times and create no duplicates', () => {
  it('spring forward (28 March 2027) keeps 09:00 work and 21:00 gym local', () => {
    const now = lisbon('2027-03-21T20:00');
    const { events } = materializeWeek(prefs(), '2027-03-22', '2027-03-28', now);
    const work = events.filter((e) => e.kind === 'work');
    expect(work).toHaveLength(5);
    for (const w of work) expect(localTimeOf(w.startAt, TZ)).toBe('09:00');
    for (const g of events.filter((e) => e.kind === 'workout')) expect(localTimeOf(g.startAt, TZ)).toBe('21:00');
    const sleeps = events.filter((e) => e.kind === 'sleep');
    expect(new Set(sleeps.map((s) => s.localDate)).size).toBe(sleeps.length);
    // the night of Sat→Sun loses an hour in UTC but still ends at the local wake time
    const satNight = sleeps.find((s) => s.localDate === '2027-03-27')!;
    expect(localTimeOf(satNight.endAt, TZ)).toBe('08:00');
    expect(satNight.endAt.diff(satNight.startAt, 'hours').hours).toBe(7);
  });

  it('fall back (25 October 2026) keeps local times and keys unique', () => {
    const now = lisbon('2026-10-18T20:00');
    const { events } = materializeWeek(prefs(), '2026-10-19', '2026-10-25', now);
    const keys = events.map((e) => e.originKey);
    expect(new Set(keys).size).toBe(keys.length);
    const sunDinner = events.find((e) => e.kind === 'meal_dinner' && e.localDate === '2026-10-25')!;
    expect(local(sunDinner)).toBe('2026-10-25 19:30–20:15');
    const satNight = events.find((e) => e.kind === 'sleep' && e.localDate === '2026-10-24')!;
    expect(satNight.endAt.diff(satNight.startAt, 'hours').hours).toBe(9);
  });
});

function extraCtx(events: ReturnType<typeof materializeWeek>['events'], nowIso: string) {
  const p = prefs();
  return {
    now: lisbon(nowIso),
    tz: TZ,
    prefs: {
      workDays: p.workDays,
      workStart: p.workStart,
      workEnd: p.workEnd,
      bedTime: p.bedTime,
      overtimeWarnMinutes: p.overtimeWarnMinutes,
      gymTravelMinutes: p.gymTravelMinutes,
    },
    events,
  };
}

describe('«Нужно поработать» preview (PL-04, PL-05, PL-06, PL-10)', () => {
  const base = materializeWeek(prefs(), '2026-11-02', '2026-11-08', NOW_SUNDAY).events;

  it('PRD example: Tuesday +2 h → work 18:00–20:00, dinner kept within its window, gym unchanged', () => {
    const snapshot = JSON.stringify(base);
    const p = previewExtraWork({ date: '2026-11-03', startMode: 'after_work', durationMinutes: 120 }, extraCtx(base, '2026-11-03T17:55'));
    expect(JSON.stringify(base)).toBe(snapshot); // pure: nothing mutated (PL-04)
    expect(p.canCommit).toBe(true);
    expect(p.segments.map((s) => `${localTimeOf(s.startAt, TZ)}–${localTimeOf(s.endAt, TZ)}`)).toEqual(['18:00–20:00']);
    const dinner = p.changes.find((c) => c.kind === 'meal_dinner');
    expect(dinner?.action).toBe('move');
    expect(localTimeOf(dinner!.to!.startAt, TZ)).toBe('20:00');
    expect(p.changes.find((c) => c.kind === 'workout')).toBeUndefined();
    expect(p.protectedEventsPreserved).toBe(true);
    // the own-project block that sat at 18:30 is moved, not deleted
    const project = p.changes.find((c) => c.kind === 'own_project');
    if (project) expect(project.action).toBe('move');
  });

  it('PL-06: never cuts into sleep — reports a conflict with a shorter option', () => {
    const p = previewExtraWork({ date: '2026-11-03', startMode: 'after_work', durationMinutes: 480 }, extraCtx(base, '2026-11-03T17:55'));
    expect(p.canCommit).toBe(false);
    expect(p.conflicts[0]?.code).toBe('SLEEP_LIMIT');
    expect(p.conflicts[0]?.suggestedDurationMinutes).toBeGreaterThan(0);
    for (const s of p.segments) expect(s.endAt <= zoned('2026-11-04', '00:00', TZ).toISO()!).toBe(true);
    expect(p.changes.some((c) => c.kind === 'sleep' || (c.priorityClass === 'protected' && c.action === 'cancel'))).toBe(false);
  });

  it('pauses the work for dinner when dinner cannot move inside its window', () => {
    const p = previewExtraWork({ date: '2026-11-03', startMode: 'after_work', durationMinutes: 180 }, extraCtx(base, '2026-11-03T17:55'));
    expect(p.canCommit).toBe(true);
    expect(p.segments.map((s) => `${localTimeOf(s.startAt, TZ)}–${localTimeOf(s.endAt, TZ)}`)).toEqual(['18:00–19:30', '20:15–21:45']);
    expect(p.notes.some((n) => n.includes('Ужин'))).toBe(true);
  });

  it('PL-10: a displaced workout moves to another day of the same week and is not lost', () => {
    const p = previewExtraWork({ date: '2026-11-03', startMode: 'after_work', durationMinutes: 180 }, extraCtx(base, '2026-11-03T17:55'));
    const gym = p.changes.find((c) => c.kind === 'workout')!;
    expect(gym.action).toBe('move');
    expect(gym.to!.localDate > '2026-11-03').toBe(true);
    expect(gym.to!.localDate <= '2026-11-08').toBe(true);
    expect(['2026-11-04', '2026-11-06']).not.toContain(gym.to!.localDate); // not adjacent to Thursday's workout
    expect(localTimeOf(gym.to!.startAt, TZ) >= '18:00').toBe(true);
    expect(p.weeklyTargetRisks).toHaveLength(0);
  });

  it('reports an honest weekly-target risk when no day is left in the week', () => {
    const p = prefs({ gymDays: [7] });
    const { events } = materializeWeek({ ...p, targets: { ...p.targets, workouts: 1 } }, '2026-11-08', '2026-11-08', lisbon('2026-11-08T08:00'));
    const res = previewExtraWork({ date: '2026-11-08', startMode: 'now', durationMinutes: 240 }, extraCtx(events, '2026-11-08T18:00'));
    expect(res.canCommit).toBe(true);
    expect(res.requiresRiskAcknowledgement).toBe(true);
    expect(res.weeklyTargetRisks[0]?.message).toMatch(/недельная цель/);
  });

  it('does not plan time in the past: pressing after 18:00 starts now', () => {
    const p = previewExtraWork({ date: '2026-11-03', startMode: 'after_work', durationMinutes: 60 }, extraCtx(base, '2026-11-03T18:42'));
    expect(localTimeOf(p.segments[0]!.startAt, TZ)).toBe('18:45');
    expect(p.notes.join(' ')).toMatch(/уже прошло/);
  });

  it('adding work at 23:00 is limited by sleep at 00:00', () => {
    const p = previewExtraWork({ date: '2026-11-03', startMode: 'now', durationMinutes: 120 }, extraCtx(base, '2026-11-03T23:00'));
    expect(p.canCommit).toBe(false);
    expect(p.conflicts[0]?.suggestedDurationMinutes).toBe(60);
  });

  it('warns when weekly overtime exceeds the chosen threshold', () => {
    const p = previewExtraWork({ date: '2026-11-03', startMode: 'after_work', durationMinutes: 360 }, {
      ...extraCtx(base, '2026-11-03T17:55'),
      prefs: { ...extraCtx(base, '2026-11-03T17:55').prefs, overtimeWarnMinutes: 120 },
    });
    expect(p.warnings.join(' ')).toMatch(/порога/);
  });
});

describe('overnight sleep', () => {
  it('materialises the night that started yesterday when onboarding happens after midnight', () => {
    const { events } = materializeWeek(prefs(), '2026-11-02', '2026-11-02', lisbon('2026-11-02T00:41'));
    const sleep = events.filter((e) => e.kind === 'sleep');
    expect(sleep.map((s) => local(s))).toContain('2026-11-02 00:00–08:00');
  });
});
