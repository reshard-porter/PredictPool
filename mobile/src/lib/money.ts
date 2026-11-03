// Integer minor units ⇄ display strings. Never uses floating point for amounts.
let EXP = 2;
let CUR = 'USD';
export const setCurrency = (currency: string, exponent: number) => { CUR = currency; EXP = exponent; };
export const currency = () => CUR;

export function money(minor: number, cur: string = CUR): string {
  const neg = minor < 0;
  const s = String(Math.abs(minor)).padStart(EXP + 1, '0');
  const whole = s.slice(0, s.length - EXP).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '−' : ''}${cur} ${whole}${EXP ? '.' + s.slice(-EXP) : ''}`;
}

/** Parse user input like "12.5" or "1,000.00" to minor units without float rounding; null if invalid. */
export function parseMinor(input: string): number | null {
  const t = input.replace(/[,\s]/g, '');
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{0,${EXP}}))?$`).exec(t);
  if (!m) return null;
  const v = Number(m[1]) * 10 ** EXP + Number((m[2] ?? '').padEnd(EXP, '0') || 0);
  return Number.isSafeInteger(v) ? v : null;
}

export const toInput = (minor: number) => (minor / 10 ** EXP).toFixed(EXP);

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function countdown(ms: number): string {
  if (ms <= 0) return 'closed';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s % 60}s`;
}

export const statusLabel = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
