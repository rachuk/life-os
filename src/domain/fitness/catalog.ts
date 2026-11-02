/**
 * Minimal self-written exercise catalog (PRD §10.2/10.4): short technique cues written for
 * Life OS, no copied third-party content or videos. Not medical advice.
 */
export interface Exercise {
  key: string;
  name: string;
  muscles: string;
  equipment: string;
  cues: string[];
  alternatives: string[];
}

export const EXERCISES: Exercise[] = [
  { key: 'squat', name: 'Приседания (со штангой или гантелью у груди)', muscles: 'бёдра, ягодицы, корпус', equipment: 'штанга / гантель', cues: ['Стопы на ширине плеч, носки немного наружу', 'Колени идут по направлению носков', 'Спина нейтральная, вес на всей стопе', 'Опускайся до комфортной глубины без боли'], alternatives: ['leg_press', 'goblet_squat'] },
  { key: 'goblet_squat', name: 'Гоблет-присед', muscles: 'бёдра, ягодицы', equipment: 'гантель / гиря', cues: ['Держи гантель у груди', 'Локти между коленями внизу', 'Корпус вертикально'], alternatives: ['squat', 'leg_press'] },
  { key: 'leg_press', name: 'Жим ногами', muscles: 'бёдра, ягодицы', equipment: 'тренажёр', cues: ['Поясница прижата к спинке', 'Не выпрямляй колени до щелчка', 'Контролируй опускание'], alternatives: ['squat'] },
  { key: 'bench_press', name: 'Жим лёжа', muscles: 'грудь, трицепс, плечи', equipment: 'штанга / гантели', cues: ['Лопатки сведены и прижаты к скамье', 'Гриф опускается к нижней части груди', 'Стопы упираются в пол', 'Со штангой — лучше со страхующим'], alternatives: ['db_bench_press', 'push_up'] },
  { key: 'db_bench_press', name: 'Жим гантелей лёжа', muscles: 'грудь, трицепс', equipment: 'гантели', cues: ['Локти под углом ~45° к корпусу', 'Плавно вниз, мощно вверх'], alternatives: ['bench_press', 'push_up'] },
  { key: 'push_up', name: 'Отжимания', muscles: 'грудь, трицепс, корпус', equipment: 'без оборудования', cues: ['Тело — прямая линия', 'Можно с колен или от опоры'], alternatives: ['db_bench_press'] },
  { key: 'row', name: 'Тяга гантели / штанги в наклоне', muscles: 'спина, бицепс', equipment: 'гантели / штанга', cues: ['Спина ровная, наклон из таза', 'Тяни локтем к поясу', 'Без рывков корпусом'], alternatives: ['cable_row'] },
  { key: 'cable_row', name: 'Горизонтальная тяга блока', muscles: 'спина', equipment: 'тренажёр', cues: ['Грудь вперёд, плечи вниз', 'Своди лопатки в конце'], alternatives: ['row'] },
  { key: 'rdl', name: 'Румынская тяга', muscles: 'задняя поверхность бедра, ягодицы', equipment: 'штанга / гантели', cues: ['Колени слегка согнуты', 'Таз уходит назад, спина ровная', 'Снаряд скользит близко к ногам'], alternatives: ['hip_thrust'] },
  { key: 'hip_thrust', name: 'Ягодичный мост', muscles: 'ягодицы', equipment: 'скамья / штанга', cues: ['Подбородок к груди', 'Вверху сожми ягодицы, не прогибай поясницу'], alternatives: ['rdl'] },
  { key: 'ohp', name: 'Жим над головой', muscles: 'плечи, трицепс', equipment: 'гантели / штанга', cues: ['Пресс и ягодицы напряжены', 'Не прогибайся в пояснице', 'Голова уходит вперёд, когда снаряд прошёл лицо'], alternatives: ['db_ohp'] },
  { key: 'db_ohp', name: 'Жим гантелей сидя', muscles: 'плечи', equipment: 'гантели', cues: ['Спина прижата к спинке', 'Локти немного вперёд'], alternatives: ['ohp'] },
  { key: 'lat_pulldown', name: 'Тяга верхнего блока / подтягивания', muscles: 'широчайшие, бицепс', equipment: 'тренажёр / турник', cues: ['Тяни к верхней части груди', 'Плечи опущены', 'Без раскачки'], alternatives: ['pull_up'] },
  { key: 'pull_up', name: 'Подтягивания', muscles: 'спина, бицепс', equipment: 'турник', cues: ['Можно с резинкой или в гравитроне'], alternatives: ['lat_pulldown'] },
  { key: 'lunge', name: 'Выпады', muscles: 'бёдра, ягодицы', equipment: 'гантели / без', cues: ['Шаг достаточно длинный', 'Колено задней ноги к полу', 'Корпус вертикально'], alternatives: ['split_squat'] },
  { key: 'split_squat', name: 'Сплит-присед', muscles: 'бёдра, ягодицы', equipment: 'гантели / без', cues: ['Стопы на месте, двигайся вверх-вниз'], alternatives: ['lunge'] },
  { key: 'plank', name: 'Планка', muscles: 'корпус', equipment: 'без оборудования', cues: ['Локти под плечами', 'Таз не проваливается', 'Дыши ровно'], alternatives: ['dead_bug'] },
  { key: 'dead_bug', name: '«Мёртвый жук»', muscles: 'корпус', equipment: 'коврик', cues: ['Поясница прижата к полу', 'Медленно разводи руку и ногу'], alternatives: ['plank'] },
];

export const EXERCISE_BY_KEY = Object.fromEntries(EXERCISES.map((e) => [e.key, e])) as Record<string, Exercise>;

export interface RoutineExercise {
  exerciseKey: string;
  sets: number;
  repsMin: number;
  repsMax: number;
  unit?: 'reps' | 'seconds';
}

export interface Routine {
  key: string;
  name: string;
  exercises: RoutineExercise[];
}

export const DEFAULT_WORKOUT_PLAN: { name: string; notes: string; routines: Routine[] } = {
  name: 'Всё тело A/B',
  notes: 'Чередуй A и B. Вес выбирай так, чтобы последние 1–2 повтора давались с усилием, но с правильной техникой. При боли — остановись.',
  routines: [
    {
      key: 'A',
      name: 'Тренировка A',
      exercises: [
        { exerciseKey: 'squat', sets: 3, repsMin: 8, repsMax: 10 },
        { exerciseKey: 'bench_press', sets: 3, repsMin: 8, repsMax: 10 },
        { exerciseKey: 'row', sets: 3, repsMin: 10, repsMax: 12 },
        { exerciseKey: 'rdl', sets: 3, repsMin: 8, repsMax: 10 },
        { exerciseKey: 'plank', sets: 3, repsMin: 30, repsMax: 45, unit: 'seconds' },
      ],
    },
    {
      key: 'B',
      name: 'Тренировка B',
      exercises: [
        { exerciseKey: 'leg_press', sets: 3, repsMin: 10, repsMax: 12 },
        { exerciseKey: 'ohp', sets: 3, repsMin: 8, repsMax: 10 },
        { exerciseKey: 'lat_pulldown', sets: 3, repsMin: 8, repsMax: 12 },
        { exerciseKey: 'lunge', sets: 3, repsMin: 8, repsMax: 10 },
        { exerciseKey: 'dead_bug', sets: 3, repsMin: 8, repsMax: 12 },
      ],
    },
  ],
};

/**
 * P1 progression rule (PRD §10.3), suggestion only: if every planned set reached the top of the
 * rep range with RPE ≤ 8 → suggest the smallest increment; if sets fell short → keep or reduce.
 * Never increases just because the workout was marked finished.
 */
export function suggestProgression(
  sets: { actualReps: number | null; weightKg: number | null; rpe: number | null }[],
  target: RoutineExercise,
  incrementKg = 2.5,
): { action: 'increase' | 'keep' | 'reduce' | 'none'; weightKg: number | null; message: string } {
  const done = sets.filter((s) => s.actualReps !== null);
  if (done.length < target.sets || target.unit === 'seconds') {
    return { action: 'none', weightKg: null, message: 'Недостаточно данных для рекомендации.' };
  }
  const weights = done.map((s) => s.weightKg ?? 0);
  const working = Math.max(...weights);
  const allTop = done.every((s) => (s.actualReps ?? 0) >= target.repsMax);
  const easy = done.every((s) => s.rpe === null || s.rpe <= 8);
  const missed = done.some((s) => (s.actualReps ?? 0) < target.repsMin);
  if (allTop && easy && working > 0) {
    return { action: 'increase', weightKg: working + incrementKg, message: `Все подходы в верхней границе — предлагаю попробовать ${working + incrementKg} кг. Можно отказаться.` };
  }
  if (missed) {
    return { action: working > 0 ? 'reduce' : 'keep', weightKg: working > 0 ? Math.max(0, working - incrementKg) : null, message: 'Часть подходов ниже диапазона — оставь вес или немного снизь, следи за восстановлением.' };
  }
  return { action: 'keep', weightKg: working || null, message: 'Оставь текущий вес, пока не выйдешь на верх диапазона во всех подходах.' };
}
