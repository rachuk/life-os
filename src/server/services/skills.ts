import type { DateTime } from 'luxon';
import { z } from 'zod';
import {
  allowedStatus,
  levelAfterCheckpoint,
  levelLabel,
  maxLevel,
  sessionsPerWeek,
  SKILL_PRESETS,
  type LevelScale,
  type SkillArea,
} from '@/domain/skills/skills';
import { addDays, isLocalDate, localDateOf, weekStartOf, type LocalDate } from '@/domain/time';
import { one, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import { regenerateFuture } from './planning';
import { loadContext, type UserContext } from './profile';

export interface SkillRow {
  id: string;
  title: string;
  area: SkillArea;
  why: string | null;
  targetDescription: string | null;
  levelScale: LevelScale;
  currentLevel: number;
  targetLevel: number;
  status: 'active' | 'maintenance' | 'paused' | 'done';
  weeklyMinutes: number;
  sessionMinutes: number;
  templateId: string | null;
  sortOrder: number;
  createdAt: Date;
}

export const skillInputSchema = z.object({
  title: z.string().trim().min(1).max(80),
  area: z.enum(['language', 'communication', 'leadership', 'professional', 'other']).default('other'),
  why: z.string().trim().max(300).nullable().optional(),
  targetDescription: z.string().trim().max(300).nullable().optional(),
  levelScale: z.enum(['cefr', 'five']).default('five'),
  currentLevel: z.number().int().min(1).max(6).default(1),
  targetLevel: z.number().int().min(1).max(6).default(3),
  status: z.enum(['active', 'maintenance', 'paused', 'done']).default('active'),
  weeklyMinutes: z.number().int().min(0).max(1200).default(60),
  sessionMinutes: z.number().int().min(5).max(180).default(20),
});
export const skillPatchSchema = skillInputSchema.partial().omit({ currentLevel: true });

/** Maintenance skills get a light weekly slot; paused/done get none. */
function effectiveWeekly(s: Pick<SkillRow, 'status' | 'weeklyMinutes' | 'sessionMinutes'>): number {
  if (s.status === 'active') return s.weeklyMinutes;
  if (s.status === 'maintenance') return Math.min(s.weeklyMinutes, s.sessionMinutes);
  return 0;
}

/** Create/update the weekly-quota template for a skill, then rebuild future untouched events. */
async function syncSkillTemplate(tx: Tx, ctx: UserContext, now: DateTime, skill: SkillRow): Promise<void> {
  const weekly = effectiveWeekly(skill);
  const count = sessionsPerWeek(weekly, skill.sessionMinutes);
  const key = `skill:${skill.id}`;
  const [tpl] = await tx<{ id: string }[]>`
    insert into schedule_templates (user_id, key, kind, title, recurrence, local_start, local_end, duration_minutes, timezone,
      priority_class, flex_window, reminder, enabled, sort_order)
    values (${ctx.userId}, ${key}, 'skill', ${skill.title}, ${tx.json({
      type: 'weekly_quota',
      count: Math.max(1, count),
      preferredDays: null,
      allowedDays: [1, 2, 3, 4, 5, 6, 7],
      avoidConsecutive: false,
      preferredStart: '20:15',
      weekendEarliest: '10:00',
    } as never)}, '20:15', null, ${skill.sessionMinutes}, ${ctx.tz}, 'required_movable',
      ${tx.json({ earliest: '18:15', latest: '23:00' })}, ${tx.json({ type: 'soft' } as never)}, ${count > 0}, 50)
    on conflict (user_id, key) do update set title = excluded.title, recurrence = excluded.recurrence,
      duration_minutes = excluded.duration_minutes, enabled = excluded.enabled, timezone = excluded.timezone
    returning id`;
  if (tpl && skill.templateId !== tpl.id) await tx`update skills set template_id = ${tpl.id} where id = ${skill.id}`;
  await regenerateFuture(tx, await loadContext(tx, ctx.userId), now);
}

async function activeCount(tx: Tx, userId: string, excludeId: string | null): Promise<number> {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from skills where user_id = ${userId} and status = 'active' and (${excludeId}::uuid is null or id <> ${excludeId}::uuid)`;
  return r?.n ?? 0;
}

export async function listSkills(tx: Tx, userId: string): Promise<SkillRow[]> {
  return tx<SkillRow[]>`select * from skills where user_id = ${userId} order by status = 'active' desc, status = 'maintenance' desc, sort_order, created_at`;
}

export async function getSkill(tx: Tx, userId: string, id: string): Promise<SkillRow> {
  const [s] = await tx<SkillRow[]>`select * from skills where id = ${id} and user_id = ${userId}`;
  if (!s) throw new AppError('NOT_FOUND', 'Навык не найден', 404);
  return s;
}

export async function createSkill(tx: Tx, ctx: UserContext, now: DateTime, raw: z.input<typeof skillInputSchema>) {
  const input = skillInputSchema.parse(raw);
  const max = maxLevel(input.levelScale);
  if (input.currentLevel > max || input.targetLevel > max) throw new AppError('BAD_LEVEL', 'Уровень вне шкалы', 422);
  const { status, note } = allowedStatus(input.status, await activeCount(tx, ctx.userId, null));
  const row = one(
    await tx<SkillRow[]>`
      insert into skills (user_id, title, area, why, target_description, level_scale, current_level, target_level, status, weekly_minutes, session_minutes)
      values (${ctx.userId}, ${input.title}, ${input.area}, ${input.why ?? null}, ${input.targetDescription ?? null}, ${input.levelScale},
              ${input.currentLevel}, ${input.targetLevel}, ${status}, ${input.weeklyMinutes}, ${input.sessionMinutes})
      returning *`,
  );
  await syncSkillTemplate(tx, ctx, now, row);
  await audit(tx, ctx.userId, 'skill', row.id, 'created', { status });
  return { skill: row, note };
}

export async function updateSkill(tx: Tx, ctx: UserContext, now: DateTime, id: string, raw: z.input<typeof skillPatchSchema>) {
  const patch = skillPatchSchema.parse(raw);
  const cur = await getSkill(tx, ctx.userId, id);
  let note: string | null = null;
  let status = patch.status ?? cur.status;
  if (patch.status === 'active' && cur.status !== 'active') {
    const r = allowedStatus('active', await activeCount(tx, ctx.userId, id));
    status = r.status;
    note = r.note;
  }
  const row = one(
    await tx<SkillRow[]>`
      update skills set title = ${patch.title ?? cur.title}, area = ${patch.area ?? cur.area}, why = ${patch.why !== undefined ? patch.why : cur.why},
        target_description = ${patch.targetDescription !== undefined ? patch.targetDescription : cur.targetDescription},
        target_level = ${patch.targetLevel ?? cur.targetLevel}, status = ${status},
        weekly_minutes = ${patch.weeklyMinutes ?? cur.weeklyMinutes}, session_minutes = ${patch.sessionMinutes ?? cur.sessionMinutes}
      where id = ${id} and user_id = ${ctx.userId} returning *`,
  );
  if (
    status !== cur.status ||
    row.weeklyMinutes !== cur.weeklyMinutes ||
    row.sessionMinutes !== cur.sessionMinutes ||
    row.title !== cur.title
  ) {
    await syncSkillTemplate(tx, ctx, now, row);
  }
  return { skill: row, note };
}

export async function deleteSkill(tx: Tx, ctx: UserContext, now: DateTime, id: string): Promise<void> {
  await getSkill(tx, ctx.userId, id);
  await tx`delete from schedule_templates where user_id = ${ctx.userId} and key = ${`skill:${id}`}`;
  await tx`delete from skills where id = ${id} and user_id = ${ctx.userId}`;
  await regenerateFuture(tx, await loadContext(tx, ctx.userId), now);
  await audit(tx, ctx.userId, 'skill', id, 'deleted', {});
}

export const practiceSchema = z.object({
  date: z.string().refine(isLocalDate).optional(),
  minutes: z.number().int().min(1).max(600),
  activity: z.string().trim().max(300).nullable().optional(),
});

export async function logPractice(tx: Tx, ctx: UserContext, now: DateTime, skillId: string, raw: z.input<typeof practiceSchema>, source = 'web') {
  const input = practiceSchema.parse(raw);
  await getSkill(tx, ctx.userId, skillId);
  const date = input.date ?? localDateOf(now, ctx.tz);
  if (date > localDateOf(now, ctx.tz)) throw new AppError('FUTURE_DATE', 'Нельзя записать практику на будущее', 422);
  return one(
    await tx<{ id: string }[]>`
      insert into skill_practice_logs (user_id, skill_id, local_date, minutes, activity, source)
      values (${ctx.userId}, ${skillId}, ${date}, ${input.minutes}, ${input.activity ?? null}, ${source}) returning id`,
  );
}

/** Called when a planned skill session is marked completed (planner hook). Idempotent per event. */
export async function practiceFromEvent(tx: Tx, userId: string, ev: { id: string; templateId: string | null; localDate: string; minutes: number }): Promise<void> {
  if (!ev.templateId) return;
  const [s] = await tx<{ id: string }[]>`select id from skills where user_id = ${userId} and template_id = ${ev.templateId}`;
  if (!s) return;
  await tx`insert into skill_practice_logs (user_id, skill_id, local_date, minutes, activity, schedule_event_id, source)
           values (${userId}, ${s.id}, ${ev.localDate}, ${Math.max(1, ev.minutes)}, 'Занятие по плану', ${ev.id}, 'plan')
           on conflict (schedule_event_id) where schedule_event_id is not null do nothing`;
}

export async function deletePractice(tx: Tx, userId: string, id: string): Promise<void> {
  const rows = await tx`delete from skill_practice_logs where id = ${id} and user_id = ${userId} returning id`;
  if (!rows.length) throw notFound('Запись');
}

export const checkpointSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  dueDate: z.string().refine(isLocalDate).nullable().optional(),
});

export async function addCheckpoint(tx: Tx, ctx: UserContext, skillId: string, raw: z.input<typeof checkpointSchema>) {
  const input = checkpointSchema.parse(raw);
  await getSkill(tx, ctx.userId, skillId);
  return one(
    await tx<{ id: string }[]>`
      insert into skill_checkpoints (user_id, skill_id, title, description, due_date)
      values (${ctx.userId}, ${skillId}, ${input.title}, ${input.description ?? null}, ${input.dueDate ?? null}) returning id`,
  );
}

export const checkpointResultSchema = z.object({
  passed: z.boolean(),
  resultLevel: z.number().int().min(1).max(6).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

/** The only path that can raise a skill level. */
export async function completeCheckpoint(tx: Tx, ctx: UserContext, now: DateTime, checkpointId: string, raw: z.input<typeof checkpointResultSchema>) {
  const input = checkpointResultSchema.parse(raw);
  const [cp] = await tx<{ id: string; skillId: string; status: string }[]>`
    select id, skill_id, status from skill_checkpoints where id = ${checkpointId} and user_id = ${ctx.userId}`;
  if (!cp) throw notFound('Контрольное задание');
  const skill = await getSkill(tx, ctx.userId, cp.skillId);
  await tx`update skill_checkpoints set status = ${input.passed ? 'passed' : 'not_yet'}, result_level = ${input.resultLevel ?? null},
             notes = ${input.notes ?? null}, completed_at = ${now.toJSDate()} where id = ${checkpointId}`;
  const level = levelAfterCheckpoint(skill.currentLevel, skill.levelScale, input.passed, input.resultLevel ?? null);
  if (level !== skill.currentLevel) await tx`update skills set current_level = ${level} where id = ${skill.id}`;
  await audit(tx, ctx.userId, 'skill_checkpoint', checkpointId, input.passed ? 'passed' : 'not_yet', { from: skill.currentLevel, to: level });
  return { level, changed: level !== skill.currentLevel };
}

export async function skillsOverview(tx: Tx, ctx: UserContext, now: DateTime) {
  const today = localDateOf(now, ctx.tz);
  const ws = weekStartOf(today);
  const skills = await listSkills(tx, ctx.userId);
  const ids = skills.map((s) => s.id);
  const logs = ids.length
    ? await tx<{ id: string; skillId: string; localDate: string; minutes: number; activity: string | null; source: string }[]>`
        select id, skill_id, local_date, minutes, activity, source from skill_practice_logs
        where user_id = ${ctx.userId} and skill_id = any(${ids}) and local_date >= ${addDays(today, -60)} order by local_date desc, created_at desc`
    : [];
  const checkpoints = ids.length
    ? await tx<{ id: string; skillId: string; title: string; description: string | null; dueDate: string | null; status: string; resultLevel: number | null; notes: string | null; completedAt: Date | null }[]>`
        select id, skill_id, title, description, due_date, status, result_level, notes, completed_at from skill_checkpoints
        where user_id = ${ctx.userId} and skill_id = any(${ids}) order by status = 'planned' desc, due_date nulls last, created_at desc`
    : [];
  return {
    today,
    weekStart: ws,
    activeCount: skills.filter((s) => s.status === 'active').length,
    presets: SKILL_PRESETS,
    skills: skills.map((s) => {
      const week = logs.filter((l) => l.skillId === s.id && l.localDate >= ws);
      return {
        id: s.id,
        title: s.title,
        area: s.area,
        why: s.why,
        targetDescription: s.targetDescription,
        levelScale: s.levelScale,
        currentLevel: s.currentLevel,
        targetLevel: s.targetLevel,
        currentLabel: levelLabel(s.levelScale, s.area, s.currentLevel),
        targetLabel: levelLabel(s.levelScale, s.area, s.targetLevel),
        status: s.status,
        weeklyMinutes: s.weeklyMinutes,
        sessionMinutes: s.sessionMinutes,
        effectiveWeekly: effectiveWeekly(s),
        weekMinutes: week.reduce((a, l) => a + l.minutes, 0),
        weekSessions: week.length,
        recent: logs.filter((l) => l.skillId === s.id).slice(0, 8),
        checkpoints: checkpoints.filter((c) => c.skillId === s.id).map((c) => ({ ...c, completedAt: c.completedAt?.toISOString() ?? null })),
        ideas: SKILL_PRESETS.find((p) => p.title === s.title)?.practiceIdeas ?? [],
        checkpointIdeas: SKILL_PRESETS.find((p) => p.title === s.title)?.checkpointIdeas ?? [],
      };
    }),
  };
}
export type SkillsOverview = Awaited<ReturnType<typeof skillsOverview>>;

export async function weekSkillFacts(tx: Tx, ctx: UserContext, weekStart: LocalDate) {
  const skills = await listSkills(tx, ctx.userId);
  const out = [];
  for (const s of skills.filter((x) => x.status === 'active' || x.status === 'maintenance')) {
    const [r] = await tx<{ minutes: number; sessions: number }[]>`
      select coalesce(sum(minutes), 0)::int as minutes, count(*)::int as sessions from skill_practice_logs
      where user_id = ${ctx.userId} and skill_id = ${s.id} and local_date between ${weekStart} and ${addDays(weekStart, 6)}`;
    out.push({ id: s.id, title: s.title, status: s.status, minutes: r?.minutes ?? 0, targetMinutes: effectiveWeekly(s), sessions: r?.sessions ?? 0 });
  }
  return out;
}
