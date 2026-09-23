import { describe, expect, it } from 'vitest';
import { parseGmailPubSubPush } from '../src/pubsub';

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

describe('Gmail Pub/Sub payloads', () => {
  it('decodes Gmail notification data from a push envelope', async () => {
    const data = encodeBase64Url(JSON.stringify({
      emailAddress: 'user@example.com',
      historyId: '1234567890',
    }));
    const request = new Request('https://worker.example.com/pubsub', {
      method: 'POST',
      body: JSON.stringify({ message: { data } }),
      headers: { 'content-type': 'application/json' },
    });

    await expect(parseGmailPubSubPush(request)).resolves.toEqual({
      emailAddress: 'user@example.com',
      historyId: '1234567890',
    });
  });

  it('rejects malformed envelopes', async () => {
    const request = new Request('https://worker.example.com/pubsub', {
      method: 'POST',
      body: JSON.stringify({ message: {} }),
      headers: { 'content-type': 'application/json' },
    });

    await expect(parseGmailPubSubPush(request)).rejects.toThrow('message.data is missing');
  });

  it.each(['', '-1', '1.2', '1e9', 'x', '9'.repeat(31)])('rejects invalid history cursor %s', async (historyId) => {
    const data = encodeBase64Url(JSON.stringify({ emailAddress: 'user@example.com', historyId }));
    await expect(parseGmailPubSubPush(new Request('https://worker.example/pubsub', {
      method: 'POST', body: JSON.stringify({ message: { data } }),
    }))).rejects.toThrow();
  });

  it('rejects oversized bodies without trusting Content-Length', async () => {
    await expect(parseGmailPubSubPush(new Request('https://worker.example/pubsub', {
      method: 'POST', body: ' '.repeat(16385),
    }))).rejects.toThrow('too large');
  });

  it('normalizes safely representable numeric notification cursors', async () => {
    const data = encodeBase64Url(JSON.stringify({ emailAddress: 'user@example.com', historyId: 1154858 }));
    await expect(parseGmailPubSubPush(new Request('https://worker.example/pubsub', {
      method: 'POST', body: JSON.stringify({ message: { data } }),
    }))).resolves.toEqual({ emailAddress: 'user@example.com', historyId: '1154858' });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 1.5])('rejects lossy or invalid numeric cursors %s', async historyId => {
    const data = encodeBase64Url(JSON.stringify({ emailAddress: 'user@example.com', historyId }));
    await expect(parseGmailPubSubPush(new Request('https://worker.example/pubsub', {
      method: 'POST', body: JSON.stringify({ message: { data } }),
    }))).rejects.toThrow();
  });
});
