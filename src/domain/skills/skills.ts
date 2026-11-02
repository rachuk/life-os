/**
 * «Навыки» — development without pretending time = mastery.
 * Level changes only through checkpoints (a real task + honest self-check against a rubric);
 * practice minutes are tracked separately. At most two skills are "active" at a time.
 */

export type SkillArea = 'language' | 'communication' | 'leadership' | 'professional' | 'other';
export type LevelScale = 'cefr' | 'five';
export type SkillStatus = 'active' | 'maintenance' | 'paused' | 'done';

export const MAX_ACTIVE_SKILLS = 2;

export const CEFR_LABELS: Record<number, string> = {
  1: 'A1 — отдельные фразы',
  2: 'A2 — простые бытовые ситуации',
  3: 'B1 — справляюсь в магазине, банке, у врача',
  4: 'B2 — свободно обсуждаю большинство тем',
  5: 'C1 — тонко и гибко, в том числе по работе',
  6: 'C2 — как носитель',
};

const FIVE_RUBRICS: Record<string, Record<number, string>> = {
  communication: {
    1: 'Теряюсь, мысль расплывается',
    2: 'Объясняю, но без структуры, много слов-паразитов',
    3: 'Говорю структурно в спокойной обстановке',
    4: 'Ясно и уверенно перед группой, держу паузы',
    5: 'Убеждаю и подстраиваю речь под аудиторию',
  },
  leadership: {
    1: 'Делаю сам, делегировать сложно',
    2: 'Делегирую простое, обратную связь откладываю',
    3: 'Регулярно делегирую и даю обратную связь',
    4: 'Веду сложные разговоры, решаю конфликты',
    5: 'Развиваю людей и устройство команды',
  },
  default: {
    1: 'Начинаю',
    2: 'Знаю основы',
    3: 'Уверенно применяю в обычных ситуациях',
    4: 'Справляюсь со сложными ситуациями',
    5: 'Могу учить других',
  },
};

export function levelLabel(scale: LevelScale, area: SkillArea, level: number): string {
  if (scale === 'cefr') return CEFR_LABELS[level] ?? `Уровень ${level}`;
  return (FIVE_RUBRICS[area] ?? FIVE_RUBRICS.default!)[level] ?? `Уровень ${level}`;
}

export function maxLevel(scale: LevelScale): number {
  return scale === 'cefr' ? 6 : 5;
}

export function shortLevel(scale: LevelScale, level: number): string {
  return scale === 'cefr' ? (['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'][level] ?? String(level)) : `${level}/5`;
}

export interface SkillPreset {
  key: string;
  title: string;
  area: SkillArea;
  scale: LevelScale;
  why: string;
  targetDescription: string;
  targetLevel: number;
  weeklyMinutes: number;
  sessionMinutes: number;
  practiceIdeas: string[];
  checkpointIdeas: string[];
}

export const SKILL_PRESETS: SkillPreset[] = [
  {
    key: 'pt',
    title: 'Португальский',
    area: 'language',
    scale: 'cefr',
    why: 'Уверенно общаться в Португалии',
    targetDescription: 'Магазины, клиники, банк, госучреждения, повседневные разговоры',
    targetLevel: 3,
    weeklyMinutes: 105,
    sessionMinutes: 15,
    practiceIdeas: ['Повторить карточки фраз', 'Диалог: запись к стоматологу', 'Послушать подкаст и пересказать', 'Написать сообщение соседке на португальском'],
    checkpointIdeas: ['Позвонить и записаться к врачу на португальском', '5 минут разговора без подсказок о своём дне'],
  },
  {
    key: 'en',
    title: 'Английский',
    area: 'language',
    scale: 'cefr',
    why: 'Свободнее проводить встречи и аргументировать решения',
    targetDescription: 'Встречи, обсуждение продукта, аргументация, повседневные темы',
    targetLevel: 4,
    weeklyMinutes: 60,
    sessionMinutes: 20,
    practiceIdeas: ['Голосом объяснить решение по задаче', 'Разобрать 10 новых выражений из встреч', 'Пересказать статью'],
    checkpointIdeas: ['3-минутная презентация идеи на английском', 'Провести встречу на английском и отметить, где было трудно'],
  },
  {
    key: 'speech',
    title: 'Речь и выступления',
    area: 'communication',
    scale: 'five',
    why: 'Говорить чётко, структурно и убедительно',
    targetDescription: 'Структура, паузы, меньше слов-паразитов',
    targetLevel: 4,
    weeklyMinutes: 40,
    sessionMinutes: 20,
    practiceIdeas: ['Записать 2 минуты о своей идее и переслушать', 'Структура «тезис — пример — вывод»', 'Пересказать сложную тему за 60 секунд'],
    checkpointIdeas: ['Записать 2-минутное выступление и разобрать структуру и паузы'],
  },
  {
    key: 'lead',
    title: 'Управление людьми',
    area: 'leadership',
    scale: 'five',
    why: 'Делегирование, обратная связь, мотивация, конфликты',
    targetDescription: 'Делегирование, обратная связь, найм, мотивация, конфликты',
    targetLevel: 4,
    weeklyMinutes: 40,
    sessionMinutes: 20,
    practiceIdeas: ['Разобрать одну управленческую ситуацию недели', 'Подготовить обратную связь по модели «ситуация — действие — влияние»', 'Прочитать главу и выписать 1 приём'],
    checkpointIdeas: ['Провести и разобрать разговор с обратной связью', 'Делегировать задачу с понятным результатом и проверить итог'],
  },
];

export function sessionsPerWeek(weeklyMinutes: number, sessionMinutes: number): number {
  if (weeklyMinutes <= 0 || sessionMinutes <= 0) return 0;
  return Math.min(7, Math.max(1, Math.round(weeklyMinutes / sessionMinutes)));
}

/** Level may only rise through a passed checkpoint; never above the scale or because of minutes. */
export function levelAfterCheckpoint(current: number, scale: LevelScale, passed: boolean, resultLevel: number | null): number {
  if (!passed || resultLevel === null) return current;
  return Math.min(maxLevel(scale), Math.max(current, resultLevel));
}

/** Enforce the "two active skills" mode: returns the status the new/updated skill may have. */
export function allowedStatus(requested: SkillStatus, activeCountExcludingThis: number): { status: SkillStatus; note: string | null } {
  if (requested !== 'active' || activeCountExcludingThis < MAX_ACTIVE_SKILLS) return { status: requested, note: null };
  return { status: 'maintenance', note: `Активных навыков уже ${MAX_ACTIVE_SKILLS} — этот поставлен на поддержку. Можно поменять акценты в следующем месяце.` };
}
