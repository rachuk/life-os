import { z, type ZodType } from 'zod';
import { parseResultSchema, proposedActionSchema, TASK_CATEGORIES, type ParseResult } from '@/domain/capture/schema';
import { env } from '../env';
import {
  mealPhotoSchema,
  stepsScreenshotSchema,
  weeklyInsightsSchema,
  weightPhotoSchema,
  type MealPhoto,
  type StepsScreenshot,
  type WeeklyInsights,
  type WeightPhoto,
} from './schemas';

/**
 * AIProvider (PRD §15.1, §18): isolated, server-only, swappable. The default implementation talks
 * to any OpenAI-compatible endpoint (OpenAI, a local Ollama, a whisper.cpp server). Models only
 * suggest; every output is schema-validated and confirmed by the user before it changes data.
 */

export interface IntentContext {
  nowLocal: string; // 'YYYY-MM-DD HH:mm, weekday'
  timezone: string;
  gymWindow: string;
}

export interface ImageContext {
  todayLocal: string;
  plannedMeal?: string | null;
  knownRestrictions?: string[] | null;
}

export interface AIProvider {
  readonly name: string;
  canTranscribe(): boolean;
  canParse(): boolean;
  canSee(): boolean;
  transcribe(audio: Buffer, mime: string, filename: string, languageHint?: string | null): Promise<{ text: string; language: string | null }>;
  parseIntent(text: string, ctx: IntentContext): Promise<ParseResult>;
  analyzeWeight(image: Buffer, mime: string, ctx: ImageContext): Promise<WeightPhoto>;
  analyzeSteps(image: Buffer, mime: string, ctx: ImageContext): Promise<StepsScreenshot>;
  analyzeMeal(image: Buffer, mime: string, ctx: ImageContext): Promise<MealPhoto>;
  weeklyInsights(facts: unknown): Promise<WeeklyInsights>;
}

export class AIError extends Error {
  constructor(
    public code: 'NOT_CONFIGURED' | 'TIMEOUT' | 'HTTP' | 'INVALID_OUTPUT' | 'BUDGET',
    message: string,
  ) {
    super(message);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new AIError('TIMEOUT', 'ИИ не ответил вовремя');
    throw new AIError('HTTP', `Сервис ИИ недоступен: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new AIError('INVALID_OUTPUT', 'ИИ вернул не JSON');
  }
}

const PARSE_INSTRUCTIONS = `Ты разбираешь короткие личные сообщения (русский, украинский, английский, смешанные) на ПРЕДЛАГАЕМЫЕ действия для личного планировщика.
Правила:
- Верни только JSON по схеме. Неизвестное — тип "note". Ничего не выдумывай: если даты нет — dateLocal = null; не превращай отсутствие срока в «завтра».
- Даты считай от текущего момента пользователя (дано ниже). Формат dateLocal YYYY-MM-DD, timeLocal HH:mm (24ч) или null.
- Если дата/время неоднозначны («в следующий четверг», «вечером», «в 9» без утра/вечера) — needsConfirmation=true и объясни в reason.
- Для каждого действия заполни sourceText — фрагмент исходного текста.
- Типы: create_task (taskType task|reminder), create_waiting, add_shopping_item (каждый товар отдельно), log_weight (кг), log_steps, log_meal (всегда needsConfirmation=true), schedule_workout (needsConfirmation=true), extra_work (durationMinutes, needsConfirmation=true), idea, note.
- Не создавай удаление, переводы денег, покупки в магазинах — таких действий нет.
- Рабочие задачи без названий клиентов и секретов; категорию work_reminder ставь только если явно про работу.`;

function jsonSchemaFor(name: string): Record<string, unknown> {
  // compact JSON schema mirroring the zod contracts (the server re-validates with zod anyway)
  const nullableStr = { type: ['string', 'null'] };
  if (name === 'parse') {
    return {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['ru', 'uk', 'en', 'mixed', 'unknown'] },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['create_task', 'create_waiting', 'add_shopping_item', 'log_weight', 'log_steps', 'log_meal', 'schedule_workout', 'extra_work', 'idea', 'note'] },
              title: nullableStr,
              text: nullableStr,
              taskType: { type: ['string', 'null'], enum: ['task', 'reminder', null] },
              category: { type: ['string', 'null'], enum: [...TASK_CATEGORIES, null] },
              dateLocal: nullableStr,
              timeLocal: nullableStr,
              followUpDate: nullableStr,
              waitingFor: nullableStr,
              quantity: { type: ['number', 'null'] },
              unit: nullableStr,
              listType: { type: ['string', 'null'], enum: ['personal', 'household', null] },
              value: { type: ['number', 'null'] },
              slot: { type: ['string', 'null'], enum: ['breakfast', 'lunch', 'dinner', 'snack', null] },
              description: nullableStr,
              durationMinutes: { type: ['number', 'null'] },
              sourceText: { type: 'string' },
              needsConfirmation: { type: 'boolean' },
              reason: nullableStr,
            },
            required: ['type', 'sourceText', 'needsConfirmation'],
          },
        },
      },
      required: ['language', 'actions'],
    };
  }
  return { type: 'object' };
}

const ENUMS: Record<string, readonly string[]> = {
  taskType: ['task', 'reminder'],
  category: TASK_CATEGORIES,
  listType: ['personal', 'household'],
  priority: ['low', 'normal', 'high'],
  unit: ['kg'],
};

/**
 * Models sometimes invent enum values ("groceries", "tasks"). Normalise softly: drop nulls and
 * out-of-contract enum values (the zod defaults apply), then validate each action on its own so one
 * odd action never discards the rest. Nothing invalid ever reaches the user unvalidated.
 */
function cleanActions(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as { language?: unknown; actions?: Record<string, unknown>[] };
  if (!Array.isArray(r.actions)) return raw;
  const actions = r.actions.flatMap((a) => {
    if (!a || typeof a !== 'object') return [];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      if (v === null || v === undefined) continue;
      if (k in ENUMS && !(ENUMS[k] as readonly unknown[]).includes(v) && !(k === 'category' && a.type === 'idea')) continue;
      out[k] = v;
    }
    if (a.type === 'log_weight') out.unit = 'kg';
    if (a.type === 'idea' && !['idea', 'wish', 'own_project'].includes(String(a.category))) delete out.category;
    for (const k of ['dateLocal', 'timeLocal', 'followUpDate', 'quantity', 'unit', 'waitingFor']) if (k in a && a[k] === null) out[k] = null;
    if ('reason' in a && a.reason === null) out.reason = null;
    const one = proposedActionSchema.safeParse(out);
    return one.success ? [one.data] : [];
  });
  const language = ['ru', 'uk', 'en', 'mixed', 'unknown'].includes(String(r.language)) ? r.language : 'unknown';
  if (!actions.length && r.actions.length) throw new AIError('INVALID_OUTPUT', 'Ответ ИИ не прошёл проверку схемы');
  return { language, actions };
}

/** Map common synonyms models use for enum fields of the image contracts; unknown → neutral value. */
function normalizeImage(kind: string, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const low = (v: unknown) => String(v ?? '').toLowerCase();
  if (typeof o.value === 'string') o.value = Number(String(o.value).replace(',', '.').replace(/[^\d.]/g, '')) || null;
  if (typeof o.confidence === 'string') o.confidence = Number(o.confidence) || 0;
  if (kind === 'weight') {
    const u = low(o.unit);
    o.unit = u.startsWith('k') || u.startsWith('к') ? 'kg' : u.startsWith('lb') || u.startsWith('pound') ? 'lb' : null;
  }
  if (kind === 'steps') {
    const pr = low(o.period);
    o.period = /day|daily|день|сут/.test(pr) ? 'day' : /week|недел/.test(pr) ? 'week' : /month|месяц/.test(pr) ? 'month' : 'unknown';
    const m = low(o.metric);
    o.metric = /step|шаг/.test(m) ? 'steps' : /dist|км|km/.test(m) ? 'distance' : /cal|кал/.test(m) ? 'calories' : 'other';
  }
  if (kind === 'meal') {
    const mp = low(o.matchesPlan);
    o.matchesPlan = ['yes', 'partly', 'no'].includes(mp) ? mp : 'unknown';
    for (const k of ['possible', 'notVisible', 'questions']) if (!Array.isArray(o[k])) o[k] = [];
    if (!Array.isArray(o.detected)) o.detected = [];
  }
  return o;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  private llmBase: string | undefined;
  private transcribeBase: string | undefined;

  constructor() {
    const e = env();
    this.llmBase = e.AI_LLM_BASE_URL ?? (e.AI_LLM_API_KEY ? 'https://api.openai.com/v1' : undefined);
    this.transcribeBase = e.AI_TRANSCRIBE_BASE_URL ?? (e.AI_TRANSCRIBE_API_KEY ? 'https://api.openai.com/v1' : undefined);
    this.name = this.llmBase?.includes('openai.com') ? 'openai' : this.llmBase ? 'openai-compatible' : 'none';
  }

  canTranscribe() {
    return env().ENABLE_AI_VOICE && !!this.transcribeBase;
  }
  canParse() {
    return env().ENABLE_AI_INTENT && !!this.llmBase && !!env().AI_LLM_MODEL;
  }
  canSee() {
    return env().ENABLE_AI_IMAGES && !!this.llmBase && !!env().AI_VISION_MODEL;
  }

  private headers(key?: string): Record<string, string> {
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  async transcribe(audio: Buffer, mime: string, filename: string, languageHint?: string | null) {
    if (!this.canTranscribe()) throw new AIError('NOT_CONFIGURED', 'Распознавание голоса не подключено');
    const e = env();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), filename);
    form.append('model', e.AI_TRANSCRIBE_MODEL);
    form.append('response_format', 'json');
    if (languageHint) form.append('language', languageHint);
    const res = await fetchWithTimeout(
      `${this.transcribeBase!.replace(/\/$/, '')}/audio/transcriptions`,
      { method: 'POST', headers: this.headers(e.AI_TRANSCRIBE_API_KEY), body: form },
      e.AI_TIMEOUT_MS,
    );
    if (!res.ok) throw new AIError('HTTP', `Распознавание голоса: HTTP ${res.status}`);
    const body = (await res.json()) as { text?: string; language?: string };
    const text = (body.text ?? '').trim();
    if (!text) throw new AIError('INVALID_OUTPUT', 'Не удалось распознать речь');
    return { text, language: body.language ?? null };
  }

  private async chatJson<T>(opts: {
    model: string;
    system: string;
    user: string;
    image?: { data: Buffer; mime: string };
    schema: ZodType<T>;
    schemaName: string;
  }): Promise<T> {
    const e = env();
    const content: unknown = opts.image
      ? [
          { type: 'text', text: opts.user },
          { type: 'image_url', image_url: { url: `data:${opts.image.mime};base64,${opts.image.data.toString('base64')}` } },
        ]
      : opts.user;
    const body = {
      model: opts.model,
      temperature: 0,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
    };
    const res = await fetchWithTimeout(
      `${this.llmBase!.replace(/\/$/, '')}/chat/completions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.headers(e.AI_LLM_API_KEY) }, body: JSON.stringify(body) },
      e.AI_TIMEOUT_MS,
    );
    if (!res.ok) throw new AIError('HTTP', `ИИ: HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content ?? '';
    const parsed = opts.schemaName === 'parse' ? cleanActions(extractJson(text)) : normalizeImage(opts.schemaName, extractJson(text));
    const result = opts.schema.safeParse(parsed);
    if (!result.success) throw new AIError('INVALID_OUTPUT', 'Ответ ИИ не прошёл проверку схемы');
    return result.data;
  }

  async parseIntent(text: string, ctx: IntentContext): Promise<ParseResult> {
    if (!this.canParse()) throw new AIError('NOT_CONFIGURED', 'ИИ-разбор не подключён');
    return this.chatJson({
      model: env().AI_LLM_MODEL!,
      system: `${PARSE_INSTRUCTIONS}\nСхема JSON: ${JSON.stringify(jsonSchemaFor('parse'))}`,
      user: `Сейчас у пользователя: ${ctx.nowLocal} (${ctx.timezone}). Предпочтительное окно тренировок: ${ctx.gymWindow}.\nСообщение:\n"""${text.slice(0, 4000)}"""`,
      schema: parseResultSchema,
      schemaName: 'parse',
    });
  }

  async analyzeWeight(image: Buffer, mime: string, ctx: ImageContext) {
    if (!this.canSee()) throw new AIError('NOT_CONFIGURED', 'Распознавание фото не подключено');
    return this.chatJson({
      model: env().AI_VISION_MODEL!,
      system:
        'Ты читаешь число на дисплее напольных весов. Верни JSON {readable, value, unit("kg"|"lb"|null), confidence 0..1, otherNumbersVisible, note}. Если цифры не читаются уверенно — readable=false, value=null. Не угадывай.',
      user: `Сегодня ${ctx.todayLocal}. Прочитай показание весов.`,
      image: { data: image, mime },
      schema: weightPhotoSchema,
      schemaName: 'weight',
    });
  }

  async analyzeSteps(image: Buffer, mime: string, ctx: ImageContext) {
    if (!this.canSee()) throw new AIError('NOT_CONFIGURED', 'Распознавание фото не подключено');
    return this.chatJson({
      model: env().AI_VISION_MODEL!,
      system:
        'Ты читаешь скриншот Apple Health / фитнес-приложения. Верни JSON {readable, value, period("day"|"week"|"month"|"unknown"), dateShown, dateIso, metric("steps"|"distance"|"calories"|"other"), confidence, note}. Убедись, что число — шаги, а не калории или расстояние, и за какой период (день/неделя/среднее). Если не уверен — period="unknown" и низкая confidence.',
      user: `Сегодня ${ctx.todayLocal}. Определи число шагов, период и дату.`,
      image: { data: image, mime },
      schema: stepsScreenshotSchema,
      schemaName: 'steps',
    });
  }

  async analyzeMeal(image: Buffer, mime: string, ctx: ImageContext) {
    if (!this.canSee()) throw new AIError('NOT_CONFIGURED', 'Распознавание фото не подключено');
    const restrictions = ctx.knownRestrictions?.length ? ctx.knownRestrictions.join(', ') : 'неизвестны (не делай вывод, что их нет)';
    return this.chatJson({
      model: env().AI_VISION_MODEL!,
      system:
        'Ты описываешь фото еды. Верни JSON {readable, detected[{name, confidence}], possible[], notVisible[], portionNote, questions[<=2], matchesPlan("yes"|"partly"|"no"|"unknown"), note}. НЕ оценивай калории, граммы и макросы. Не ставь диагнозов. Не утверждай, что еда съедена. Вопросы — только если важно (например, было ли масло).',
      user: `Сегодня ${ctx.todayLocal}. Запланировано: ${ctx.plannedMeal ?? 'не указано'}. Пищевые ограничения: ${restrictions}.`,
      image: { data: image, mime },
      schema: mealPhotoSchema,
      schemaName: 'meal',
    });
  }

  async weeklyInsights(facts: unknown) {
    if (!this.canParse()) throw new AIError('NOT_CONFIGURED', 'ИИ не подключён');
    return this.chatJson({
      model: env().AI_LLM_MODEL!,
      system:
        'Ты — спокойный помощник по распорядку. Тебе даны ТОЛЬКО агрегированные факты недели, посчитанные сервером. Верни JSON {summary, observations[{text, basedOn}], suggestions[{text, why}]}. Не выдумывай чисел, которых нет в фактах; «нет данных» не равно нулю. Без диагнозов, без категоричной причинности («чаще», «совпало» вместо «из-за»). Не советуй сокращать сон, не предлагай снижать тренировки только из-за переносов. По-русски.',
      user: JSON.stringify(facts).slice(0, 12000),
      schema: weeklyInsightsSchema,
      schemaName: 'weekly',
    });
  }
}

let provider: AIProvider | null = null;
export function aiProvider(): AIProvider {
  provider ??= new OpenAICompatibleProvider();
  return provider;
}
/** Tests inject a fake provider. */
export function setAIProvider(p: AIProvider | null): void {
  provider = p;
}

export const _test = { extractJson, cleanActions, z };
