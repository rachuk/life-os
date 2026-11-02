import { DateTime } from 'luxon';
import type { PlanEvent } from '@/domain/planner/model';
import { buildTemplates, defaultRoutinePrefs, type RoutinePrefs, type TemplateSpec } from '@/domain/planner/prefs';
import { materializeRange } from '@/domain/planner/materialize';
import type { LocalDate } from '@/domain/time';

export const TZ = 'Europe/Lisbon';

export function lisbon(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: TZ }).toUTC();
}

export function prefs(over: Partial<RoutinePrefs> = {}): RoutinePrefs {
  return { ...defaultRoutinePrefs(TZ), gymDays: [2, 4], ...over };
}

export function templatesFor(p: RoutinePrefs): TemplateSpec[] {
  return buildTemplates(p).map((t, i) => ({ ...t, id: `tpl-${t.key}-${i}` }));
}

let seq = 0;
export function materializeWeek(p: RoutinePrefs, from: LocalDate, to: LocalDate, now: DateTime, existing: PlanEvent[] = []) {
  const templates = templatesFor(p);
  const res = materializeRange({ templates, tz: TZ, fromDate: from, toDate: to, now, existing, gymTravelMinutes: p.gymTravelMinutes });
  const events: PlanEvent[] = res.events.map((e) => ({
    id: `ev-${++seq}`,
    kind: e.kind,
    title: e.title,
    priorityClass: e.priorityClass,
    status: 'planned',
    localDate: e.localDate,
    startAt: e.startAt,
    endAt: e.endAt,
    templateId: e.templateId,
    taskId: null,
    flexWindow: e.flexWindow,
    originKey: e.originKey,
    source: e.source,
    revision: 1,
  }));
  return { templates, events, risks: res.risks };
}

export function local(e: { startAt: DateTime; endAt: DateTime }): string {
  return `${e.startAt.setZone(TZ).toFormat('yyyy-MM-dd HH:mm')}–${e.endAt.setZone(TZ).toFormat('HH:mm')}`;
}
