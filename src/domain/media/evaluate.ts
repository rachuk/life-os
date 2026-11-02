import type { MealPhoto, StepsScreenshot, WeightPhoto } from '@/server/ai/schemas';
import { formatDateRu, isLocalDate, type LocalDate } from '../time';

/**
 * Turn raw (schema-validated) AI image readings into cautious proposals (PRD §11.3–11.5, §11.8).
 * Pure functions: nothing here writes data. A proposal is never "proof" — the user confirms.
 *  - weight: low confidence / unreadable → manual entry (HEALTH-04);
 *  - steps: only a confident *daily* step count may be offered as a daily value; weekly/monthly
 *    totals, unknown periods, calories or distance are never offered as "steps for a day" (HEALTH-02);
 *  - meals: visible items only, no calories, never "eaten" (HEALTH-03).
 */

export const MIN_CONFIDENCE = 0.5;

export interface WeightProposal {
  kind: 'weight';
  readable: boolean;
  value: number | null;
  unit: 'kg';
  confidence: number;
  canSave: boolean;
  otherNumbersVisible: boolean;
  convertedFromLb: boolean;
  message: string;
  hints: string[];
}

export interface StepsProposal {
  kind: 'steps';
  readable: boolean;
  value: number | null;
  period: StepsScreenshot['period'];
  metric: StepsScreenshot['metric'];
  dateShown: string | null;
  /** validated date from the screenshot (≤ today), or null when unknown */
  suggestedDate: LocalDate | null;
  dateDiffers: boolean;
  confidence: number;
  /** true only for a confident daily step count */
  canSaveAsDaily: boolean;
  message: string;
  hints: string[];
}

export interface MealProposal {
  kind: 'meal';
  readable: boolean;
  detected: { name: string; confidence: number }[];
  possible: string[];
  notVisible: string[];
  portionNote: string | null;
  questions: string[];
  matchesPlan: MealPhoto['matchesPlan'];
  message: string;
}

export type MediaProposal = WeightProposal | StepsProposal | MealProposal;

const pct = (c: number) => `${Math.round(c * 100)}%`;
const LB_TO_KG = 0.45359237;

export function evaluateWeight(r: WeightPhoto): WeightProposal {
  const hints: string[] = [];
  let value = r.value;
  let convertedFromLb = false;
  if (value !== null && r.unit === 'lb') {
    value = Math.round(value * LB_TO_KG * 10) / 10;
    convertedFromLb = true;
    hints.push(`На весах фунты (${r.value} lb) — перевёл в килограммы.`);
  }
  if (value !== null && r.unit === null) hints.push('Единицы на фото не видны — считаю, что это килограммы.');
  if (r.otherNumbersVisible) hints.push('На фото есть и другие числа — проверь, что это именно вес.');
  if (r.note) hints.push(r.note);
  const inRange = value !== null && value >= 20 && value <= 400;
  const canSave = r.readable && inRange && r.confidence >= MIN_CONFIDENCE;
  const message = canSave
    ? `Распознал, проверь: ${value} кг (уверенность ${pct(r.confidence)}).`
    : 'Не могу уверенно прочитать число на фото. Введи вес вручную.';
  return { kind: 'weight', readable: r.readable, value: canSave ? value : null, unit: 'kg', confidence: r.confidence, canSave, otherNumbersVisible: r.otherNumbersVisible, convertedFromLb, message, hints };
}

export function evaluateSteps(r: StepsScreenshot, today: LocalDate): StepsProposal {
  const hints: string[] = [];
  const dateOk = !!r.dateIso && isLocalDate(r.dateIso) && r.dateIso <= today;
  const suggestedDate = dateOk ? r.dateIso : null;
  const readable = r.readable && r.value !== null && r.confidence >= MIN_CONFIDENCE;
  let message: string;
  let canSaveAsDaily = false;
  if (!readable) {
    message = 'Не могу уверенно прочитать число шагов на скриншоте. Введи значение вручную.';
  } else if (r.metric !== 'steps') {
    const what = r.metric === 'calories' ? 'калории' : r.metric === 'distance' ? 'расстояние' : 'другой показатель';
    message = `Похоже, на скриншоте ${what}, а не шаги — не сохраняю. Введи число шагов вручную.`;
  } else if (r.period === 'week' || r.period === 'month') {
    message = `Похоже, это сумма или среднее за ${r.period === 'week' ? 'неделю' : 'месяц'} (${r.value?.toLocaleString('ru-RU')}), а не за день — как дневное значение не сохраняю. Введи шаги за конкретный день.`;
  } else if (r.period === 'unknown') {
    message = 'Не понял, за какой период это число — как дневное значение не сохраняю. Укажи день и число вручную.';
  } else {
    canSaveAsDaily = true;
    message = suggestedDate
      ? `Распознал, проверь: ${r.value!.toLocaleString('ru-RU')} шагов за ${formatDateRu(suggestedDate)} (уверенность ${pct(r.confidence)}).`
      : `Распознал, проверь: ${r.value!.toLocaleString('ru-RU')} шагов за день (уверенность ${pct(r.confidence)}). Дату на скриншоте не вижу — выбери день.`;
  }
  if (r.dateIso && !dateOk) hints.push('Дата на скриншоте не распознана или в будущем — выбери день сам.');
  if (suggestedDate && suggestedDate !== today) hints.push(`Дата на скриншоте — ${formatDateRu(suggestedDate)}, не сегодня. Проверь день.`);
  if (r.note) hints.push(r.note);
  return {
    kind: 'steps',
    readable,
    value: readable ? r.value : null,
    period: r.period,
    metric: r.metric,
    dateShown: r.dateShown,
    suggestedDate,
    dateDiffers: !!suggestedDate && suggestedDate !== today,
    confidence: r.confidence,
    canSaveAsDaily,
    message,
    hints,
  };
}

export function evaluateMeal(r: MealPhoto): MealProposal {
  const readable = r.readable && r.detected.length > 0;
  return {
    kind: 'meal',
    readable,
    detected: r.detected,
    possible: r.possible,
    notVisible: r.notVisible,
    portionNote: r.portionNote,
    questions: r.questions.slice(0, 2),
    matchesPlan: r.matchesPlan,
    message: readable
      ? 'Распознал, проверь. Это только то, что видно на фото — отметь, сколько съел.'
      : 'Не могу разобрать еду на фото. Опиши словами, что было, и отметь, сколько съел.',
  };
}

/** Leading number of a user reply: "53,2", "53.2 кг", "8 500", "8500 вчера". Abbreviations like "8.5к" are not guessed. */
export function parseNumberInput(text: string): number | null {
  if (/^\s*\d+(?:[.,]\d+)?\s*[кkКK](?![гgГG])/u.test(text)) return null; // "8.5к" — ambiguous shorthand
  const m = text.trim().match(/^(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,](\d+))?/);
  if (!m) return null;
  const int = m[1]!.replace(/[  ]/g, '');
  const v = Number(m[2] ? `${int}.${m[2]}` : int);
  return Number.isFinite(v) ? v : null;
}
