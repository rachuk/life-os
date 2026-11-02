import type { DateTime } from 'luxon';
import { addDays, isLocalDate, isoWeekday, type LocalDate, type LocalTime } from '../time';
import { rx } from './rx';

/**
 * Deterministic resolution of relative dates/times in ru / uk / en relative to the real
 * message time in the user's zone (PRD §6.4). Ambiguity is reported, never guessed silently.
 */

export interface DateMatch {
  date: LocalDate | null;
  time: LocalTime | null;
  /** hour 1..11 said without am/pm or part of day */
  ambiguousHour: number | null;
  partOfDay: 'morning' | 'day' | 'evening' | 'night' | null;
  ambiguous: boolean;
  reasons: string[];
  /** text fragments consumed by the match (to be removed from titles) */
  consumed: string[];
}

const WEEKDAY_WORDS: [RegExp, number][] = [
  [rx(String.raw`понедельник\w*|понеділ\w*|\bmonday\b|\bmon\b|\bпн\b`), 1],
  [rx(String.raw`вторник\w*|вівтор\w*|\btuesday\b|\btue\b|\bвт\b`), 2],
  [rx(String.raw`сред[уаы]\b|середу\b|середа\b|\bwednesday\b|\bwed\b|\bср\b`), 3],
  [rx(String.raw`четверг\w*|четвер\w*|\bthursday\b|\bthu\b|\bчт\b`), 4],
  [rx(String.raw`пятниц\w*|п['’]?ятниц\w*|\bfriday\b|\bfri\b|\bпт\b`), 5],
  [rx(String.raw`суббот\w*|субот\w*|\bsaturday\b|\bsat\b|\bсб\b`), 6],
  [rx(String.raw`воскресень\w*|неділ\w*|\bsunday\b|\bsun\b|\bвс\b|\bнд\b`), 7],
];

const MONTHS: [RegExp, number][] = [
  [rx(String.raw`январ\w*|січ\w*|\bjan\w*`), 1],
  [rx(String.raw`феврал\w*|лют\w*|\bfeb\w*`), 2],
  [rx(String.raw`март\w*|берез\w*|\bmar(ch)?\b`), 3],
  [rx(String.raw`апрел\w*|квіт\w*|\bapr\w*`), 4],
  [rx(String.raw`\bма[яй]\b|травн\w*|\bmay\b`), 5],
  [rx(String.raw`июн\w*|черв\w*|\bjun\w*`), 6],
  [rx(String.raw`июл\w*|лип\w*|\bjul\w*`), 7],
  [rx(String.raw`август\w*|серп\w*|\baug\w*`), 8],
  [rx(String.raw`сентябр\w*|верес\w*|\bsep\w*`), 9],
  [rx(String.raw`октябр\w*|жовт\w*|\boct\w*`), 10],
  [rx(String.raw`ноябр\w*|листопад\w*|\bnov\w*`), 11],
  [rx(String.raw`декабр\w*|груд\w*|\bdec\w*`), 12],
];

export const NUMBER_WORDS: Record<string, number> = {
  один: 1, одну: 1, одна: 1, одного: 1, one: 1,
  два: 2, две: 2, дві: 2, two: 2,
  три: 3, three: 3,
  четыре: 4, чотири: 4, four: 4,
  пять: 5, "п'ять": 5, 'пʼять': 5, five: 5,
  шесть: 6, шість: 6, six: 6,
  семь: 7, сім: 7, seven: 7,
  восемь: 8, вісім: 8, eight: 8,
  девять: 9, "дев'ять": 9, 'девʼять': 9, nine: 9,
  десять: 10, ten: 10,
  одиннадцать: 11, одинадцять: 11, eleven: 11,
  двенадцать: 12, дванадцять: 12, twelve: 12,
};

const NUM_WORD_RE = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/'/g, "['’ʼ]?"))
  .join('|');

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function wordToNumber(w: string): number | null {
  const n = Number(w);
  if (Number.isFinite(n)) return n;
  const key = w.replace(/['’ʼ]/g, "'");
  return NUMBER_WORDS[key] ?? NUMBER_WORDS[key.replace(/'/g, '')] ?? null;
}

function nextWeekdayDate(today: LocalDate, target: number, includeToday: boolean): LocalDate {
  const cur = isoWeekday(today);
  let diff = (target - cur + 7) % 7;
  if (diff === 0 && !includeToday) diff = 7;
  return addDays(today, diff);
}

export function resolveDateTime(rawText: string, now: DateTime, tz: string): DateMatch {
  const text = normalizeText(rawText);
  const local = now.setZone(tz);
  const today = local.toISODate()!;
  const m: DateMatch = {
    date: null,
    time: null,
    ambiguousHour: null,
    partOfDay: null,
    ambiguous: false,
    reasons: [],
    consumed: [],
  };
  let work = text;
  const consume = (re: RegExp) => {
    const hit = work.match(re);
    if (hit) {
      m.consumed.push(hit[0]);
      work = work.replace(hit[0], ' ');
    }
    return hit;
  };

  // --- date ---
  let hit: RegExpMatchArray | null;
  if ((hit = consume(rx(String.raw`\b(позавчера|позавчора|day before yesterday)\b`)))) {
    m.date = addDays(today, -2);
  } else if ((hit = consume(rx(String.raw`\b(вчера|вчора|yesterday|last night)\b`)))) {
    m.date = addDays(today, -1);
  } else if ((hit = consume(rx(String.raw`\b(послезавтра|післязавтра|day after tomorrow)\b`)))) {
    m.date = addDays(today, 2);
  } else if ((hit = consume(rx(String.raw`\b(завтра|tomorrow)\b`)))) {
    m.date = addDays(today, 1);
  } else if ((hit = consume(rx(String.raw`\b(сегодня|сьогодні|today|tonight)\b`)))) {
    m.date = today;
  } else if ((hit = consume(rx(`\\b(через|in)\\s+(\\d+|${NUM_WORD_RE})\\s+(день|дня|дней|дні|днів|day|days)\\b`)))) {
    const n = wordToNumber(hit[2]!);
    if (n !== null) m.date = addDays(today, n);
  } else if ((hit = consume(rx(String.raw`\b(через неделю|через тиждень|in a week|next week)\b`)))) {
    m.date = addDays(today, 7);
    if (hit[0] === 'next week') {
      m.ambiguous = true;
      m.reasons.push('«next week» — уточни день');
    }
  } else if ((hit = consume(rx(String.raw`\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b`)))) {
    const d = Number(hit[1]);
    const mo = Number(hit[2]);
    let y = hit[3] ? Number(hit[3]) : local.year;
    if (y < 100) y += 2000;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (isLocalDate(iso)) {
      m.date = !hit[3] && iso < today ? `${y + 1}${iso.slice(4)}` : iso;
    }
  } else {
    // "5 ноября" / "November 5"
    for (const [re, month] of MONTHS) {
      const dm = work.match(rx(`\\b(\\d{1,2})\\s+(${re.source})`)) ?? work.match(rx(`(${re.source})\\s+(\\d{1,2})\\b`));
      if (dm) {
        const day = Number(/^\d/.test(dm[1]!) ? dm[1] : dm[dm.length - 1]);
        let y = local.year;
        let iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (isLocalDate(iso)) {
          if (iso < today) {
            y += 1;
            iso = `${y}${iso.slice(4)}`;
          }
          m.date = iso;
          m.consumed.push(dm[0]);
          work = work.replace(dm[0], ' ');
        }
        break;
      }
    }
  }

  if (!m.date) {
    const nextMarker = rx(String.raw`\b(следующ\w*|наступн\w*|next)\s+`);
    for (const [re, wd] of WEEKDAY_WORDS) {
      const wh = work.match(rx(`(?:\\b(?:в|во|у|on|this)\\s+)?(?:(следующ\\w*|наступн\\w*|next)\\s+)?(?:${re.source})`));
      if (wh) {
        m.consumed.push(wh[0]);
        work = work.replace(wh[0], ' ');
        const isNext = nextMarker.test(wh[0]);
        if (isNext) {
          // "в следующий четверг" — could mean the coming one or the one in next week → ask
          const coming = nextWeekdayDate(today, wd, false);
          const sameWeek = isoWeekday(coming) > isoWeekday(today);
          m.date = sameWeek ? addDays(coming, 7) : coming;
          m.ambiguous = true;
          m.reasons.push(`«${wh[0].trim()}» можно понять по-разному — проверь дату`);
        } else {
          const isToday = isoWeekday(today) === wd;
          m.date = nextWeekdayDate(today, wd, false);
          if (isToday) {
            m.ambiguous = true;
            m.reasons.push('Сегодня тот же день недели — имелся в виду сегодня или через неделю?');
          }
        }
        break;
      }
    }
  }

  // --- time ---
  if ((hit = consume(rx(String.raw`\b(?:в|во|о|об|at|к|до)?\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b`)))) {
    m.time = `${hit[1]!.padStart(2, '0')}:${hit[2]}`;
  } else if (
    (hit = consume(
      rx(
        `\\b(?:в|во|о|об|at|к)\\s+(\\d{1,2}|${NUM_WORD_RE})(?:\\s*(?:час\\w*|годин\\w*))?(?:\\s+(утра|вечера|дня|ночи|ранку|вечора|ночі|am|pm))?\\b|\\b(\\d{1,2})\\s*(am|pm)\\b`,
      ),
    ))
  ) {
    const hourRaw = hit[1] ?? hit[3];
    const mer = hit[2] ?? hit[4] ?? null;
    let h = hourRaw ? wordToNumber(hourRaw) : null;
    if (h !== null && h >= 0 && h <= 23) {
      if (mer && /вечера|вечора|pm|дня/.test(mer) && h < 12) h += 12;
      if (mer && /ночи|ночі/.test(mer) && h === 12) h = 0;
      if (!mer && h >= 1 && h <= 11) m.ambiguousHour = h;
      m.time = `${String(h).padStart(2, '0')}:00`;
    }
  }

  const pod = work.match(rx(String.raw`\b(утром|вранці|зранку|in the morning|днем|вдень|in the afternoon|вечером|ввечері|увечері|in the evening|tonight|ночью|вночі)\b`));
  if (pod) {
    m.consumed.push(pod[0]);
    work = work.replace(pod[0], ' ');
    m.partOfDay = /утр|вран|зран|morning/.test(pod[0])
      ? 'morning'
      : /дн|вдень|afternoon/.test(pod[0])
        ? 'day'
        : /ноч|вночі/.test(pod[0])
          ? 'night'
          : 'evening';
    if (m.ambiguousHour !== null && m.time) {
      const h = m.ambiguousHour;
      if ((m.partOfDay === 'evening' || m.partOfDay === 'day') && h < 12) m.time = `${String(h + 12).padStart(2, '0')}:00`;
      m.ambiguousHour = null;
    } else if (!m.time) {
      m.ambiguous = true;
      m.reasons.push('Время суток без точного часа — уточни время');
    }
  }

  if (m.ambiguousHour !== null) {
    m.ambiguous = true;
    m.reasons.push(`«${m.ambiguousHour}» — утра или вечера?`);
  }
  return m;
}

/** Resolve an ambiguous hour using a preferred window (e.g. gym 18:30–22:30 → 9 means 21:00). */
export function disambiguateHour(hour: number, preferEarliest: LocalTime, preferLatest: LocalTime): LocalTime {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const pm = (hour + 12) * 60;
  const am = hour * 60;
  const inWin = (x: number) => x >= toMin(preferEarliest) && x <= toMin(preferLatest);
  const chosen = inWin(pm) && !inWin(am) ? hour + 12 : hour;
  return `${String(chosen).padStart(2, '0')}:00`;
}
