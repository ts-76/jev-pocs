import { describe, expect, it } from 'vitest';
import config from '../config/rules.json';
import { createRuleEngine, parseRuleConfig } from '../src/rule-engine';
import { classifyPattern } from '../src/rules';

const code = { from: 'Cloudflare <noreply@notify.cloudflare.com>', subject: 'Cloudflare Access login code for example.com', snippet: '' };

describe('declarative rule engine', () => {
  it('combines all matches, continues after AI skip, and reports reasons', () => {
    const result = classifyPattern({ ...code, receivedAt: '2026-09-01T00:00:00Z', evaluatedAt: '2026-09-08T00:00:00Z' });
    expect(result).toEqual({ labels: ['開発通知', '認証・セキュリティ', '削除候補'], complete: true,
      matchedRuleIds: ['developer-notification', 'cloudflare-access-code', 'expired-cloudflare-access-code'], aiReason: 'complete_rule' });
  });
  it.each([undefined, 'invalid', '2026-09-07T23:59:59Z', '2026-08-31T00:00:00Z'])('does not dispose before seven days or with an invalid time: %s', evaluatedAt => {
    expect(classifyPattern({ ...code, receivedAt: '2026-09-01T00:00:00Z', evaluatedAt }).labels).not.toContain('削除候補');
  });
  it('does not trust a display name containing a known sender', () => {
    expect(classifyPattern({ ...code, from: 'noreply@notify.cloudflare.com <attacker@example.com>' })).toMatchObject({ labels: [], complete: false });
  });
  it.each([
    ['support@npmjs.com', 'Successfully published package', ['開発通知'], true],
    ['support@npmjs.com', 'Security alert', ['開発通知'], false],
    ['info@chat-work.com', '【Chatwork】未読メッセージがあります', ['お知らせ・購読'], true],
    ['noreply@libecity.com', '未読通知', ['お知らせ・購読'], true],
    ['noreply@zenn.dev', 'フォロー中のユーザーやPublicationに新しい投稿があります', ['お知らせ・購読'], true],
    ['hello@1password.com', 'Your INVOICE', ['請求・支払い'], false],
    ['hello@1password.com', 'invoiceable newsletter', [], false],
    ['lifeweb-entry@lifecard.co.jp', 'カードご利用のお知らせ', ['請求・支払い'], false],
    ['noreply@booth.pm', '購入されました', ['売上・入金'], false],
    ['noreply@booth.pm', 'ユーザーからメッセージが届いています', ['仕事・問い合わせ'], false],
  ])('preserves %s / %s', (from, subject, labels, complete) => {
    expect(classifyPattern({ from, subject, snippet: '' })).toMatchObject({ labels, complete });
  });
  it('requires seller-payment confirmation for a BOOTH order and uses snippet only when body is absent', () => {
    const email = { from: 'noreply@booth.pm', subject: 'ご注文が確定しました', snippet: '購入者のお支払いを確認しました' };
    expect(classifyPattern(email).labels).toEqual(['売上・入金']);
    expect(classifyPattern({ ...email, body: '' }).labels).toEqual([]);
  });
  it('supports custom display names without modifying predicates', () => {
    const input = structuredClone(config);
    input.labels.security = 'Security';
    expect(createRuleEngine(input)(code).labels).toContain('Security');
  });
  it('supports additional logical label IDs', () => {
    const input = { ...structuredClone(config), labels: { ...config.labels, custom: 'Custom' } };
    input.rules[0].actions.addLabels.push('custom');
    expect(createRuleEngine(input)(code).labels).toContain('Custom');
  });
  it.each([
    ['version', (c: any) => { c.version = 2; }],
    ['unknown key', (c: any) => { c.rulse = []; }],
    ['duplicate id', (c: any) => { c.rules.push(c.rules[0]); }],
    ['unknown label', (c: any) => { c.rules[0].actions.addLabels = ['missing']; }],
    ['prototype label', (c: any) => { c.rules[0].actions.addLabels = ['constructor']; }],
    ['missing label', (c: any) => { delete c.labels.action; }],
    ['duplicate name', (c: any) => { c.labels.action = c.labels.security; }],
    ['checkpoint rename', (c: any) => { c.labels.triaged = 'Done'; }],
    ['checkpoint rule', (c: any) => { c.rules[0].actions.addLabels = ['triaged']; }],
    ['threshold range', (c: any) => { c.thresholds.category = 1.1; }],
    ['empty all', (c: any) => { c.rules[0].when = { all: [] }; }],
    ['invalid regex', (c: any) => { c.rules[0].when = { field: 'subject', operator: 'matches', value: '[' }; }],
    ['wrong operator', (c: any) => { c.rules[0].when = { field: 'ageDays', operator: 'equals', value: 7 }; }],
  ])('rejects %s before processing mail', (_name, mutate) => {
    const input = structuredClone(config); mutate(input);
    expect(() => parseRuleConfig(input)).toThrow();
  });
});
