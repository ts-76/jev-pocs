import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateIssue, JevEvaluationError } from '../src/jev';
import type { Env, IssueEvent } from '../src/types';

const issueEvent: IssueEvent = {
  action: 'opened',
  repository: { full_name: 'example/repository', html_url: 'https://github.com/example/repository' },
  issue: {
    number: 1,
    title: 'Issue title',
    body: 'issue body',
    html_url: 'https://github.com/example/repository/issues/1',
    user: { login: 'author' },
    labels: [],
  },
};

const env: Env = {
  GITHUB_TOKEN: 'github-token',
  GITHUB_REPOSITORY: 'example/repository',
  GITHUB_EVENT_PATH: '/tmp/event.json',
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  CLOUDFLARE_API_TOKEN: 'cloudflare-token',
};

function directResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      issue_type: { type: 'choice', choice: 'bug' },
      severity: { type: 'score', score: 0 },
      needs_repo_investigation: { type: 'noul', noul: 0 },
      has_enough_information: { type: 'noul', noul: 0 },
      ...overrides,
    },
  };
}

function mockResponse(payload: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Issue Jev evaluation validation', () => {
  it('accepts the direct official response, including exact zero values', async () => {
    mockResponse(directResponse());
    await expect(evaluateIssue(env, issueEvent)).resolves.toMatchObject({
      model: 'jev-1.13.0',
      answers: {
        severity: { score: 0 },
        needs_repo_investigation: { noul: 0 },
      },
    });
  });

  it('accepts a successful REST result wrapper but validates only its result', async () => {
    mockResponse({ success: true, result: directResponse(), messages: [] });
    await expect(evaluateIssue(env, issueEvent)).resolves.toMatchObject({ model: 'jev-1.13.0' });
  });

  it('accepts the confirmed Completed envelope after the REST wrapper', async () => {
    mockResponse({ success: true, result: { state: 'Completed', result: directResponse() } });
    await expect(evaluateIssue(env, issueEvent)).resolves.toMatchObject({ model: 'jev-1.13.0' });
  });

  it('rejects success:false even when the REST response is HTTP 200', async () => {
    mockResponse({ success: false, errors: [{ code: 1000, message: 'secret provider detail' }] });
    await expect(evaluateIssue(env, issueEvent)).rejects.toThrow('success');
    await expect(evaluateIssue(env, issueEvent)).rejects.not.toThrow('secret provider detail');
  });

  it('classifies a REST credit error without returning its message', async () => {
    mockResponse({ success: false, errors: [{ code: 2021, message: 'Insufficient AI Gateway credits: secret' }] });
    const error = await evaluateIssue(env, issueEvent).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(JevEvaluationError);
    expect((error as JevEvaluationError).code).toBe('ai_credits');
    expect((error as Error).message).not.toContain('secret');
  });

  it.each([
    ['missing answer', directResponse({ severity: undefined }), 'answers.severity'],
    ['wrong type', directResponse({ severity: { type: 'noul', noul: 0.5 } }), 'answers.severity.type'],
    ['score out of range', directResponse({ severity: { type: 'score', score: 3.01 } }), 'answers.severity.score'],
    ['unknown choice', directResponse({ issue_type: { type: 'choice', choice: 'secret' } }), 'answers.issue_type.choice'],
  ])('rejects %s and identifies only the structural field', async (_name, payload, field) => {
    mockResponse(payload);
    await expect(evaluateIssue(env, issueEvent)).rejects.toThrow(field);
    await expect(evaluateIssue(env, issueEvent)).rejects.not.toThrow('issue body');
  });

  it('rejects non-finite values when the response is passed to decision conversion', async () => {
    const { toDecision } = await import('../src/triage');
    expect(() => toDecision(directResponse({ severity: { type: 'score', score: Number.NaN } })))
      .toThrow('answers.severity.score');
  });
});
