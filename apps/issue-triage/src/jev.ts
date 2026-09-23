import type { Env, IssueEvent, JevResponse } from './types.js';
import { TRIAGE_CONFIG } from './triage-config.js';

const MODEL = TRIAGE_CONFIG.model;

export type JevEvaluationErrorCode = 'ai_credits' | 'invalid_ai_response' | 'ai_unavailable';

export class JevEvaluationError extends Error {
  readonly code: JevEvaluationErrorCode;

  constructor(code: JevEvaluationErrorCode, field?: string) {
    super(field ? 'Invalid Jev response field: ' + field : code === 'ai_credits'
      ? 'Insufficient AI Gateway credits'
      : code === 'invalid_ai_response' ? 'Invalid Jev response' : 'Jev evaluation unavailable');
    this.name = 'JevEvaluationError';
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string): never {
  throw new JevEvaluationError('invalid_ai_response', field);
}

export function validateJevResponse(value: unknown): JevResponse {
  if (!isRecord(value)) invalid('response');
  if (typeof value.model !== 'string' || value.model.length === 0) invalid('model');
  if (!isRecord(value.answers)) invalid('answers');

  for (const [key, specification] of Object.entries(TRIAGE_CONFIG.questions)) {
    const answer = value.answers[key];
    if (!isRecord(answer)) invalid('answers.' + key);
    if (answer.type !== specification.type) invalid('answers.' + key + '.type');

    if (specification.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(TRIAGE_CONFIG.issueTypes, answer.choice)) {
        invalid('answers.' + key + '.choice');
      }
      continue;
    }

    const field = specification.type === 'noul' ? 'noul' : 'score';
    const number = answer[field];
    const maximum = specification.type === 'noul' ? 1 : 3;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > maximum) {
      invalid('answers.' + key + '.' + field);
    }
  }

  return value as unknown as JevResponse;
}

function unwrapRestResponse(value: unknown): unknown {
  let current = value;
  if (isRecord(current) && Object.hasOwn(current, 'success')) {
    if (current.success !== true) invalid('success');
    if (!Object.hasOwn(current, 'result')) invalid('result');
    current = current.result;
  }
  if (isRecord(current) && Object.hasOwn(current, 'state')) {
    if (current.state !== 'Completed') invalid('state');
    if (!Object.hasOwn(current, 'result')) invalid('result');
    current = current.result;
  }
  return current;
}

function isCreditFailure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isCreditFailure);
  if (!isRecord(value)) return false;
  if (value.code === 2021 || value.code === '2021' || value.code === 'ai_credits') return true;
  if (typeof value.message === 'string' && /2021|insufficient\s+ai\s+gateway\s+credits/i.test(value.message)) return true;
  return isCreditFailure(value.error) || isCreditFailure(value.errors);
}

export async function evaluateIssue(env: Env, event: IssueEvent): Promise<JevResponse> {
  const issue = event.issue;
  const state = {
    repository: event.repository.full_name,
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      author: issue.user?.login ?? 'unknown',
      url: issue.html_url,
      labels: (issue.labels ?? []).map((label) => label.name),
    },
  };

  const questions = {
    issue_type: { ...TRIAGE_CONFIG.questions.issue_type, criteria: Object.fromEntries(Object.entries(TRIAGE_CONFIG.issueTypes).map(([key, item]) => [key, item.criteria])) },
    severity: { ...TRIAGE_CONFIG.questions.severity, criteria: Object.entries(TRIAGE_CONFIG.severityLevels).sort((left, right) => left[1].order - right[1].order).map(([key, item]) => key + ': ' + item.criteria) },
    needs_repo_investigation: TRIAGE_CONFIG.questions.needs_repo_investigation,
    has_enough_information: TRIAGE_CONFIG.questions.has_enough_information,
  };

  let response: Response;
  try {
    response = await fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID) + '/ai/run',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, input: { state, questions } }),
      },
    );
  } catch {
    throw new JevEvaluationError('ai_unavailable');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new JevEvaluationError(response.ok ? 'invalid_ai_response' : 'ai_unavailable');
  }

  if (isCreditFailure(payload)) throw new JevEvaluationError('ai_credits');
  if (!response.ok) throw new JevEvaluationError('ai_unavailable');
  return validateJevResponse(unwrapRestResponse(payload));
}
