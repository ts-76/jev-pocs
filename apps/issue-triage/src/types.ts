export interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPOSITORY: string;
  GITHUB_EVENT_PATH: string;
  GITHUB_SHA?: string;
  GITHUB_REF_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  FLUE_DISPATCH_URL?: string;
  FLUE_DISPATCH_TOKEN?: string;
}

export interface IssueLabel {
  name: string;
  color?: string;
  description?: string | null;
}

export interface IssueEvent {
  action: string;
  repository: {
    full_name: string;
    html_url: string;
    default_branch?: string;
  };
  issue: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    updated_at?: string;
    user?: { login?: string };
    labels?: IssueLabel[];
  };
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

export type { IssueType, Severity } from './triage-config.js';
import type { IssueType, Severity } from './triage-config.js';

export interface TriageDecision {
  issueType: IssueType;
  severity: Severity;
  severityScore: number;
  needsRepoInvestigation: boolean;
  hasEnoughInformation: boolean;
  matchedRuleIds: string[];
  raw: JevResponse;
}

export interface FlueDispatchResult {
  status: 'not-configured' | 'dispatched' | 'failed';
  message?: string;
}
