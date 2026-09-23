import { GmailApiError, type GmailClient } from './gmail';
import { extractBodyText } from './mime';
import { JevEvaluationError } from './jev';
import { LABELS, LABEL_NAMES, labelsForEvaluation } from './rules';
import type { EmailEvaluation, EmailState, GmailMessage } from './types';

export type MailboxJobKind = 'history' | 'scan' | 'watch' | 'reprocess';
export type MailboxJobStatus = 'pending' | 'evaluated' | 'done' | 'failed' | 'paused';
export type MailboxJobPhase = 'discover' | 'process';

export interface SavedEvaluation {
  matchedRuleIds?: string[];
  aiReason?: 'complete_rule' | 'requires_evaluation';
  source?: 'rule' | 'ai';
  category?: string;
  categoryConfidence?: number;
  requiresReply: number;
  unsolicitedSales: number;
  priority: number;
  labels: string[];
  evaluatedAt: number;
  timezone: string;
}

export interface MailboxJob {
  id: string;
  kind: MailboxJobKind;
  phase: MailboxJobPhase;
  status: MailboxJobStatus;
  createdAt: number;
  messageIds: string[];
  index: number;
  pageToken?: string;
  startHistoryId?: string;
  targetHistoryId?: string;
  discoveredHistoryId?: string;
  evaluation?: SavedEvaluation;
  errorCode?: string;
  attempts: number;
  failedMessages?: Array<{ messageId: string; errorCode: string }>;
}

export interface MailboxState {
  initialized: boolean;
  nextJobId: number;
  baselineHistoryId?: string;
  initializationPending?: boolean;
  historyCursor?: string;
  latestNotificationHistoryId?: string;
  watchExpiration?: string;
  labelIds?: Record<string, string>;
  pausedCode?: 'ai_credits' | 'gmail_auth';
  cooldownUntil?: number;
  lastErrorCode?: string;
  lastErrorAt?: number;
  initializationAttempts?: number;
}

export interface MailboxStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

export interface MailboxDependencies {
  createGmail: () => GmailClient;
  evaluate: (state: EmailState) => Promise<EmailEvaluation>;
  watchTopic?: string;
  timezone?: string;
  now?: () => number;
}

export interface MailboxStatus {
  initialized: boolean;
  paused: boolean;
  pausedCode?: string;
  cooldownUntil?: number;
  historyCursor?: string;
  latestNotificationHistoryId?: string;
  lastErrorCode?: string;
  lastErrorAt?: number;
  watchExpiration?: string;
  alarmAt: number | null;
  jobs: Record<MailboxJobStatus, number>;
  failed: Array<{ jobId: string; kind: MailboxJobKind; messageId?: string; errorCode?: string }>;
  quarantined: Array<{ messageId: string; errorCode: string }>;
}

const STATE_KEY = 'mailbox:state';
const JOB_PREFIX = 'job:';
const BATCH_DELAY_MS = 2_000;
function defaultState(): MailboxState {
  return { initialized: false, nextJobId: 1 };
}

function jobKey(id: string): string {
  return JOB_PREFIX + id;
}

function failureKey(messageId: string): string {
  return 'failure:' + messageId;
}

function isHistoryId(value: string): boolean {
  return /^[0-9]{1,30}$/.test(value);
}

function compareHistoryId(left: string, right: string): number {
  return BigInt(left) === BigInt(right) ? 0 : BigInt(left) > BigInt(right) ? 1 : -1;
}

function maxHistoryId(left: string | undefined, right: string): string {
  return !left || compareHistoryId(right, left) > 0 ? right : left;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function active(job: MailboxJob): boolean {
  return job.status === 'pending' || job.status === 'evaluated' || job.status === 'paused';
}

function isExplicit(job: MailboxJob): boolean {
  return job.kind === 'reprocess';
}

function safeErrorCode(error: unknown): string {
  if (error instanceof JevEvaluationError) return error.code;
  if (error instanceof GmailApiError) return error.retryable ? 'gmail_retryable' : 'gmail_failed';
  return 'mailbox_failed';
}

function isTransientFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name);
}

export class MailboxEngine {
  private readonly now: () => number;

  constructor(private readonly storage: MailboxStorage, private readonly deps: MailboxDependencies) {
    this.now = deps.now ?? Date.now;
  }

  private async state(): Promise<MailboxState> {
    const stored = await this.storage.get<MailboxState>(STATE_KEY);
    if (stored) return stored;
    const initial = defaultState();
    await this.storage.put(STATE_KEY, initial);
    return initial;
  }

  private async saveState(state: MailboxState): Promise<void> {
    await this.storage.put(STATE_KEY, state);
  }

  private async jobs(): Promise<MailboxJob[]> {
    const values = [...(await this.storage.list<MailboxJob>({ prefix: JOB_PREFIX })).values()];
    return values.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  private async job(id: string): Promise<MailboxJob | undefined> {
    return this.storage.get<MailboxJob>(jobKey(id));
  }

  private async saveJob(job: MailboxJob): Promise<void> {
    await this.storage.put(jobKey(job.id), job);
  }

  private async createJob(input: Pick<MailboxJob, 'kind' | 'phase' | 'messageIds'> & Partial<MailboxJob>): Promise<MailboxJob> {
    const state = await this.state();
    const id = input.id ?? input.kind + '-' + state.nextJobId;
    const job: MailboxJob = {
      id,
      kind: input.kind,
      phase: input.phase,
      status: input.status ?? 'pending',
      createdAt: input.createdAt ?? this.now(),
      messageIds: input.messageIds,
      index: input.index ?? 0,
      pageToken: input.pageToken,
      startHistoryId: input.startHistoryId,
      targetHistoryId: input.targetHistoryId,
      discoveredHistoryId: input.discoveredHistoryId,
      evaluation: input.evaluation,
      errorCode: input.errorCode,
      attempts: input.attempts ?? 0,
      failedMessages: input.failedMessages,
    };
    state.nextJobId += 1;
    await this.saveState(state);
    await this.saveJob(job);
    return job;
  }

  private async arm(delayMs: number): Promise<void> {
    const at = this.now() + Math.max(0, delayMs);
    const existing = await this.storage.getAlarm();
    if (existing === null || existing > at) await this.storage.setAlarm(at);
  }

  private async hasRunnableJob(): Promise<boolean> {
    return (await this.jobs()).some((job) => job.status === 'pending' || job.status === 'evaluated');
  }

  async enqueueNotification(historyId: string): Promise<{ accepted: boolean; reason?: string }> {
    if (!isHistoryId(historyId)) throw new Error('invalid historyId');
    const state = await this.state();
    if (state.latestNotificationHistoryId && compareHistoryId(historyId, state.latestNotificationHistoryId) <= 0) {
      return { accepted: false, reason: 'old_notification' };
    }

    const jobs = await this.jobs();
    const existing = jobs.find((job) => job.kind === 'history' && job.phase === 'discover' && active(job));
    if (existing) {
      const latest = await this.job(existing.id) ?? existing;
      latest.targetHistoryId = maxHistoryId(latest.targetHistoryId, historyId);
      await this.saveJob(latest);
    } else {
      await this.createJob({
        kind: 'history',
        phase: 'discover',
        messageIds: [],
        targetHistoryId: historyId,
        startHistoryId: state.initialized ? state.historyCursor : undefined,
      });
    }
    const latestState = await this.state();
    latestState.latestNotificationHistoryId = maxHistoryId(latestState.latestNotificationHistoryId, historyId);
    await this.saveState(latestState);
    await this.arm(0);
    return { accepted: true };
  }

  async enqueueScan(): Promise<{ accepted: boolean; jobId?: string }> {
    const existing = (await this.jobs()).find((job) => job.kind === 'scan' && active(job));
    if (existing) return { accepted: false, jobId: existing.id };
    const job = await this.createJob({ kind: 'scan', phase: 'discover', messageIds: [] });
    await this.arm(0);
    return { accepted: true, jobId: job.id };
  }

  async enqueueWatch(): Promise<{ accepted: boolean; jobId?: string }> {
    const existing = (await this.jobs()).find((job) => job.kind === 'watch' && active(job));
    if (existing) return { accepted: false, jobId: existing.id };
    const job = await this.createJob({ kind: 'watch', phase: 'process', messageIds: [] });
    await this.arm(0);
    return { accepted: true, jobId: job.id };
  }

  async enqueueReprocess(ids: string[]): Promise<{ accepted: boolean; jobId?: string; ids: string[] }> {
    if (ids.length === 0 || ids.length > 20 || ids.some((id) => !/^[0-9a-f]+$/i.test(id))) {
      throw new Error('invalid reprocess ids');
    }
    const busy = new Set<string>();
    for (const job of await this.jobs()) {
      if (!active(job) || job.phase !== 'process') continue;
      for (const id of job.messageIds.slice(job.index)) busy.add(id);
    }
    const available = uniqueIds(ids).filter((id) => !busy.has(id));
    if (available.length === 0) return { accepted: false, ids: [] };
    const job = await this.createJob({ kind: 'reprocess', phase: 'process', messageIds: available });
    await this.arm(0);
    return { accepted: true, jobId: job.id, ids: available };
  }

  async resume(): Promise<{ accepted: true }> {
    const state = await this.state();
    state.pausedCode = undefined;
    state.cooldownUntil = undefined;
    state.lastErrorCode = undefined;
    await this.saveState(state);
    for (const job of await this.jobs()) {
      if (job.status === 'paused') {
        job.status = job.evaluation ? 'evaluated' : 'pending';
        job.errorCode = undefined;
        await this.saveJob(job);
      }
    }
    await this.arm(0);
    return { accepted: true };
  }

  async getStatus(): Promise<MailboxStatus> {
    const state = await this.state();
    const jobs = await this.jobs();
    const counts: Record<MailboxJobStatus, number> = { pending: 0, evaluated: 0, done: 0, failed: 0, paused: 0 };
    for (const job of jobs) counts[job.status] += 1;
    const failed: MailboxStatus['failed'] = [];
    for (const job of jobs) {
      for (const failure of job.failedMessages ?? []) failed.push({ jobId: job.id, kind: job.kind, messageId: failure.messageId, errorCode: failure.errorCode });
      if (job.status === 'failed' && !job.failedMessages?.length) failed.push({ jobId: job.id, kind: job.kind, errorCode: job.errorCode });
    }
    return {
      initialized: state.initialized,
      paused: Boolean(state.pausedCode),
      pausedCode: state.pausedCode,
      cooldownUntil: state.cooldownUntil,
      historyCursor: state.historyCursor,
      latestNotificationHistoryId: state.latestNotificationHistoryId,
      lastErrorCode: state.lastErrorCode,
      lastErrorAt: state.lastErrorAt,
      watchExpiration: state.watchExpiration,
      alarmAt: await this.storage.getAlarm(),
      jobs: counts,
      failed,
      quarantined: [...(await this.storage.list<{ errorCode: string }>({ prefix: 'failure:' })).entries()]
        .map(([key, value]) => ({ messageId: key.slice('failure:'.length), errorCode: value.errorCode })),
    };
  }

  async alarm(): Promise<void> {
    let state = await this.state();
    if (state.cooldownUntil && state.cooldownUntil > this.now()) {
      await this.arm(state.cooldownUntil - this.now());
      return;
    }
    if (state.pausedCode) {
      const watchJob = (await this.jobs()).find((job) => job.kind === 'watch' && (job.status === 'pending' || job.status === 'evaluated'));
      if (!watchJob) return;
      try {
        await this.runJob(watchJob);
      } catch (error) {
        await this.handleFailure(watchJob, error);
      }
      return;
    }
    if (state.cooldownUntil) {
      state.cooldownUntil = undefined;
      await this.saveState(state);
    }

    if (!state.initialized) {
      try {
        await this.initializeMailbox();
      } catch (error) {
        await this.handleFailure(undefined, error);
        return;
      }
      await this.arm(BATCH_DELAY_MS);
      return;
    }

    const job = this.nextRunnableJob(await this.jobs());
    if (!job) return;
    try {
      await this.runJob(job);
    } catch (error) {
      await this.handleFailure(job, error);
    }

    state = await this.state();
    if (state.pausedCode) return;
    if (state.cooldownUntil) {
      await this.arm(Math.max(0, state.cooldownUntil - this.now()));
    } else if (await this.hasRunnableJob()) {
      await this.arm(BATCH_DELAY_MS);
    }
  }

  private async initializeMailbox(): Promise<void> {
    const state = await this.state();
    let baselineHistoryId = state.baselineHistoryId;
    if (!baselineHistoryId) {
      const profile = await this.deps.createGmail().getProfile();
      if (!profile || !isHistoryId(profile.historyId)) throw new Error('invalid Gmail profile');
      baselineHistoryId = profile.historyId;
      const pendingState = await this.state();
      pendingState.baselineHistoryId = baselineHistoryId;
      pendingState.initializationPending = true;
      await this.saveState(pendingState);
    }
    const existingScan = (await this.jobs()).some((job) => job.kind === 'scan' && active(job));
    if (!existingScan) await this.createJob({ kind: 'scan', phase: 'discover', messageIds: [] });
    const initializedState = await this.state();
    initializedState.initialized = true;
    initializedState.initializationPending = false;
    initializedState.initializationAttempts = 0;
    initializedState.historyCursor = maxHistoryId(initializedState.historyCursor, baselineHistoryId);
    await this.saveState(initializedState);
  }

  private async runJob(job: MailboxJob): Promise<void> {
    if (job.kind === 'watch') {
      if (!this.deps.watchTopic) throw new Error('GMAIL_PUBSUB_TOPIC is not configured');
      const result = await this.deps.createGmail().watch(this.deps.watchTopic);
      const state = await this.state();
      state.watchExpiration = result.expiration;
      await this.saveState(state);
      job.status = 'done';
      await this.saveJob(job);
      return;
    }
    if (job.phase === 'discover') {
      if (job.kind === 'history') await this.discoverHistory(job);
      else await this.discoverScan(job);
      return;
    }
    await this.processMessage(job);
  }

  private async discoverHistory(job: MailboxJob): Promise<void> {
    const state = await this.state();
    const startHistoryId = job.startHistoryId ?? state.historyCursor;
    if (!startHistoryId) throw new Error('history cursor is not initialized');
    const page = await this.deps.createGmail().listHistoryPage(startHistoryId, job.pageToken);
    const current = await this.job(job.id) ?? job;
    current.messageIds = uniqueIds([...current.messageIds, ...page.messageIds]);
    await this.saveJob(current);

    const latestJob = await this.job(job.id) ?? current;
    latestJob.startHistoryId = startHistoryId;
    latestJob.discoveredHistoryId = maxHistoryId(latestJob.discoveredHistoryId, page.historyId);
    latestJob.pageToken = page.nextPageToken;
    if (!page.nextPageToken) latestJob.phase = 'process';
    // Persist the complete discovery before advancing the shared cursor.
    await this.saveJob(latestJob);
    if (!page.nextPageToken) {
      const latestState = await this.state();
      latestState.historyCursor = maxHistoryId(latestState.historyCursor, latestJob.discoveredHistoryId!);
      await this.saveState(latestState);
    }
  }

  private async discoverScan(job: MailboxJob): Promise<void> {
    const page = await this.deps.createGmail().listMessagesPage('in:inbox -label:AI/Triaged', 100, job.pageToken);
    const current = await this.job(job.id) ?? job;
    current.messageIds = uniqueIds([...current.messageIds, ...page.messages.map((message) => message.id)]);
    await this.saveJob(current);
    const latestJob = await this.job(job.id) ?? current;
    latestJob.pageToken = page.nextPageToken;
    if (!page.nextPageToken) latestJob.phase = 'process';
    await this.saveJob(latestJob);
  }

  private async processMessage(job: MailboxJob): Promise<void> {
    if (job.index >= job.messageIds.length) {
      await this.completeJob(job);
      return;
    }
    const messageId = job.messageIds[job.index];
    const gmail = this.deps.createGmail();
    const explicit = isExplicit(job);

    if (explicit) await this.storage.delete(failureKey(messageId));
    else if (await this.storage.get(failureKey(messageId))) {
      await this.advanceJob(job);
      return;
    }

    if (job.status === 'evaluated' && job.evaluation) {
      await this.applyEvaluation(job, messageId, gmail);
      return;
    }

    const message = await gmail.getMessage(messageId, 'full');
    const labelIds = await this.getLabelIds(gmail);
    if (!explicit && !this.isProcessable(message, labelIds[LABELS.triaged])) {
      await this.advanceJob(job);
      return;
    }
    const evaluation = await this.deps.evaluate(this.buildEmailState(message));
    const current = await this.job(job.id) ?? job;
    current.status = 'evaluated';
    current.evaluation = {
      source: evaluation.source,
      matchedRuleIds: evaluation.matchedRuleIds,
      aiReason: evaluation.aiReason,
      category: evaluation.category,
      categoryConfidence: evaluation.categoryConfidence,
      requiresReply: evaluation.requiresReply,
      unsolicitedSales: evaluation.unsolicitedSales,
      priority: evaluation.priority,
      labels: labelsForEvaluation(evaluation),
      evaluatedAt: this.now(),
      timezone: this.deps.timezone ?? 'UTC',
    };
    await this.saveJob(current);
  }

  private async applyEvaluation(job: MailboxJob, messageId: string, gmail: GmailClient): Promise<void> {
    const message = await gmail.getMessage(messageId, 'metadata');
    const labelIds = await this.getLabelIds(gmail);
    if (!isExplicit(job) && !this.isProcessable(message, labelIds[LABELS.triaged])) {
      await this.advanceJob(job);
      return;
    }
    // An evaluated job may have been saved by the previous deployment.
    const legacy: Record<string, string> = { 'AI/Reply': LABELS.reply, 'AI/Priority': LABELS.priority, 'AI/Sales': LABELS.sales };
    const names = job.evaluation!.labels.map(label => legacy[label] ?? label);
    const addLabelIds = [...new Set(names.map(label => labelIds[label]).filter(Boolean))];
    // Content labels are shared with Gmail filters and user edits; never remove them.
    await gmail.replaceManagedLabels(messageId, addLabelIds, []);
    console.log(JSON.stringify({ event: 'gmail_triage_applied', messageId, source: job.evaluation!.source ?? 'legacy', labels: names, matchedRuleIds: job.evaluation!.matchedRuleIds ?? [], aiReason: job.evaluation!.aiReason }));
    await this.advanceJob(job);
  }

  private isProcessable(message: GmailMessage, triagedLabelId: string | undefined): boolean {
    if (!message.labelIds?.includes('INBOX')) return false;
    if (triagedLabelId && message.labelIds.includes(triagedLabelId)) return false;
    return true;
  }

  private async getLabelIds(gmail: GmailClient): Promise<Record<string, string>> {
    const state = await this.state();
    const names = LABEL_NAMES;
    if (state.labelIds && names.every((name) => state.labelIds![name])) return state.labelIds;
    const labels = Object.fromEntries((await gmail.ensureLabels(names)).entries());
    const latestState = await this.state();
    latestState.labelIds = labels;
    await this.saveState(latestState);
    return labels;
  }

  private buildEmailState(message: GmailMessage): EmailState {
    const headers = message.payload?.headers ?? [];
    const value = (name: string) => headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    return {
      from: value('From'),
      subject: value('Subject'),
      snippet: message.snippet ?? '',
      body: extractBodyText(message.payload),
      evaluatedAt: new Date(this.now()).toISOString(),
      timezone: this.deps.timezone ?? 'UTC',
      ...(message.internalDate ? { receivedAt: new Date(Number(message.internalDate)).toISOString() } : {}),
    };
  }

  private async advanceJob(job: MailboxJob): Promise<void> {
    const current = await this.job(job.id) ?? job;
    current.index += 1;
    current.status = 'pending';
    current.evaluation = undefined;
    current.attempts = 0;
    if (current.index >= current.messageIds.length) await this.completeJob(current);
    else await this.saveJob(current);
  }

  private async completeJob(job: MailboxJob): Promise<void> {
    const current = job;
    current.status = current.failedMessages?.length ? 'failed' : 'done';
    current.evaluation = undefined;
    await this.saveJob(current);
    if (current.kind !== 'history') return;
    const state = await this.state();
    if (!current.targetHistoryId || !state.historyCursor || compareHistoryId(state.historyCursor, current.targetHistoryId) >= 0) return;
    const existing = (await this.jobs()).some((candidate) => candidate.id !== current.id && candidate.kind === 'history' && active(candidate));
    if (!existing) {
      await this.createJob({ kind: 'history', phase: 'discover', messageIds: [], startHistoryId: state.historyCursor, targetHistoryId: current.targetHistoryId });
    }
  }

  private async handleFailure(job: MailboxJob | undefined, error: unknown): Promise<void> {
    if (job) job = await this.job(job.id) ?? job;
    const now = this.now();
    const state = await this.state();
    if (error instanceof JevEvaluationError && error.code === 'ai_credits') {
      state.pausedCode = 'ai_credits';
      state.lastErrorCode = 'ai_credits';
      state.lastErrorAt = now;
      await this.saveState(state);
      if (job) {
        job.status = 'paused';
        job.errorCode = 'ai_credits';
        await this.saveJob(job);
      }
      return;
    }
    if (error instanceof GmailApiError && (error.status === 401 || error.reason === 'invalid_grant')) {
      state.pausedCode = 'gmail_auth';
      state.lastErrorCode = 'gmail_auth';
      state.lastErrorAt = now;
      await this.saveState(state);
      if (job) {
        job.status = 'paused';
        job.errorCode = 'gmail_auth';
        await this.saveJob(job);
      }
      return;
    }
    if (job?.kind === 'history' && job.phase === 'discover' && error instanceof GmailApiError && error.status === 404) {
      await this.recoverExpiredHistory(job);
      return;
    }
    if (error instanceof JevEvaluationError && error.code === 'invalid_ai_response') {
      state.lastErrorCode = 'invalid_ai_response';
      state.lastErrorAt = now;
      await this.saveState(state);
      if (job) await this.recordMessageFailure(job, 'invalid_ai_response', true);
      return;
    }

    const retryable = error instanceof GmailApiError && error.retryable;
    const shouldRetry = retryable || isTransientFailure(error) || error instanceof JevEvaluationError && error.code === 'ai_unavailable';
    if (shouldRetry) {
      const attempts = (job?.attempts ?? state.initializationAttempts ?? 0) + 1;
      if (!job) state.initializationAttempts = attempts;
      const retryAfter = error instanceof GmailApiError ? error.retryAfterMs : 0;
      const delay = Math.max(retryAfter, Math.min(15 * 60_000, BATCH_DELAY_MS * 2 ** Math.min(attempts - 1, 9)));
      state.cooldownUntil = Math.max(state.cooldownUntil ?? 0, now + delay);
      state.lastErrorCode = safeErrorCode(error);
      state.lastErrorAt = now;
      await this.saveState(state);
      if (job) {
        job.status = job.evaluation ? 'evaluated' : 'pending';
        job.attempts = attempts;
        job.errorCode = safeErrorCode(error);
        await this.saveJob(job);
      }
      await this.arm(delay);
      return;
    }

    state.lastErrorCode = safeErrorCode(error);
    state.lastErrorAt = now;
    await this.saveState(state);
    if (job) await this.recordMessageFailure(job, safeErrorCode(error));
  }

  private async recordMessageFailure(job: MailboxJob, errorCode: string, quarantine = false): Promise<void> {
    const current = await this.job(job.id) ?? job;
    if (current.phase === 'discover' || current.kind === 'watch') {
      current.status = 'failed';
      current.errorCode = errorCode;
      await this.saveJob(current);
      return;
    }
    const messageId = current.messageIds[current.index];
    if (messageId) {
      current.failedMessages = [...(current.failedMessages ?? []), { messageId, errorCode }];
      current.errorCode = errorCode;
      current.evaluation = undefined;
      current.index += 1;
      if (quarantine) await this.storage.put(failureKey(messageId), { errorCode, failedAt: this.now() });
    }
    current.status = 'pending';
    current.attempts = 0;
    if (current.index >= current.messageIds.length) await this.completeJob(current);
    else await this.saveJob(current);
  }

  private nextRunnableJob(jobs: MailboxJob[]): MailboxJob | undefined {
    const priority = (job: MailboxJob): number => {
      if (job.kind === 'watch') return 0;
      if (job.status === 'evaluated') return 1;
      if (job.kind === 'reprocess') return 2;
      if (job.kind === 'history') return 3;
      return 4;
    };
    return jobs
      .filter((job) => job.status === 'pending' || job.status === 'evaluated')
      .sort((left, right) => priority(left) - priority(right) || left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
  }

  private async recoverExpiredHistory(job: MailboxJob): Promise<void> {
    const profile = await this.deps.createGmail().getProfile();
    if (!profile || !isHistoryId(profile.historyId)) throw new Error('invalid Gmail profile');
    const hasBackfill = (await this.jobs()).some((candidate) => candidate.kind === 'scan' && candidate.phase === 'discover' && !candidate.pageToken && candidate.messageIds.length === 0 && active(candidate));
    if (!hasBackfill) await this.createJob({ kind: 'scan', phase: 'discover', messageIds: [] });
    const state = await this.state();
    state.baselineHistoryId = profile.historyId;
    state.historyCursor = maxHistoryId(state.historyCursor, profile.historyId);
    state.initialized = true;
    state.initializationPending = false;
    await this.saveState(state);
    job.status = 'failed';
    job.errorCode = 'history_expired';
    await this.saveJob(job);
  }
}
