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
