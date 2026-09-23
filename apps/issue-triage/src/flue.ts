import type { Env, FlueDispatchResult, TriageDecision } from './types.js';

export class FlueDispatchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('Flue dispatch failed');
    this.name = 'FlueDispatchError';
    this.code = code;
  }
}

export async function dispatchToFlue(env: Env, payload: {
  repository: string;
  issueNumber: number;
  title: string;
  body: string;
  url: string;
  ref: string;
  sha: string;
  idempotencyKey: string;
  decision: TriageDecision;
}): Promise<FlueDispatchResult> {
  if (!env.FLUE_DISPATCH_URL) {
    return { status: 'not-configured', message: 'not configured' };
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  if (env.FLUE_DISPATCH_TOKEN) headers.set('authorization', 'Bearer ' + env.FLUE_DISPATCH_TOKEN);
  headers.set('idempotency-key', payload.idempotencyKey);

  let response: Response;
  try {
    response = await fetch(env.FLUE_DISPATCH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: 'issue.triage.requested',
        repository: payload.repository,
        issue: {
          number: payload.issueNumber,
          title: payload.title,
          body: payload.body,
          url: payload.url,
        },
        triage: {
          issueType: payload.decision.issueType,
          severity: payload.decision.severity,
          severityScore: payload.decision.severityScore,
          needsRepoInvestigation: payload.decision.needsRepoInvestigation,
          hasEnoughInformation: payload.decision.hasEnoughInformation,
        },
        ref: payload.ref,
        sha: payload.sha,
        idempotencyKey: payload.idempotencyKey,
      }),
    });
  } catch {
    throw new FlueDispatchError('flue_network_error');
  }

  if (!response.ok) throw new FlueDispatchError('flue_http_' + response.status);

  return { status: 'dispatched', message: 'dispatched' };
}
