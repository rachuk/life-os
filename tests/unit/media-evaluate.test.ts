import { describe, expect, it } from 'vitest';
import { evaluateMeal, evaluateSteps, evaluateWeight, parseNumberInput } from '@/domain/media/evaluate';
import { esc, fit, formatProposals } from '@/server/telegram/format';
import { sniffAudio } from '@/server/services/voice';

const TODAY = '2026-11-03';
const steps = (over: Partial<Parameters<typeof evaluateSteps>[0]>) =>
  evaluateSteps({ readable: true, value: 8000, period: 'day', dateShown: null, dateIso: null, metric: 'steps', confidence: 0.9, note: null, ...over }, TODAY);

describe('weight proposals (PRD §11.3)', () => {
  it('a confident reading is offered, a weak one is not (HEALTH-04)', () => {
    expect(evaluateWeight({ readable: true, value: 53.2, unit: 'kg', confidence: 0.8, otherNumbersVisible: false, note: null })).toMatchObject({ canSave: true, value: 53.2 });
    expect(evaluateWeight({ readable: true, value: 53.2, unit: 'kg', confidence: 0.3, otherNumbersVisible: false, note: null })).toMatchObject({ canSave: false, value: null });
    expect(evaluateWeight({ readable: false, value: null, unit: null, confidence: 0, otherNumbersVisible: false, note: null }).message).toMatch(/вручную/);
  });
  it('pounds are converted and flagged', () => {
    const p = evaluateWeight({ readable: true, value: 120, unit: 'lb', confidence: 0.9, otherNumbersVisible: false, note: null });
    expect(p.value).toBe(54.4);
    expect(p.convertedFromLb).toBe(true);
  });
});

describe('steps proposals (HEALTH-02)', () => {
  it('only a confident daily step count can be saved as daily', () => {
    expect(steps({}).canSaveAsDaily).toBe(true);
    expect(steps({ period: 'week' }).canSaveAsDaily).toBe(false);
    expect(steps({ period: 'month' }).canSaveAsDaily).toBe(false);
    expect(steps({ period: 'unknown' }).canSaveAsDaily).toBe(false);
    expect(steps({ metric: 'calories' }).canSaveAsDaily).toBe(false);
    expect(steps({ confidence: 0.2 }).canSaveAsDaily).toBe(false);
  });
  it('the screenshot date is validated: future or garbage dates are dropped', () => {
    expect(steps({ dateIso: '2026-11-02' })).toMatchObject({ suggestedDate: '2026-11-02', dateDiffers: true });
    expect(steps({ dateIso: '2026-11-03' })).toMatchObject({ suggestedDate: '2026-11-03', dateDiffers: false });
    expect(steps({ dateIso: '2026-11-09' }).suggestedDate).toBeNull();
    expect(steps({ dateIso: 'вчера' }).suggestedDate).toBeNull();
  });
});

describe('meal proposals (HEALTH-03)', () => {
  it('never claims anything was eaten and keeps at most two questions', () => {
    const p = evaluateMeal({ readable: true, detected: [{ name: 'рис', confidence: 0.9 }], possible: [], notVisible: [], portionNote: null, questions: ['a', 'b'], matchesPlan: 'unknown', note: null });
    expect(p.message).toMatch(/отметь, сколько съел/);
    expect(JSON.stringify(p)).not.toMatch(/калори|kcal/i);
  });
});

describe('typed numbers', () => {
  it.each([
    ['53,2', 53.2],
    ['53.2 кг', 53.2],
    ['8 500', 8500],
    ['8500 вчера', 8500],
    ['8.5к', null],
    ['около восьми тысяч', null],
  ])('%s → %s', (input, out) => expect(parseNumberInput(input)).toBe(out));
});

describe('telegram formatting', () => {
  it('escapes user text for HTML parse mode', () => {
    expect(esc('<b>a</b> & "b"')).toBe('&lt;b&gt;a&lt;/b&gt; &amp; &quot;b&quot;');
    const text = formatProposals([{ type: 'note', text: '<script>x</script>', sourceText: '', needsConfirmation: false, reason: null }], TODAY);
    expect(text).not.toContain('<script>');
  });
  it('fits long messages under the Telegram limit on line boundaries', () => {
    const long = Array.from({ length: 400 }, (_, i) => `<b>строка ${i}</b>`).join('\n');
    const out = fit(long);
    expect(out.length).toBeLessThan(4096);
    expect(out.split('\n').slice(0, -1).every((l) => l.startsWith('<b>') && l.endsWith('</b>'))).toBe(true);
  });
});

describe('audio sniffing', () => {
  it('detects containers by magic bytes, not by the declared type', () => {
    const pad = Buffer.alloc(16);
    expect(sniffAudio(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), pad]))).toBe('webm');
    expect(sniffAudio(Buffer.concat([Buffer.from('OggS'), pad]))).toBe('ogg');
    expect(sniffAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), pad]))).toBe('mp4');
    expect(sniffAudio(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), pad]))).toBe('wav');
    expect(sniffAudio(Buffer.concat([Buffer.from('<html>'), pad]))).toBeNull();
  });
});
