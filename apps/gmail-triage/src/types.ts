import type { Mailbox } from './mailbox';

export interface Env {
  AI: Ai;
  MAILBOX: DurableObjectNamespace<Mailbox>;
  GMAIL_ACCOUNT_EMAIL: string;
  PUBSUB_AUDIENCE: string;
  PUBSUB_SERVICE_ACCOUNT_EMAIL: string;
  MAILBOX_TIMEZONE?: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_REDIRECT_URI?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  OAUTH_STATE_SECRET: string;
  RUN_TOKEN?: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId?: string;
  snippet?: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface GmailHistoryEntry {
  id?: string;
  messagesAdded?: Array<{ message?: { id?: string } }>;
}

export interface GmailWatchResponse {
  historyId: string;
  expiration: string;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul?: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevScoreAnswer {
  type: 'score';
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: Record<string, number>;
}

export interface EmailState {
  from: string;
  subject: string;
  snippet: string;
  body?: string;
  receivedAt?: string;
  evaluatedAt?: string;
  timezone?: string;
}

export interface EmailEvaluation {
  matchedRuleIds?: string[];
  aiReason?: 'complete_rule' | 'requires_evaluation';
  category?: string;
  categoryConfidence?: number;
  ruleLabels?: string[];
  source?: 'rule' | 'ai';
  requiresReply: number;
  unsolicitedSales: number;
  priority: number;
  raw: JevResponse;
}

export interface ScheduledEvent {
  cron?: string;
  scheduledTime: number;
  type: 'scheduled';
}
