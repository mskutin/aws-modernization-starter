/** Display formatting. The UI language is English, so numbers use the `en` locale. */
const integerFormat = new Intl.NumberFormat('en');
const decimalFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const percentFormat = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export const formatInteger = (value: number): string => integerFormat.format(value);
export const formatDecimal = (value: number): string => decimalFormat.format(value);
export const formatPercent = (ratio: number): string => percentFormat.format(ratio);

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

/** 0 → "0 s", 45 → "45 s", 90 → "1 min 30 s", 120 → "2 min". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * Seconds from `fromIso` to `toIso`, or null when either timestamp is invalid or the
 * interval is negative (clock skew between writers must not render as a negative time).
 */
export function elapsedSeconds(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return (to - from) / 1000;
}

/** Turnaround of a finished job; sub-second runs (e.g. the local simulator) read "under 1 s". */
export function formatTurnaround(seconds: number): string {
  return seconds < 1 ? 'under 1 s' : formatDuration(seconds);
}
