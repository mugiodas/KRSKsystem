/** Clock helpers kept tiny and dependency free so tests can pin a virtual "now". */

export function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function minutesBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / 60_000;
}

/** 4:05pm style clock used on courts and queue rows. */
export function clockTime(value: string | number | null | undefined, withSeconds = false): string {
  const ms = typeof value === 'number' ? value : parseIso(value);
  if (ms === null) return '--:--';
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(date.getSeconds()).padStart(2, '0')}`;
}

/** Elapsed duration as m:ss, negative values render with a leading minus. */
export function stopwatch(startMs: number | null, nowMs: number): string {
  if (startMs === null) return '--:--';
  const total = Math.max(0, Math.round((nowMs - startMs) / 1000));
  const sign = nowMs < startMs ? '-' : '';
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function minutesLabel(minutes: number): string {
  if (!Number.isFinite(minutes)) return '--';
  const rounded = Math.round(minutes);
  if (Math.abs(rounded) < 60) return `${rounded}分`;
  return `${Math.floor(rounded / 60)}時間${rounded % 60}分`;
}

/** Relative urgency of a countdown, used for colour coding. */
export function urgencyOf(remainingMinutes: number): 'calm' | 'warn' | 'urgent' {
  if (remainingMinutes <= 5) return 'urgent';
  if (remainingMinutes <= 15) return 'warn';
  return 'calm';
}

export function formatDateTime(iso: string | null | undefined): string {
  const ms = parseIso(iso);
  if (ms === null) return '-';
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()} ${clockTime(ms)}`;
}
