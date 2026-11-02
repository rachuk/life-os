const kgFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** 42.5 → «42,5» */
export function fmtKg(v: number) {
  return kgFormat.format(v);
}

/** A number for an input field, with a decimal comma */
export function inputNum(v: number | null) {
  return v === null ? '' : String(v).replace('.', ',');
}
