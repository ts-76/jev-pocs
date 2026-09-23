// Local-only fixture: all Google and AI calls are replaced with synthetic data.
import app from '../src/index';
import { Mailbox as ProductionMailbox } from '../src/mailbox';
import type { Env } from '../src/types';
import { LABELS } from '../src/rules';

const calls = { ai: 0, modify: 0, modifyAttempts: 0, watch: 0, applied: [] as string[] };
let failNextModify = false;
const labelNames = [...new Set(Object.values(LABELS))];
const labels = labelNames.map((name, i) => ({ name, id: 'label_' + i }));
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
  if (url.hostname !== 'gmail.googleapis.com') throw new Error('Unexpected outbound request in local test');
  const path = url.pathname;
  if (path.endsWith('/profile')) return Response.json({ emailAddress: 'user@example.com', historyId: '100' });
  if (path.endsWith('/labels')) return Response.json({ labels });
  if (path.endsWith('/history')) return Response.json({ historyId: '100', history: [] });
  if (path.endsWith('/watch')) { calls.watch++; return Response.json({ historyId: '200', expiration: String(Date.now() + 604800000) }); }
  if (path.endsWith('/messages')) return Response.json({ messages: calls.modify ? [] : [{ id: 'aa' }] });
  if (path.endsWith('/messages/aa')) return Response.json({ id: 'aa', labelIds: ['INBOX', ...calls.applied], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Please reply today' }], body: { data: btoa('Please reply by 5 PM today.') } } });
  if (path.endsWith('/messages/aa/modify')) {
    calls.modifyAttempts++;
    if (failNextModify) {
      failNextModify = false;
      return Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 503 });
    }
    calls.modify++;
    const change = JSON.parse(String(init?.body));
    calls.applied = change.addLabelIds;
    return Response.json({ id: 'aa', labelIds: ['INBOX', ...calls.applied] });
  }
  return Response.json({ error: { errors: [{ reason: 'notFound' }] } }, { status: 404 });
};
export class Mailbox extends ProductionMailbox {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, AI: { run: async () => {
      calls.ai++;
      return { state: 'Completed', result: { model: 'jev-test', answers: {
        category: { type: 'choice', choice: 'work', confidence: 0.99 },
        requires_reply: { type: 'noul', noul: 0.99 },
        unsolicited_sales: { type: 'noul', noul: 0.01 },
        priority: { type: 'score', score: 2.99 },
      } } };
    } } as unknown as Ai });
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === '/test-calls') return Response.json(calls);
    if (new URL(request.url).pathname === '/test-fail-next-modify') { failNextModify = true; return Response.json({ ok: true }); }
    // Wrangler may load .dev.vars; keep the local harness credential synthetic.
    return app.fetch(request, { ...env, RUN_TOKEN: 'local-test' });
  },
};
