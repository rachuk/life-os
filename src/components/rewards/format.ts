// Display helpers for the virtual wish fund (amounts are integer cents of the user's own budget).

const fmt = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function formatEuro(cents: number): string {
  return fmt.format(cents / 100);
}

/** '12', '12,5', '12.50' → 1250; empty → null; invalid → NaN. */
export function parseEuroInput(v: string): number | null {
  const s = v.trim().replace(/\s/g, '').replace(',', '.').replace('€', '');
  if (!s) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}

export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const v = cents / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',');
}

export type LedgerStatus = 'proposed' | 'approved' | 'rejected' | 'funded' | 'redeemed' | 'final';
export const LEDGER_STATUS: Record<LedgerStatus, { label: string; tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' }> = {
  proposed: { label: 'предложено', tone: 'warn' },
  approved: { label: 'подтверждено', tone: 'accent' },
  rejected: { label: 'отклонено', tone: 'neutral' },
  funded: { label: 'отложено', tone: 'ok' },
  redeemed: { label: 'потрачено', tone: 'neutral' },
  final: { label: 'корректировка', tone: 'neutral' },
};

export const ENTRY_TYPE: Record<string, string> = {
  earned: 'Начисление',
  approved: 'Подтверждение',
  funded: 'Отложено',
  redeemed: 'Покупка',
  adjusted: 'Корректировка',
};
