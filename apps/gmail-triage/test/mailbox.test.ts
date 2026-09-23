import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailApiError, type GmailClient } from '../src/gmail';
import { JevEvaluationError } from '../src/jev';
import { MailboxEngine, type MailboxStorage, type MailboxJob, type MailboxState } from '../src/mailbox-engine';
import type { EmailEvaluation, GmailMessage } from '../src/types';

class MemoryStorage implements MailboxStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))
      .map(([key, value]) => [key, structuredClone(value) as T]));
  }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(at: number): Promise<void> { this.alarm = at; }
}

class FakeGmail {
  profile = { emailAddress: 'user@example.com', historyId: '100' };
  historyPages = [
    { messageIds: ['a1'], nextPageToken: 'next', historyId: '102' },
    { messageIds: ['b2'], historyId: '105' },
  ];
  messagePages = [
    { messages: [{ id: 'a1' }], nextPageToken: 'next' },
    { messages: [{ id: 'b2' }] },
  ];
  messages = new Map<string, GmailMessage>([
    ['a1', { id: 'a1', labelIds: ['INBOX'], snippet: 'a1', payload: { headers: [] } }],
    ['b2', { id: 'b2', labelIds: ['INBOX'], snippet: 'b2', payload: { headers: [] } }],
    ['abc123', { id: 'abc123', labelIds: ['INBOX'], snippet: 'explicit', payload: { headers: [] } }],
  ]);
  applied: string[] = [];
  replaceFailures = 0;
  watchCalls = 0;
  historyCalls = 0;
  scanCalls = 0;
  historyExpired = false;

  async getProfile() { return this.profile; }
  async listHistoryPage(_start: string, pageToken?: string) {
    this.historyCalls += 1;
    if (this.historyExpired) throw new GmailApiError(404, 'notFound');
    return this.historyPages[pageToken ? 1 : 0];
  }
  async listMessagesPage(_query: string, _max: number, pageToken?: string) {
    this.scanCalls += 1;
    return this.messagePages[pageToken ? 1 : 0];
  }
  async getMessage(id: string, _format: 'metadata' | 'full') { return structuredClone(this.messages.get(id)!); }
  async ensureLabels(names: string[]) { return new Map(names.map((name) => [name, 'label-' + name.replace('/', '-')])); }
  async replaceManagedLabels(id: string, add: string[], _managed: string[]) {
    if (this.replaceFailures > 0) {
      this.replaceFailures -= 1;
      throw new GmailApiError(429, 'rateLimitExceeded', 5_000);
    }
    this.applied.push(id + ':' + add.join(','));
  }
  async watch(_topic: string) { this.watchCalls += 1; return { historyId: '999', expiration: '2099-01-01T00:00:00Z' }; }
}

function evaluation(): EmailEvaluation {
  return { requiresReply: 0, unsolicitedSales: 0, priority: 0, raw: {} };
}

function engineFixture(overrides: Partial<{ now: () => number; gmail: FakeGmail; evaluate: (state: unknown) => Promise<EmailEvaluation> }> = {}) {
  const storage = new MemoryStorage();
  const gmail = overrides.gmail ?? new FakeGmail();
  let now = 1_000;
  const engine = new MailboxEngine(storage, {
    createGmail: () => gmail as unknown as GmailClient,
    evaluate: (overrides.evaluate ?? (async () => evaluation())) as (state: unknown) => Promise<EmailEvaluation>,
    watchTopic: 'projects/test/topics/gmail',
    timezone: 'Asia/Tokyo',
    now: overrides.now ?? (() => now),
  });
  return { storage, gmail, engine, advance: (ms: number) => { now += ms; } };
}

afterEach(() => vi.restoreAllMocks());

describe('MailboxEngine', () => {
  it('preserves labels added by Gmail filters and the user', async () => {
    const { engine, storage, gmail } = engineFixture();
    const replace = vi.spyOn(gmail, 'replaceManagedLabels');
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await engine.enqueueReprocess(['abc123']);
    await engine.alarm();
    await engine.alarm();
    expect(replace).toHaveBeenCalledWith('abc123', expect.any(Array), []);
  });

  it('persists history page IDs before advancing the monotonic cursor', async () => {
    const { engine, storage, gmail } = engineFixture();
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await engine.enqueueNotification('105');
    await engine.alarm();
    expect(gmail.historyCalls).toBe(1);
    expect((await storage.get<{ historyCursor: string }>('mailbox:state'))?.historyCursor).toBe('100');
    const first = [...(await storage.list<{ messageIds: string[] }>({ prefix: 'job:' })).values()][0];
    expect(first.messageIds).toEqual(['a1']);
    await engine.alarm();
    expect((await storage.get<{ historyCursor: string }>('mailbox:state'))?.historyCursor).toBe('105');
  });

  it('deduplicates old notifications and keeps only one history job', async () => {
    const { engine, storage } = engineFixture();
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await expect(engine.enqueueNotification('101')).resolves.toMatchObject({ accepted: true });
    await expect(engine.enqueueNotification('100')).resolves.toMatchObject({ accepted: false });
    await expect(engine.enqueueNotification('101')).resolves.toMatchObject({ accepted: false });
    expect((await storage.list({ prefix: 'job:' })).size).toBe(1);
  });

  it('stores watch expiration without changing the history cursor', async () => {
    const { engine, storage, gmail } = engineFixture();
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '200' });
    await engine.enqueueWatch();
    await engine.alarm();
    const state = await storage.get<{ historyCursor?: string; watchExpiration?: string }>('mailbox:state');
    expect(gmail.watchCalls).toBe(1);
    expect(state).toMatchObject({ historyCursor: '200', watchExpiration: '2099-01-01T00:00:00Z' });
  });

  it('recovers an expired history cursor with a new baseline and inbox scan', async () => {
    const gmail = new FakeGmail();
    gmail.historyExpired = true;
    const { engine, storage } = engineFixture({ gmail });
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '1' });
    await engine.enqueueNotification('105');
    await engine.alarm();
    const status = await engine.getStatus();
    expect(status.failed).toContainEqual(expect.objectContaining({ errorCode: 'history_expired' }));
    expect(status.jobs.pending).toBe(1);
    expect((await storage.get<{ historyCursor: string }>('mailbox:state'))?.historyCursor).toBe('100');
  });

  it('does not re-run AI after a label retry cooldown', async () => {
    const gmail = new FakeGmail();
    gmail.replaceFailures = 1;
    let evaluations = 0;
    const fixture = engineFixture({ gmail, evaluate: async () => { evaluations += 1; return evaluation(); } });
    await fixture.storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await fixture.engine.enqueueReprocess(['abc123']);
    await fixture.engine.alarm();
    expect(evaluations).toBe(1);
    await fixture.engine.alarm();
    expect(gmail.applied).toEqual([]);
    fixture.advance(5_000);
    await fixture.engine.alarm();
    expect(evaluations).toBe(1);
    expect(gmail.applied).toHaveLength(1);
  });

  it('marks invalid AI responses failed without applying Triaged labels', async () => {
    const gmail = new FakeGmail();
    const fixture = engineFixture({ gmail, evaluate: async () => { throw new JevEvaluationError('invalid_ai_response', 'answers.priority'); } });
    await fixture.storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await fixture.engine.enqueueReprocess(['abc123']);
    await fixture.engine.alarm();
    const status = await fixture.engine.getStatus();
    expect(status.jobs.failed).toBe(1);
    expect(gmail.applied).toEqual([]);
    expect((await fixture.engine.getStatus()).quarantined).toContainEqual({ messageId: 'abc123', errorCode: 'invalid_ai_response' });
  });

  it('does not let a quarantined message consume AI again, but explicit reprocess clears it', async () => {
    let evaluations = 0;
    const fixture = engineFixture({ evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) throw new JevEvaluationError('invalid_ai_response', 'answers.priority');
      return evaluation();
    } });
    fixture.gmail.messagePages = [{ messages: [{ id: 'abc123' }] }];
    await fixture.storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await fixture.engine.enqueueReprocess(['abc123']);
    await fixture.engine.alarm();
    await fixture.engine.enqueueScan();
    await fixture.engine.alarm();
    await fixture.engine.alarm();
    expect(evaluations).toBe(1);
    await fixture.engine.enqueueReprocess(['abc123']);
    await fixture.engine.alarm();
    await fixture.engine.alarm();
    expect(evaluations).toBe(2);
    expect((await fixture.engine.getStatus()).quarantined).toEqual([]);
  });

  it('pauses on Gmail auth failure while allowing a watch job to run', async () => {
    const gmail = new FakeGmail();
    gmail.getMessage = async () => { throw new GmailApiError(401, 'invalid_grant'); };
    const fixture = engineFixture({ gmail });
    await fixture.storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await fixture.engine.enqueueReprocess(['abc123']);
    await fixture.engine.alarm();
    await fixture.engine.enqueueWatch();
    await fixture.engine.alarm();
    const status = await fixture.engine.getStatus();
    expect(status.pausedCode).toBe('gmail_auth');
    expect(gmail.watchCalls).toBe(1);
  });

  it('prioritizes watch and explicit reprocess over scan discovery', async () => {
    const fixture = engineFixture();
    await fixture.storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await fixture.engine.enqueueScan();
    await fixture.engine.enqueueWatch();
    await fixture.engine.alarm();
    expect(fixture.gmail.watchCalls).toBe(1);
    expect(fixture.gmail.scanCalls).toBe(0);
  });

  it('persists the final discovery phase before the advanced cursor', async () => {
    const { engine, storage } = engineFixture();
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await engine.enqueueNotification('105');
    const put = storage.put.bind(storage);
    storage.put = async (key, value) => {
      if (key === 'mailbox:state' && (value as MailboxState).historyCursor === '105') {
        const job = await storage.get<MailboxJob>('job:history-1');
        expect(job).toMatchObject({ phase: 'process', startHistoryId: '100', messageIds: ['a1', 'b2'] });
      }
      await put(key, value);
    };
    await engine.alarm();
    await engine.alarm();
  });

  it('does not drop the rest of a batch after an invalid AI response', async () => {
    let evaluations = 0;
    const { engine, storage, gmail } = engineFixture({ evaluate: async () => {
      evaluations++;
      if (evaluations === 1) throw new JevEvaluationError('invalid_ai_response');
      return evaluation();
    } });
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await engine.enqueueReprocess(['a1', 'b2']);
    for (let i = 0; i < 3; i++) await engine.alarm();
    expect(evaluations).toBe(2);
    expect(gmail.applied).toEqual([expect.stringContaining('b2:')]);
    expect((await engine.getStatus()).failed).toContainEqual(expect.objectContaining({ messageId: 'a1' }));
  });

  it('keeps notification changes made while label discovery awaits Gmail', async () => {
    const { engine, storage, gmail } = engineFixture();
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    const ensureLabels = gmail.ensureLabels.bind(gmail);
    gmail.ensureLabels = async names => {
      await engine.enqueueNotification('107');
      return ensureLabels(names);
    };
    await engine.enqueueReprocess(['abc123']);
    await engine.alarm();
    await engine.enqueueScan();
    expect(await storage.get('mailbox:state')).toMatchObject({ nextJobId: 4, latestNotificationHistoryId: '107' });
    expect((await storage.list({ prefix: 'job:' })).size).toBe(3);
  });

  it('applies a saved evaluation before starting higher-priority history discovery', async () => {
    const { engine, storage, gmail } = engineFixture();
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await engine.enqueueScan();
    for (let i = 0; i < 3; i++) await engine.alarm();
    await engine.enqueueNotification('105');
    await engine.alarm();
    expect(gmail.applied).toHaveLength(1);
    expect(gmail.historyCalls).toBe(0);
  });

  it('treats a deleted message as a per-message failure, not an expired history cursor', async () => {
    const { engine, storage, gmail } = engineFixture();
    const getMessage = gmail.getMessage.bind(gmail);
    gmail.getMessage = async (id, format) => {
      if (id === 'a1') throw new GmailApiError(404, 'notFound');
      return getMessage(id, format);
    };
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '100' });
    await engine.enqueueNotification('105');
    for (let i = 0; i < 5; i++) await engine.alarm();
    expect(gmail.applied).toEqual([expect.stringContaining('b2:')]);
    expect((await engine.getStatus()).failed).not.toContainEqual(expect.objectContaining({ errorCode: 'history_expired' }));
  });

  it('creates a fresh backfill when the existing scan already read a page', async () => {
    const { engine, storage, gmail } = engineFixture();
    await storage.put('mailbox:state', { initialized: true, nextJobId: 1, historyCursor: '1' });
    await engine.enqueueScan();
    await engine.alarm();
    gmail.historyExpired = true;
    await engine.enqueueNotification('105');
    await engine.alarm();
    const scans = [...(await storage.list<MailboxJob>({ prefix: 'job:' })).values()].filter(job => job.kind === 'scan');
    expect(scans).toHaveLength(2);
    expect(scans.some(job => job.messageIds.length === 0 && !job.pageToken)).toBe(true);
  });
});
