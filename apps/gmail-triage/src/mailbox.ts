import { DurableObject } from 'cloudflare:workers';
import { GmailClient } from './gmail';
import { evaluateEmail } from './jev';
import { MailboxEngine, type MailboxStatus, type MailboxStorage } from './mailbox-engine';
import type { Env } from './types';

export class Mailbox extends DurableObject<Env> {
  private readonly ready: Promise<void>;
  private engine?: MailboxEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get('mailbox:state');
      if (!state) await ctx.storage.put('mailbox:state', { initialized: false, nextJobId: 1 });
    });
  }

  private getEngine(): MailboxEngine {
    if (this.engine) return this.engine;
    const storage: MailboxStorage = {
      get: (key) => this.ctx.storage.get(key),
      put: (key, value) => this.ctx.storage.put(key, value),
      delete: async (key) => { await this.ctx.storage.delete(key); },
      list: (options) => this.ctx.storage.list(options),
      getAlarm: () => this.ctx.storage.getAlarm(),
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
    };
    this.engine = new MailboxEngine(storage, {
      createGmail: () => new GmailClient(this.env),
      evaluate: (state) => evaluateEmail(this.env, state),
      watchTopic: this.env.GMAIL_PUBSUB_TOPIC,
      timezone: this.env.MAILBOX_TIMEZONE ?? 'UTC',
    });
    return this.engine;
  }

  async enqueueNotification(historyId: string): Promise<{ accepted: boolean; reason?: string }> {
    await this.ready;
    return this.getEngine().enqueueNotification(historyId);
  }

  async enqueueScan(): Promise<{ accepted: boolean; jobId?: string }> {
    await this.ready;
    return this.getEngine().enqueueScan();
  }

  async enqueueWatch(): Promise<{ accepted: boolean; jobId?: string }> {
    await this.ready;
    return this.getEngine().enqueueWatch();
  }

  async enqueueReprocess(ids: string[]): Promise<{ accepted: boolean; jobId?: string; ids: string[] }> {
    await this.ready;
    return this.getEngine().enqueueReprocess(ids);
  }

  async resume(): Promise<{ accepted: true }> {
    await this.ready;
    return this.getEngine().resume();
  }

  async getStatus(): Promise<MailboxStatus> {
    await this.ready;
    return this.getEngine().getStatus();
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.getEngine().alarm();
  }
}
