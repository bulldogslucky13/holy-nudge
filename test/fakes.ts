import type { JobRunSummary, LeaderRow, NewSubscription, Store, SubscriptionRow } from '../src/db';
import type { PushPayload } from '../src/push/payload';
import type { PushSender, SendResult } from '../src/push/sender';

export interface FakeRun {
  id: number;
  ok: boolean | null;
  summary: JobRunSummary | null;
}

/** In-memory Store with the same semantics as the D1 one. */
export class FakeStore implements Store {
  leaders: Omit<LeaderRow, 'subscriptionCount'>[] = [];
  subs: SubscriptionRow[] = [];
  runs: FakeRun[] = [];
  private nextId = 1;

  addLeader(over: Partial<Omit<LeaderRow, 'id' | 'subscriptionCount'>> & { name: string }, devices = 0): number {
    const id = this.nextId++;
    this.leaders.push({ id, chmsIndividualId: null, token: `tok-${id}`, isAdmin: false, isOwner: false, ...over });
    for (let i = 0; i < devices; i++) this.subs.push({ id: this.nextId++, leaderId: id, endpoint: `https://push.example/${id}/${i}`, p256dh: 'k', auth: 'a' });
    return id;
  }

  async upsertLeaders(people: { id: string; name: string }[]) {
    for (const p of people) {
      const row = this.leaders.find((l) => l.chmsIndividualId === p.id);
      if (row) row.name = p.name;
      else this.addLeader({ chmsIndividualId: p.id, name: p.name });
    }
  }
  async listLeaders(): Promise<LeaderRow[]> {
    return this.leaders.map((l) => ({ ...l, subscriptionCount: this.subs.filter((s) => s.leaderId === l.id).length }));
  }
  async leaderByToken(token: string) {
    return (await this.listLeaders()).find((l) => l.token === token) ?? null;
  }
  async listSubscriptions(leaderId: number) {
    return this.subs.filter((s) => s.leaderId === leaderId);
  }
  async saveSubscription(leaderId: number, sub: NewSubscription) {
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push({ id: this.nextId++, leaderId, ...sub });
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
