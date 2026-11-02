import { describe, expect, it } from 'vitest';
import { allowedStatus, levelAfterCheckpoint, levelLabel, sessionsPerWeek, shortLevel } from '@/domain/skills/skills';

describe('skills rules', () => {
  it('level changes only through a passed checkpoint', () => {
    expect(levelAfterCheckpoint(2, 'cefr', false, 4)).toBe(2);
    expect(levelAfterCheckpoint(2, 'cefr', true, 3)).toBe(3);
    expect(levelAfterCheckpoint(4, 'cefr', true, 3)).toBe(4); // never lowered by a checkpoint
    expect(levelAfterCheckpoint(4, 'five', true, 9)).toBe(5);
  });

  it('at most two active skills', () => {
    expect(allowedStatus('active', 1).status).toBe('active');
    const r = allowedStatus('active', 2);
    expect(r.status).toBe('maintenance');
    expect(r.note).toMatch(/поддержку/);
  });

  it('sessions per week and labels', () => {
    expect(sessionsPerWeek(105, 15)).toBe(7);
    expect(sessionsPerWeek(40, 20)).toBe(2);
    expect(sessionsPerWeek(0, 20)).toBe(0);
    expect(shortLevel('cefr', 3)).toBe('B1');
    expect(levelLabel('five', 'leadership', 3)).toMatch(/делегирую/i);
  });
});
