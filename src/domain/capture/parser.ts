import type { DateTime } from 'luxon';
import type { LocalTime } from '../time';
import { addDays } from '../time';
import { disambiguateHour, normalizeText, NUMBER_WORDS, resolveDateTime, type DateMatch } from './dates';
import { rx } from './rx';
import type { ParseResult, ProposedAction } from './schema';
import { parseResultSchema } from './schema';

/**
 * Deterministic rule-based capture parser (works with no AI key). It splits a mixed message into
 * clauses, classifies each clause and resolves dates relative to the real message time.
 * Anything it is not sure about is flagged `needsConfirmation` with a human reason; anything it
 * does not understand becomes an inbox note — never a guessed task with an invented deadline.
 */

export interface ParseContext {
  now: DateTime;
  tz: string;
  gymWindow?: { earliest: LocalTime; latest: LocalTime };
}

const COMMAND_START = rx(
  String.raw`^(?:еще|ещё|также|а также|потом|и|also|then|plus|ще|також|а ще|і|та)?\s*(?:напомн\w*|нагада\w*|remind|купи\w*|закаж\w*|заказ\w*|докуп\w*|добав\w*|додай|buy|order|придба\w*|запиш\w*|записат\w*|позвон\w*|подзвон\w*|call|напис\w*|write|email|сдела\w*|зроби\w*|надо|нужно|треба|потрібно|need|хочу|хочеться|want|подума\w*|think|оплат\w*|pay|забра\w*|отправ\w*|відправ\w*|send|сходи\w*|піти|пойти|go|вес\b|вешу|вага|важу|weight|шаг\w*|кроки|кроків|steps|съел|поел|позавтракал|пообедал|поужинал|перекусил|поснідав|пообідав|повечеряв|з'?їв|ate|жду|чекаю|waiting|идея|ідея|idea|в зал|зал|тренировк\w*|gym)`,
);

const SPLIT_CONNECTORS = rx(String.raw`\s+(?:и|а также|также|еще|ещё|потом|and|also|then|та|і|й|а ще|ще|також)\s+`);

function splitOnConnectors(p: string): string[] {
  const re = new RegExp(SPLIT_CONNECTORS.source, 'gu');
  const pieces: string[] = [];
  let last = 0;
  for (const m of p.matchAll(re)) {
    const idx = m.index ?? 0;
    const right = p.slice(idx + m[0].length);
    if (COMMAND_START.test(normalizeText(right)) && p.slice(last, idx).trim()) {
      pieces.push(p.slice(last, idx).trim());
      last = idx + m[0].length;
    }
  }
  pieces.push(p.slice(last).trim());
  return pieces.filter(Boolean);
}

function splitClauses(text: string): string[] {
  return text
    .split(/[\n;]+|(?<=[.!?])\s+/u)
    .flatMap((p) => p.split(/\s*(?:(?<!\d),|,(?!\d))\s*/u))
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(splitOnConnectors)
    .map((c) => c.replace(/^[-–—•*]\s*/u, '').replace(/[.!?]+$/u, '').trim())
    .filter(Boolean);
}

function cap(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

function stripFragments(text: string, fragments: string[]): string {
  let out = ` ${text} `;
  for (const f of fragments) {
    if (!f.trim()) continue;
    const idx = out.toLowerCase().replace(/ё/g, 'е').indexOf(f.trim());
    if (idx >= 0) out = out.slice(0, idx) + ' ' + out.slice(idx + f.trim().length);
  }
  return out.replace(/\s+/g, ' ').trim();
}

const TRIGGERS_TASK = rx(
  String.raw`^(?:(?:пожалуйста|please|будь ласка)\s+)?(?:напомни(?:те)?(?:\s+мне)?|напомнить(?:\s+мне)?|нагадай(?:\s+мені)?|remind me(?:\s+to\b)?|remind|надо|нужно|мне нужно|мне надо|треба|потрібно|мені треба|need to|i need to|have to|todo|сделать|зробити)\s+`,
);
const TRIGGERS_SHOP = rx(
  String.raw`(?:^|\s)(?:купить|купи|купити|закажи|заказать|докупить|докупи|придбати|buy|order|get)\s+|\s*(?:в|у|to|into)\s+(?:список(?:\s+покупок)?|покупки|корзину|кошик|shopping list|list)\b|^(?:добавь|додай|add)\s+`,
);

const CATEGORY_RULES: [RegExp, string][] = [
  [rx(String.raw`стоматолог|зуб|чистк\w* зуб|врач|доктор|терапевт|анализ|клиник|лікар|аналіз|dentist|doctor|clinic|аптек|pharmacy`), 'health'],
  [rx(String.raw`страхов\w*|ипотек\w*|іпотек\w*|брокер\w*|банк\w*|налог\w*|податк\w*|оплат\w*|счет|рахун\w*|кредит\w*|insurance|mortgage|tax|invoice|broker|bank`), 'finance'],
  [rx(String.raw`уборк\w*|прибра\w*|стирк\w*|ремонт\w*|квартир\w*|сантехн\w*|cleaning|laundry|repair`), 'household'],
  [rx(String.raw`созвон\w*|отчет\w*|отчёт\w*|звіт\w*|дедлайн\w*|релиз\w*|ревью|code review|deploy|jira|клиент\w*|задач\w* по работе|рабоч\w*|робоч\w*|work task`), 'work_reminder'],
  [rx(String.raw`(?:сво\w*|мо\w*|own|side)\s+проект\w*|pet project|side project`), 'own_project'],
];

function detectCategory(text: string): string {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(text)) return cat;
  return 'personal';
}

function parseDurationMinutes(t: string): number | null {
  const nw = Object.keys(NUMBER_WORDS).join('|');
  if (rx(String.raw`\b(полчаса|півгодини|half an hour|30 ?мин\w*|30 ?хв\w*|30 ?min\w*)\b`).test(t)) return 30;
  if (rx(String.raw`\b(полтора часа|півтори години|an hour and a half|1[.,]5 ?(ч|час\w*|h|hours?|год\w*))\b`).test(t)) return 90;
  const h = t.match(rx(`(\\d+(?:[.,]\\d+)?|${nw})\\s*(?:ч|час|часа|часов|h|hr|hrs|hours?|год|години|годин|годину)\\b`));
  if (h) {
    const raw = h[1]!.replace(',', '.');
    const n = Number.isFinite(Number(raw)) ? Number(raw) : (NUMBER_WORDS[raw] ?? null);
    if (n) return Math.round(n * 60);
  }
  const mm = t.match(rx(String.raw`(\d+)\s*(?:мин|минут\w*|m|min|mins|minutes|хв|хвилин\w*)\b`));
  if (mm) return Number(mm[1]);
  if (rx(String.raw`\b(час|годину|an hour)\b`).test(t)) return 60;
  return null;
}

const UNIT_MAP: Record<string, string> = {
  л: 'л', литр: 'л', литра: 'л', литров: 'л', l: 'л', liter: 'л', litre: 'л',
  мл: 'мл', ml: 'мл',
  кг: 'кг', kg: 'кг', кило: 'кг',
  г: 'г', гр: 'г', g: 'г', грамм: 'г', граммов: 'г',
  шт: 'шт', штук: 'шт', штуки: 'шт', pcs: 'шт',
  уп: 'уп', упаковка: 'уп', упаковки: 'уп', пачка: 'уп', пачки: 'уп', pack: 'уп',
  бут: 'бут', бутылка: 'бут', бутылки: 'бут', bottle: 'бут',
};

export function parseShoppingItem(raw: string): { title: string; quantity: number | null; unit: string | null } {
  let t = raw.trim().replace(/\s+/g, ' ');
  let quantity: number | null = null;
  let unit: string | null = null;
  const unitRe = Object.keys(UNIT_MAP)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const pre = t.match(rx(`^(\\d+(?:[.,]\\d+)?)\\s*(${unitRe})?\\.?\\s+(.+)$`, 'i'));
  const post = t.match(rx(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*(${unitRe})?\\.?$`, 'i'));
  if (pre) {
    quantity = Number(pre[1]!.replace(',', '.'));
    unit = pre[2] ? (UNIT_MAP[pre[2].toLowerCase()] ?? null) : null;
    t = pre[3]!;
  } else if (post) {
    quantity = Number(post[2]!.replace(',', '.'));
    unit = post[3] ? (UNIT_MAP[post[3].toLowerCase()] ?? null) : null;
    t = post[1]!;
  }
  if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0)) quantity = null;
  return { title: cap(t), quantity, unit };
}

function splitItems(text: string): string[] {
  return text
    .split(rx(String.raw`\s*(?:,|\s+и\s+|\s+and\s+|\s+та\s+|\s+і\s+|\s+й\s+|\+)\s*`))
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 120);
}

function dateFields(dm: DateMatch, fallbackDate: string | null = null) {
  return { dateLocal: dm.date ?? fallbackDate, timeLocal: dm.time };
}

function classify(clause: string, ctx: ParseContext, prev: ProposedAction | null): ProposedAction[] {
  const t = normalizeText(clause);
  const today = ctx.now.setZone(ctx.tz).toISODate()!;
  const dm = resolveDateTime(clause, ctx.now, ctx.tz);
  const reasons = [...dm.reasons];

  // extra work
  if (rx(String.raw`(нужно|надо|треба|потрібно|need to|have to|придется|прийдеться)\s+(ещ[её]\s+)?(по)?(работ|попрацю|work)\w*|переработ\w*|сверхуроч\w*|overtime|work late|попрацювати`).test(t)) {
    const minutes = parseDurationMinutes(t);
    if (minutes) {
      return [
        {
          type: 'extra_work',
          durationMinutes: Math.min(480, Math.max(15, minutes)),
          dateLocal: dm.date ?? today,
          sourceText: clause,
          needsConfirmation: true,
          reason: 'Покажу предпросмотр перестройки — подтверди перед записью',
        },
      ];
    }
  }

  // weight
  const w = t.match(rx(String.raw`(?:вес|вешу|вага|важу|weight|weigh\w*)\D{0,12}?(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg|кило)?`));
  if (w) {
    const v = Number(w[1]!.replace(',', '.'));
    if (v >= 20 && v <= 400) {
      return [
        {
          type: 'log_weight',
          value: v,
          unit: 'kg',
          dateLocal: dm.date ?? today,
          sourceText: clause,
          needsConfirmation: !!dm.ambiguous,
          reason: reasons[0] ?? null,
        },
      ];
    }
  }

  // steps
  const s1 = t.match(rx(String.raw`(\d[\d\s]{1,7}\d|\d{3,6})\s*(?:шаг\w*|кроків|кроки|крок\w*|steps)`));
  const s2 = t.match(rx(String.raw`(?:шаг\w*|кроки|кроків|steps)\D{0,10}(\d[\d\s]{1,7}\d|\d{3,6})`));
  const sv = s1?.[1] ?? s2?.[1];
  if (sv) {
    const v = Number(sv.replace(/\s/g, ''));
    if (Number.isInteger(v) && v >= 0 && v <= 150000) {
      return [
        {
          type: 'log_steps',
          value: v,
          dateLocal: dm.date ?? today,
          sourceText: clause,
          needsConfirmation: !dm.date || !!dm.ambiguous,
          reason: !dm.date ? 'Проверь, за какой день шаги' : (reasons[0] ?? null),
        },
      ];
    }
  }

  // meal log
  const meal = t.match(
    rx(String.raw`^(?:я\s+)?(позавтракал\w*|поснідав\w*|had breakfast|пообедал\w*|пообідав\w*|had lunch|поужинал\w*|повечеряв\w*|had dinner|перекусил\w*|перекусив\w*|snacked|съел\w*|поел\w*|з'?їв\w*|ate|eaten)\s*(.*)$`),
  );
  if (meal) {
    const verb = meal[1]!;
    const slot = /завтрак|сніда|breakfast/.test(verb)
      ? 'breakfast'
      : /обед|обіда|lunch/.test(verb)
        ? 'lunch'
        : /ужин|вечеря|dinner/.test(verb)
          ? 'dinner'
          : /перекус|snack/.test(verb)
            ? 'snack'
            : null;
    const hour = ctx.now.setZone(ctx.tz).hour;
    const guessed = slot ?? (hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner');
    return [
      {
        type: 'log_meal',
        slot: guessed,
        description: cap(stripFragments(meal[2] ?? '', dm.consumed)),
        dateLocal: dm.date ?? today,
        sourceText: clause,
        needsConfirmation: true,
        reason: slot ? 'Подтверди, что съел — только тогда запись будет отмечена' : 'Проверь, какой это приём пищи',
      },
    ];
  }

  // workout
  if (rx(String.raw`(?:^|\s)(в\s+зал|у\s+зал|зал\b|спортзал\w*|тренировк\w*|тренуван\w*|gym|workout|качалк\w*)`).test(t)) {
    let time = dm.time;
    const win = ctx.gymWindow ?? { earliest: '18:00', latest: '23:00' };
    if (dm.ambiguousHour !== null) time = disambiguateHour(dm.ambiguousHour, win.earliest, win.latest);
    return [
      {
        type: 'schedule_workout',
        title: 'Тренировка',
        dateLocal: dm.date,
        timeLocal: time,
        sourceText: clause,
        needsConfirmation: true,
        reason: !dm.date ? 'Укажи день тренировки' : 'Проверь время и конфликт с планом — тренировка не бронируется автоматически',
      },
    ];
  }

  // past-tense statement ("отправил письмо брокеру") — a fact, not a task
  if (rx(String.raw`^(?:я\s+)?(отправил\w*|написал\w*|позвонил\w*|сделал\w*|відправив\w*|написав\w*|подзвонив\w*|зробив\w*|sent|wrote|called|emailed)\b`).test(t) && !rx(String.raw`\b(жду|ждать|чекаю|waiting)\b`).test(t)) {
    return [{ type: 'note', text: cap(clause), sourceText: clause, needsConfirmation: false, reason: 'Похоже на отметку о сделанном — сохраню во входящие' }];
  }

  // waiting for an answer
  if (rx(String.raw`\b(жду|ждать|ожидаю|чекаю|чекати|waiting for|wait for)\b`).test(t)) {
    const who = t.match(rx(String.raw`(?:от|від|from)\s+([\p{L}\-]+(?:\s+[\p{L}\-]+)?)`));
    const title = cap(stripFragments(clause, dm.consumed));
    return [
      {
        type: 'create_waiting',
        title,
        waitingFor: who ? cap(who[1]!) : null,
        followUpDate: dm.date ?? addDays(today, 3),
        category: detectCategory(t) as 'personal',
        sourceText: clause,
        needsConfirmation: true,
        reason: dm.date ? null : 'Предлагаю проверить ответ через 3 дня — поменяй, если нужно',
      },
    ];
  }

  // shopping
  if (TRIGGERS_SHOP.test(t) || (prev?.type === 'add_shopping_item' && !COMMAND_START.test(t) && t.split(' ').length <= 4)) {
    const household = rx(String.raw`для дома|домой|общ\w*|додому|для всех|household`).test(t);
    let body = clause.replace(/ё/g, 'е');
    body = body.replace(
      rx(String.raw`^(?:(?:еще|ещ[её]|також|также|а ще|ще)\s+)?(?:купить|купи|купити|закажи|заказать|докупить|докупи|придбати|buy|order|get|добавь|додай|add)\s+`, 'i'),
      '',
    );
    body = body.replace(rx(String.raw`\s*(?:в|у|to|into)\s+(?:список(?:\s+покупок)?|покупки|корзину|кошик|shopping list|list)\b`, 'i'), '');
    body = body.replace(rx(String.raw`\s*(?:для дома|домой|додому|для всех)\b`, 'i'), '');
    const items = splitItems(stripFragments(body, dm.consumed.filter((c) => !/\d/.test(c)))).map(parseShoppingItem);
    if (items.length) {
      return items.map((it) => ({
        type: 'add_shopping_item' as const,
        title: it.title,
        quantity: it.quantity,
        unit: it.unit,
        listType: household ? ('household' as const) : ('personal' as const),
        sourceText: clause,
        needsConfirmation: false,
        reason: null,
      }));
    }
  }

  // idea / wish / think about
  const idea = t.match(rx(String.raw`^(?:(?:еще|ещ[её]|также|а ще|ще)\s+)?(?:идея|ідея|idea)\s*[:\-—]?\s*(.+)$|^(?:(?:еще|ещ[её]|також|также|а ще|ще)\s+)?(подума\w*|подумати|think about|think)\s+(?:про|о|об|над|about)?\s*(.+)$|^(?:я\s+)?(?:хочу|хочеться|want|wish)\s+(.+)$`));
  if (idea) {
    const isThink = !!idea[2];
    const wishText = idea[4];
    const title = isThink ? cap(`Подумать про ${idea[3]}`) : cap(idea[1] ?? wishText ?? clause);
    const cat = wishText && rx(String.raw`купить|купити|buy|playstation|очки|приставк`).test(wishText) ? 'wish' : 'idea';
    return [
      {
        type: 'idea',
        title,
        category: cat,
        sourceText: clause,
        needsConfirmation: false,
        reason: 'Без срока — попадёт во входящие как идея',
      },
    ];
  }

  // task / reminder
  const isReminder = rx(String.raw`^(?:(?:пожалуйста|please)\s+)?(?:напомн|нагада|remind)`).test(t) || rx(String.raw`\s(?:напомн\w*|нагада\w*)`).test(t);
  const core = normalizeText(stripFragments(t, dm.consumed));
  const isTask =
    isReminder ||
    TRIGGERS_TASK.test(t) ||
    TRIGGERS_TASK.test(core) ||
    rx(String.raw`^(?:в|во|у|on)?\s*(записать\w*|записаться|запишись|позвон\w*|подзвон\w*|call|напис\w*|написати|write|email|оплат\w*|pay|отправ\w*|відправ\w*|send|забра\w*|оформ\w*|подать|подати|book|schedule|сходи\w*|пойти|піти|сдела\w*|зроби\w*|купить|почин\w*|отремонт\w*|продл\w*|найти|знайти|выбрать|вибрати|проверить|перевірити|check)`).test(core);
  if (isTask) {
    let title = clause.replace(/ё/g, 'е');
    title = title.replace(rx(String.raw`(?:^|\s)(?:пожалуйста|please|будь ласка)\s+`, 'i'), ' ');
    title = title.replace(rx(String.raw`(?:^|\s)(?:напомни(?:те)?|напомнить|нагадай|remind me(?:\s+to\b)?|remind)(?:\s+(?:мне|мені|me))?\s*`, 'i'), ' ');
    title = title.replace(rx(String.raw`^(?:\s*)(?:мне\s+)?(?:надо|нужно|треба|потрібно|need to|i need to|have to)\s+`, 'i'), '');
    title = cap(stripFragments(title, dm.consumed).replace(/^(?:to|чтобы|щоб)\s+/iu, ''));
    if (!title) title = cap(clause);
    const category = detectCategory(t);
    const actionReasons = [...reasons];
    let needs = dm.ambiguous;
    if (category === 'work_reminder') {
      actionReasons.push('Рабочее напоминание: оставь нейтральное название без названий клиентов и секретов');
      needs = true;
    }
    if (isReminder && !dm.date) {
      actionReasons.push('Не указан день напоминания');
      needs = true;
    } else if (isReminder && !dm.time) {
      actionReasons.push('Время не указано — уточни или оставь на день');
      needs = true;
    }
    if (dm.ambiguousHour !== null && dm.ambiguousHour <= 7) {
      dm.time = `${String(dm.ambiguousHour + 12).padStart(2, '0')}:00`;
    }
    return [
      {
        type: 'create_task',
        title,
        taskType: isReminder ? 'reminder' : 'task',
        category: category as 'personal',
        ...dateFields(dm),
        priority: 'normal',
        sourceText: clause,
        needsConfirmation: needs,
        reason: actionReasons[0] ?? null,
      },
    ];
  }

  // continuation of a shopping list ("молоко, бананы, хлеб")
  if (prev?.type === 'add_shopping_item' && t.split(' ').length <= 4) {
    const it = parseShoppingItem(clause);
    return [{ type: 'add_shopping_item', title: it.title, quantity: it.quantity, unit: it.unit, listType: prev.listType, sourceText: clause, needsConfirmation: false, reason: null }];
  }

  // a dated clause without a verb → probably a task; otherwise an inbox note
  if (dm.date) {
    return [
      {
        type: 'create_task',
        title: cap(stripFragments(clause, dm.consumed)) || cap(clause),
        taskType: 'task',
        category: detectCategory(t) as 'personal',
        ...dateFields(dm),
        priority: 'normal',
        sourceText: clause,
        needsConfirmation: true,
        reason: 'Не уверен, что это задача — проверь',
      },
    ];
  }
  return [{ type: 'note', text: cap(clause), sourceText: clause, needsConfirmation: false, reason: 'Не распознал действие — сохраню во входящие' }];
}

export function detectLanguage(text: string): ParseResult['language'] {
  const t = text.toLowerCase();
  const uk = /[іїєґ]/u.test(t);
  const cyr = /[а-яё]/u.test(t);
  const lat = /[a-z]{3,}/.test(t);
  if (uk && lat) return 'mixed';
  if (uk) return 'uk';
  if (cyr && lat) return 'mixed';
  if (cyr) return 'ru';
  if (lat) return 'en';
  return 'unknown';
}

export function parseCapture(text: string, ctx: ParseContext): ParseResult {
  const clauses = splitClauses(text);
  const actions: ProposedAction[] = [];
  let prev: ProposedAction | null = null;
  for (const c of clauses) {
    const res = classify(c, ctx, prev);
    actions.push(...res);
    prev = res[res.length - 1] ?? prev;
  }
  // "отправил письмо брокеру, жду ответа" → one waiting item with the context in its title
  const merged: ProposedAction[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    const nxt = actions[i + 1];
    if (a.type === 'note' && a.reason?.startsWith('Похоже на отметку') && nxt?.type === 'create_waiting') {
      merged.push({ ...nxt, title: `${a.text}: ждать ответа`, sourceText: `${a.sourceText}, ${nxt.sourceText}` });
      i++;
      continue;
    }
    merged.push(a);
  }
  return parseResultSchema.parse({ language: detectLanguage(text), actions: merged.slice(0, 20) });
}
