import { DEFAULT_WORKOUT_PLAN, EXERCISE_BY_KEY, suggestProgression, type Routine, type RoutineExercise } from './catalog';

/**
 * Session helpers for the workout log (PRD §10.2–10.3). Pure functions: which routine, what to
 * prefill for the next set, and whether a progression suggestion should be offered.
 */

export const FULL_BODY_KEY = 'full';

/** «Всё тело»: one movement per main pattern, lighter tools so it works in any gym. */
export const FULL_BODY_ROUTINE: Routine = {
  key: FULL_BODY_KEY,
  name: 'Всё тело',
  exercises: [
    { exerciseKey: 'goblet_squat', sets: 3, repsMin: 8, repsMax: 12 },
    { exerciseKey: 'db_bench_press', sets: 3, repsMin: 8, repsMax: 12 },
    { exerciseKey: 'lat_pulldown', sets: 3, repsMin: 8, repsMax: 12 },
    { exerciseKey: 'hip_thrust', sets: 3, repsMin: 8, repsMax: 12 },
    { exerciseKey: 'plank', sets: 2, repsMin: 30, repsMax: 45, unit: 'seconds' },
  ],
};

const SECONDS_EXERCISES = new Set(['plank']);

function isRoutineExercise(x: unknown): x is RoutineExercise {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.exerciseKey === 'string' &&
    !!EXERCISE_BY_KEY[r.exerciseKey] &&
    typeof r.sets === 'number' &&
    typeof r.repsMin === 'number' &&
    typeof r.repsMax === 'number'
  );
}

/** Routines stored as jsonb; invalid entries are dropped, an empty plan falls back to the default A/B. */
export function parseRoutines(json: unknown): Routine[] {
  if (!Array.isArray(json)) return DEFAULT_WORKOUT_PLAN.routines;
  const out: Routine[] = [];
  for (const r of json) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.name !== 'string' || !Array.isArray(o.exercises)) continue;
    const exercises = o.exercises.filter(isRoutineExercise);
    if (exercises.length) out.push({ key: o.key, name: o.name, exercises });
  }
  return out.length ? out : DEFAULT_WORKOUT_PLAN.routines;
}

export function resolveRoutine(routines: Routine[], key: string | null): Routine | null {
  if (!key) return null;
  if (key === FULL_BODY_KEY) return FULL_BODY_ROUTINE;
  return routines.find((r) => r.key === key) ?? null;
}

export function routineChoices(routines: Routine[]): Routine[] {
  return [...routines, FULL_BODY_ROUTINE];
}

/** Alternate A/B: suggest the routine after the last completed one. */
export function nextRoutineKey(routines: Routine[], lastKey: string | null): string {
  if (!routines.length) return FULL_BODY_KEY;
  const i = routines.findIndex((r) => r.key === lastKey);
  return routines[(i + 1) % routines.length]!.key;
}

export function exerciseUnit(exerciseKey: string, target?: RoutineExercise | null): 'reps' | 'seconds' {
  if (target?.unit) return target.unit;
  return SECONDS_EXERCISES.has(exerciseKey) ? 'seconds' : 'reps';
}

/** Target for an exercise: the session's routine first, then any routine that contains it. */
export function targetFor(exerciseKey: string, routines: Routine[], routineKey: string | null): RoutineExercise | null {
  const own = resolveRoutine(routines, routineKey)?.exercises.find((e) => e.exerciseKey === exerciseKey);
  if (own) return own;
  for (const r of routineChoices(routines)) {
    const e = r.exercises.find((x) => x.exerciseKey === exerciseKey);
    if (e) return e;
  }
  return null;
}

export interface SetLike {
  exerciseKey: string;
  setOrder: number;
  actualReps: number | null;
  weightKg: number | null;
  rpe: number | null;
}

/**
 * Values to prefill for the next set of an exercise:
 *  1. the last set already logged today (people usually repeat it);
 *  2. otherwise the same set number from the previous session, with an accepted progression weight
 *     replacing the old weight;
 *  3. otherwise the lower end of the target range and no weight.
 */
export function prefillSet(
  current: SetLike[],
  previous: SetLike[],
  target: RoutineExercise | null,
  acceptedWeightKg: number | null,
): { reps: number | null; weightKg: number | null } {
  const last = [...current].sort((a, b) => a.setOrder - b.setOrder).at(-1);
  if (last) return { reps: last.actualReps, weightKg: last.weightKg };
  const prevSorted = [...previous].sort((a, b) => a.setOrder - b.setOrder);
  const same = prevSorted[current.length] ?? prevSorted.at(-1);
  if (same) return { reps: same.actualReps ?? target?.repsMin ?? null, weightKg: acceptedWeightKg ?? same.weightKg };
  return { reps: target?.repsMin ?? null, weightKg: acceptedWeightKg };
}

export interface ProgressionOffer {
  exerciseKey: string;
  action: 'increase' | 'reduce' | 'keep';
  weightKg: number | null;
  message: string;
  basedOnSessionId: string;
}

/**
 * A suggestion is offered only from real logged sets of a completed session (never merely because
 * a workout was finished), and not again once the user answered it for that same session.
 */
export function progressionOffer(
  exerciseKey: string,
  basedOnSessionId: string,
  sets: SetLike[],
  target: RoutineExercise | null,
  answered: boolean,
): ProgressionOffer | null {
  if (!target || answered) return null;
  const s = suggestProgression(
    sets.filter((x) => x.exerciseKey === exerciseKey),
    target,
  );
  if (s.action === 'none') return null;
  return { exerciseKey, action: s.action, weightKg: s.weightKg, message: s.message, basedOnSessionId };
}
