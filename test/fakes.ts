import { holdsLeadPerson, type Merge } from '../src/core/match';
import type { JobRunSummary, LeaderRow, NewSubscription, Store, SubscriptionRow } from '../src/db';
import type { PushPayload } from '../src/push/payload';
import type { PushSender, SendResult } from '../src/push/sender';

export interface FakeRun {
  id: number;
  ok: boolean | null;
  summary: JobRunSummary | null;
}

/** A fake leader row. `linkToken` stands in for the stored hash (the D1 store is tested for real hashing). */
export interface FakeLeader extends Omit<LeaderRow, 'subscriptionCount' | 'hasLink'> {
  linkToken: string | null;
}

/** In-memory Store with the same semantics as the D1 one. */
export class FakeStore implements Store {
  leaders: FakeLeader[] = [];
  subs: SubscriptionRow[] = [];
  runs: FakeRun[] = [];
  rate = new Map<string, { windowStart: number; count: number }>();
  private nextId = 1;

  addLeader(over: Partial<Omit<FakeLeader, 'id'>> & { name: string }, devices = 0): number {
    const id = this.nextId++;
    this.leaders.push({
      id, chmsIndividualId: null, linkToken: `tok-${id}`, isAdmin: false, isOwner: false, lastSeenAt: null, revokedAt: null, matchByHand: false, ...over,
    });
    for (let i = 0; i < devices; i++) this.subs.push({ id: this.nextId++, leaderId: id, endpoint: `https://push.example/${id}/${i}`, p256dh: 'k', auth: 'a' });
    return id;
  }

  private row(l: FakeLeader): LeaderRow {
    const { linkToken, ...rest } = l;
    return { ...rest, hasLink: linkToken !== null && l.revokedAt === null, subscriptionCount: this.subs.filter((s) => s.leaderId === l.id).length };
  }

  async upsertLeaders(people: { id: string; name: string }[]) {
    for (const p of people) {
      const row = this.leaders.find((l) => l.chmsIndividualId === p.id);
      if (row) { if (!row.isAdmin && !row.isOwner) row.name = p.name; }
      else this.addLeader({ chmsIndividualId: p.id, name: p.name, linkToken: null });
    }
  }
  async listLeaders(): Promise<LeaderRow[]> {
    return this.leaders.map((l) => this.row(l));
  }
  private spare(dropId: number, chmsId: string, keepId: number): FakeLeader | null {
    const d = this.leaders.find((l) => l.id === dropId && l.id !== keepId && l.chmsIndividualId === chmsId);
    return d && !holdsLeadPerson(this.row(d)) ? d : null;
  }
  async applyMatches(merges: Merge[]) {
    let n = 0;
    for (const m of merges) {
      const keep = this.leaders.find((l) => l.id === m.keepId && l.chmsIndividualId === null && !l.matchByHand);
      if (!keep) continue;
      if (m.dropId !== null) {
        const d = this.spare(m.dropId, m.chmsId, m.keepId);
        if (d) this.leaders = this.leaders.filter((l) => l !== d);
      }
      if (this.leaders.some((l) => l.chmsIndividualId === m.chmsId)) continue;
      keep.chmsIndividualId = m.chmsId;
      n++;
    }
    return n;
  }
  async setMatch(leaderId: number, chmsId: string | null, dropId: number | null) {
    const keep = this.leaders.find((l) => l.id === leaderId);
    if (!keep) return false;
    if (chmsId !== null) {
      if (dropId !== null) {
        const d = this.spare(dropId, chmsId, leaderId);
        if (d) this.leaders = this.leaders.filter((l) => l !== d);
      }
      if (this.leaders.some((l) => l.chmsIndividualId === chmsId && l.id !== leaderId)) return false;
    }
    keep.chmsIndividualId = chmsId;
    keep.matchByHand = true;
    return true;
  }
  async leaderById(id: number) {
    const l = this.leaders.find((x) => x.id === id);
    return l ? this.row(l) : null;
  }
  async leaderByToken(token: string) {
    const l = this.leaders.find((x) => x.linkToken === token && x.revokedAt === null);
    return l ? this.row(l) : null;
  }
  async setLinkTokenHash(leaderId: number, tokenHash: string) {
    const l = this.leaders.find((x) => x.id === leaderId);
    if (!l) return false;
    l.linkToken = `hash:${tokenHash}`;
    l.revokedAt = null;
    return true;
  }
  async createLeader(name: string, tokenHash: string, isAdmin = false) {
    if (this.leaders.some((l) => l.name.toLowerCase() === name.toLowerCase())) return null;
    return this.addLeader({ name, linkToken: `hash:${tokenHash}`, isAdmin });
  }
  async revokeLink(leaderId: number, at: Date) {
    const l = this.leaders.find((x) => x.id === leaderId);
    if (!l) return false;
    l.linkToken = null;
    l.revokedAt = at.toISOString();
    this.subs = this.subs.filter((s) => s.leaderId !== leaderId);
    return true;
  }
  async touchLastSeen(leaderId: number, at: Date, minIntervalMs: number) {
    const l = this.leaders.find((x) => x.id === leaderId);
    if (l && (!l.lastSeenAt || Date.parse(l.lastSeenAt) < at.getTime() - minIntervalMs)) l.lastSeenAt = at.toISOString();
  }
  async hitRateLimit(leaderId: number, bucket: string, windowStart: number) {
    const k = `${leaderId}/${bucket}`;
    const cur = this.rate.get(k);
    const next = cur && cur.windowStart === windowStart ? { windowStart, count: cur.count + 1 } : { windowStart, count: 1 };
    this.rate.set(k, next);
    return next.count;
  }
  async listSubscriptions(leaderId: number) {
    return this.subs.filter((s) => s.leaderId === leaderId);
  }
  async saveSubscription(leaderId: number, sub: NewSubscription) {
    const old = this.subs.find((s) => s.endpoint === sub.endpoint);
    if (old && old.leaderId !== leaderId && !(old.p256dh === sub.p256dh && old.auth === sub.auth)) return false;
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push({ id: this.nextId++, leaderId, ...sub });
    return true;
  }
  async deleteSubscription(endpoint: string, leaderId?: number) {
    this.subs = this.subs.filter((s) => !(s.endpoint === endpoint && (leaderId === undefined || s.leaderId === leaderId)));
  }
  async markSubscriptionOk() {}
  async startJobRun() {
    const id = this.runs.length + 1;
    this.runs.push({ id, ok: null, summary: null });
    return id;
  }
  async finishJobRun(id: number, ok: boolean, summary: JobRunSummary) {
    const r = this.runs.find((x) => x.id === id)!;
    r.ok = ok;
    r.summary = summary;
  }
}

/** Records every push; endpoints listed in `gone` answer 410. */
export class FakeSender implements PushSender {
  sent: { endpoint: string; payload: PushPayload }[] = [];
  constructor(private gone: string[] = []) {}
  async send(sub: { endpoint: string }, payload: PushPayload): Promise<SendResult> {
    if (this.gone.includes(sub.endpoint)) return { ok: false, gone: true, status: 410 };
    this.sent.push({ endpoint: sub.endpoint, payload });
    return { ok: true, gone: false, status: 201 };
  }
}
