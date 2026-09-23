import { describe, expect, it, vi } from 'vitest';
import { evaluateEmail, JevEvaluationError } from '../src/jev';
import type { Env, EmailState } from '../src/types';

const emailState: EmailState = {
  from: 'sender@example.com',
  subject: 'Subject',
  snippet: 'snippet',
  body: 'secret email body that must not appear in errors',
};

function envWithResponse(response: unknown): Env {
  return {
    AI: { run: vi.fn().mockResolvedValue(response) } as unknown as Ai,
    GMAIL_CLIENT_ID: 'client-id',
    GMAIL_CLIENT_SECRET: 'client-secret',
    OAUTH_STATE_SECRET: 'oauth-secret',
  } as Env;
}

const directResponse = (overrides: Record<string, unknown> = {}) => ({
  model: 'jev-1.13.0',
  answers: {
    category: { type: 'choice', choice: 'other', confidence: 1 },
    requires_reply: { type: 'noul', noul: 0 },
    unsolicited_sales: { type: 'noul', noul: 0 },
    priority: { type: 'score', score: 0 },
    ...overrides,
  },
});

describe('Gmail Jev evaluation validation', () => {
  it('skips AI for an expired exact-template code and only proposes deletion', async () => {
    const env = envWithResponse(null);
    const result = await evaluateEmail(env, { from: 'Cloudflare <noreply@notify.cloudflare.com>', subject: 'Cloudflare Access login code for example.com', snippet: '', receivedAt: '2026-09-01T00:00:00Z', evaluatedAt: '2026-09-23T00:00:00Z' });
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'rule', requiresReply: 0, ruleLabels: ['開発通知', '認証・セキュリティ', '削除候補'] });
  });

  it('does not mark fresh codes as deletion candidates', async () => {
    const result = await evaluateEmail(envWithResponse(null), { from: 'noreply@notify.cloudflare.com', subject: 'Cloudflare Access login code for example.com', snippet: '', receivedAt: '2026-09-23T00:00:00Z', evaluatedAt: '2026-09-23T00:01:00Z' });
    expect(result.ruleLabels).not.toContain('削除候補');
  });

  it.each([
    ['Cloudflare <noreply@notify.cloudflare.com>', '[Alert] D1 daily limit exceeded'],
    ['npm <support@npmjs.com>', 'Security alert: token revoked'],
    ['noreply@notify.cloudflare.com <attacker@example.com>', 'Cloudflare Access login code for example.com'],
    ['BOOTH <noreply@booth.pm>', 'ユーザーからメッセージが届いています [BOOTH]'],
  ])('keeps AI review for non-final or untrusted templates: %s %s', async (from, subject) => {
    const env = envWithResponse(directResponse());
    await evaluateEmail(env, { from, subject, snippet: '' });
    expect(env.AI.run).toHaveBeenCalledOnce();
  });

  it('unwraps and validates the measured Completed gateway response', async () => {
    const response = await evaluateEmail(envWithResponse({
      state: 'Completed',
      result: {
        model: 'jev-1.13.0',
        answers: {
          category: { type: 'choice', choice: 'work', confidence: 0.95 },
          requires_reply: { type: 'noul', noul: 0.99 },
          unsolicited_sales: { type: 'noul', noul: 0.03 },
          priority: {
            type: 'score',
            score: 2.99,
            legend: { '0': 'Low', '1': 'Normal', '2': 'High', '3': 'Urgent' },
            probabilities: { '0': 0, '1': 0, '2': 0.01, '3': 0.99 },
            confidence: 0.99,
          },
        },
        usage: { input_tokens: 382, output_tokens: 53 },
      },
      gatewayMetadata: { keySource: 'Unified' },
    }), emailState);

    expect(response.requiresReply).toBe(0.99);
    expect(response.unsolicitedSales).toBe(0.03);
    expect(response.priority).toBe(2.99);
    expect(response.raw.model).toBe('jev-1.13.0');
  });

  it('accepts the direct official response and exact zero values', async () => {
    const response = await evaluateEmail(envWithResponse(directResponse()), emailState);
    expect(response.requiresReply).toBe(0);
    expect(response.unsolicitedSales).toBe(0);
    expect(response.priority).toBe(0);
  });

  it.each([
    ['missing category', directResponse({ category: undefined }), 'answers.category'],
    ['unknown category', directResponse({ category: { type: 'choice', choice: 'invalid', confidence: 1 } }), 'answers.category'],
    ['invalid confidence', directResponse({ category: { type: 'choice', choice: 'billing', confidence: 2 } }), 'answers.category.confidence'],
    ['missing answer', directResponse({ priority: undefined }), 'answers.priority'],
    ['wrong type', directResponse({ priority: { type: 'noul', noul: 0.5 } }), 'answers.priority.type'],
    ['NaN', directResponse({ priority: { type: 'score', score: Number.NaN } }), 'answers.priority.score'],
    ['noul below range', directResponse({ requires_reply: { type: 'noul', noul: -0.01 } }), 'answers.requires_reply.noul'],
    ['noul above range', directResponse({ requires_reply: { type: 'noul', noul: 1.01 } }), 'answers.requires_reply.noul'],
    ['score above range', directResponse({ priority: { type: 'score', score: 3.01 } }), 'answers.priority.score'],
  ])('rejects %s without exposing the email body', async (_name, payload, field) => {
    await expect(evaluateEmail(envWithResponse(payload), emailState)).rejects.toThrow(field);
    await expect(evaluateEmail(envWithResponse(payload), emailState)).rejects.not.toThrow('secret email body');
  });

  it('rejects a non-Completed gateway state', async () => {
    await expect(evaluateEmail(envWithResponse({ state: 'Failed', result: directResponse() }), emailState))
      .rejects.toThrow('state');
  });

  it('classifies credit exhaustion without returning the provider error', async () => {
    const env = envWithResponse(directResponse());
    env.AI.run = vi.fn().mockRejectedValue({ code: 2021, message: 'Insufficient AI Gateway credits: secret' });

    const error = await evaluateEmail(env, emailState).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(JevEvaluationError);
    expect((error as JevEvaluationError).code).toBe('ai_credits');
    expect((error as Error).message).not.toContain('secret');
  });

  it('pauses on a returned credit error as well as a thrown error', async () => {
    const env = envWithResponse({ success: false, errors: [{ code: 2021, message: 'Insufficient AI Gateway credits' }] });
    await expect(evaluateEmail(env, emailState)).rejects.toMatchObject({ code: 'ai_credits' });
  });
});
