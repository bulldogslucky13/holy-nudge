// Matching leader rows added by name (no ChMS id) to the Lead (ChMS) person they are. Pure functions.
//
// A wrong match would show one leader another leader's students, so these rules prefer leaving a row
// unmatched over guessing: a match needs an exact (normalised) name, exactly one unmatched row and exactly
// one Lead person with that name, and a Lead person whose current row (if any) is not in use.

/** The parts of a leader row the matching rules look at. */
export interface MatchRow {
  id: number;
  chmsIndividualId: string | null;
  name: string;
  hasLink: boolean;
  isAdmin: boolean;
  isOwner: boolean;
  subscriptionCount: number;
  /** Staff set or cleared this row's match by hand: automatic matching leaves it alone. */
  matchByHand: boolean;
}

/** One merge: `keepId` (the row with the link) takes `chmsId`; `dropId` (that person's spare row, if any) is deleted. */
export interface Merge {
  keepId: number;
  chmsId: string;
  dropId: number | null;
}

/** Trim, collapse whitespace, Unicode NFC, case-insensitive. */
export function normalizeName(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A row that "holds" its Lead person: it has a working link, staff or owner flags, or devices. Such a row is
 * never deleted by a merge, so its Lead person cannot be matched to anyone else. A row with none of these is
 * a spare, created automatically from Lead data, and can give its Lead person up.
 */
export function holdsLeadPerson(r: Pick<MatchRow, 'hasLink' | 'isAdmin' | 'isOwner' | 'subscriptionCount'>): boolean {
  return r.hasLink || r.isAdmin || r.isOwner || r.subscriptionCount > 0;
}

/**
 * Which name-only rows to tie to which Lead person. `rows` are every leader row AFTER the Lead people were
 * upserted; `people` are the Lead people just seen. A row with no ChMS id (and not decided by hand) is
 * matched to Lead person P only when all of these hold:
 *  - its normalised name equals P's normalised Lead name;
 *  - no other row without a ChMS id has that name (hand-decided rows count here too);
 *  - no other Lead person has that name, counting both the people seen now and every row that already has
 *    a ChMS id (a row's own name stands in for a person not seen today);
 *  - P's current row, if any, does not hold P (see holdsLeadPerson). That row is the spare to delete.
 * Running it again after the merges finds nothing (idempotent): matched rows have a ChMS id.
 */
export function planMatches(rows: MatchRow[], people: { id: string; name: string }[]): Merge[] {
  const unmatched = new Map<string, MatchRow[]>();
  for (const r of rows) {
    if (r.chmsIndividualId !== null) continue;
    const n = normalizeName(r.name);
    if (!n) continue;
    unmatched.set(n, [...(unmatched.get(n) ?? []), r]);
  }

  const leadIds = new Map<string, Set<string>>();
  const note = (name: string, id: string) => {
    const n = normalizeName(name);
    if (!n) return;
    let s = leadIds.get(n);
    if (!s) leadIds.set(n, (s = new Set()));
    s.add(id);
  };
  for (const p of people) note(p.name, p.id);
  for (const r of rows) if (r.chmsIndividualId !== null) note(r.name, r.chmsIndividualId);

  const rowByChms = new Map(rows.filter((r) => r.chmsIndividualId !== null).map((r) => [r.chmsIndividualId!, r]));
  const seen = new Set(people.map((p) => p.id));
  const merges: Merge[] = [];
  for (const [n, candidates] of unmatched) {
    if (candidates.length !== 1) continue;
    const keep = candidates[0]!;
    if (keep.matchByHand) continue;
    const ids = leadIds.get(n);
    if (!ids || ids.size !== 1) continue;
    const chmsId = [...ids][0]!;
    if (!seen.has(chmsId)) continue; // only people in today's Lead data
    const holder = rowByChms.get(chmsId);
    if (holder && holdsLeadPerson(holder)) continue;
    merges.push({ keepId: keep.id, chmsId, dropId: holder?.id ?? null });
  }
  return merges.sort((a, b) => a.keepId - b.keepId);
}

/** Lead people staff may match a row to: seen in Lead data now, and not held by a row in use. Sorted by name. */
export function availableLeadPeople(rows: MatchRow[], people: { id: string; name: string }[]): { id: string; name: string }[] {
  const holders = new Map(rows.filter((r) => r.chmsIndividualId !== null).map((r) => [r.chmsIndividualId!, r]));
  return people
    .filter((p) => {
      const r = holders.get(p.id);
      return !r || !holdsLeadPerson(r);
    })
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
