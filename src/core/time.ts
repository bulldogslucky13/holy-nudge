// Calendar-date helpers. Pure: no Date.now(), no I/O. Uses Intl only (no date library).

export const HOUR_MS = 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The calendar date ("YYYY-MM-DD") of an instant in the given IANA zone. */
export function zonedDate(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid instant');
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}(:?\d{2})?)$/i;

/**
 * The calendar date ("YYYY-MM-DD") a ChMS due value refers to.
 * - Date-only values are returned as-is.
 * - Datetimes with an offset (or Z) are converted to the zone's calendar date.
 * - Datetimes with no offset are taken as already local: their date part is used.
 */
export function dueToDate(due: string, timeZone: string): string {
  const s = due.trim();
  if (DATE_ONLY.test(s)) return s;
  if (!HAS_OFFSET.test(s)) {
    const m = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(s);
    if (!m || !m[1]) throw new RangeError(`Unrecognised due value: ${due}`);
    return m[1];
  }
  return zonedDate(new Date(s), timeZone);
}

/** Add whole calendar days to a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Offset (ms) of `timeZone` from UTC at an instant: local wall time minus UTC. */
const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneOffsetMs(instant: number, timeZone: string): number {
  let f = wallFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    wallFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return wall - (instant - (instant % 1000 + 1000) % 1000);
}

/** The instant (epoch ms) at which a local wall-clock time occurs in `timeZone`. */
export function zonedWallTimeToInstant(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  timeZone: string,
): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  // Two passes settle the offset on either side of a DST change.
  let instant = wall - zoneOffsetMs(wall, timeZone);
  instant = wall - zoneOffsetMs(instant, timeZone);
  return instant;
}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/**
 * The instant a ChMS `created` value stands for, for elapsed-time rules (24 h unassigned).
 * - Date-only ("2026-09-15", which the Pushpay guide shows) is taken as the END of that
 *   calendar day in `timeZone` (the next local midnight), so it can never look older than it is.
 * - Datetimes with an offset (or Z) are exact.
 * - Datetimes with no offset are local wall time in `timeZone` (as for due values).
 */
export function createdToInstant(created: string, timeZone: string): number {
  const s = created.trim();
  if (DATE_ONLY.test(s)) {
    const next = addDays(s, 1);
    const [y, m, d] = next.split('-').map(Number) as [number, number, number];
    return zonedWallTimeToInstant(y, m, d, 0, 0, 0, 0, timeZone);
  }
  const local = LOCAL_DATETIME.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, sec, frac] = local;
    return zonedWallTimeToInstant(
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      Number(sec ?? 0),
      Number((frac ?? '0').padEnd(3, '0')),
      timeZone,
    );
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new RangeError(`Invalid created value: ${created}`);
  return t;
}
