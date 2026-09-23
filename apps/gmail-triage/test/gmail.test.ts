import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailApiError, GmailClient } from '../src/gmail';
import type { Env } from '../src/types';

const env = { GMAIL_CLIENT_ID: 'test', GMAIL_CLIENT_SECRET: 'test', GMAIL_REFRESH_TOKEN: 'test' } as Env;
afterEach(() => vi.unstubAllGlobals());
describe('Gmail API boundaries', () => {
  it('does not silently truncate history after five pages', async () => {
    let pages = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('oauth2')) return Response.json({ access_token: 'test' });
      const url = new URL(input);
      expect(url.searchParams.get('labelId')).toBe('INBOX');
      pages++;
      return Response.json({ historyId: '999', history: [{ messagesAdded: [{ message: { id: String(pages) } }] }], ...(pages < 6 ? { nextPageToken: String(pages) } : {}) });
    }));
    expect(await new GmailClient(env).listHistory('1')).toEqual(['1', '2', '3', '4', '5', '6']);
  });
  it('retains pagination and server cursor for durable discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input.includes('oauth2') ? Response.json({ access_token: 'test' }) : Response.json({ historyId: '99', nextPageToken: 'next', history: [] })));
    expect(await new GmailClient(env).listHistoryPage('1')).toEqual({ messageIds: [], historyId: '99', nextPageToken: 'next' });
  });
  it('classifies rate limits without logging upstream payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input.includes('oauth2') ? Response.json({ access_token: 'test' }) : Response.json({ error: { message: 'private text', errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 403, headers: { 'retry-after': '120' } })));
    await expect(new GmailClient(env).listLabels()).rejects.toMatchObject({ status: 403, retryAfterMs: 120000, retryable: true, message: 'Gmail API 403: rateLimitExceeded' });
  });
  it('does not classify authorization failures as retryable quota errors', () => {
    expect(new GmailApiError(403, 'insufficientPermissions').retryable).toBe(false);
  });
});
