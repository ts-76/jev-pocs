import { buildAuthorizationUrl, exchangeAuthorizationCode } from './oauth';
import { parseGmailPubSubPush, type GmailPubSubNotification } from './pubsub';
import { PushAuthError, verifyPush } from './push-auth';
import type { Mailbox } from './mailbox';
import type { Env } from './types';

type MailboxStub = Pick<Mailbox, 'enqueueNotification' | 'enqueueScan' | 'enqueueWatch' | 'enqueueReprocess' | 'resume' | 'getStatus'>;

class InvalidRequestError extends Error {}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    headers: { 'cache-control': 'no-store', ...init.headers },
    ...init,
  });
}

function getMailbox(env: Env): MailboxStub {
  return env.MAILBOX.getByName(env.GMAIL_ACCOUNT_EMAIL) as unknown as MailboxStub;
}

function configurationStatus(env: Env): Record<string, boolean> {
  return {
    mailbox: Boolean(env.MAILBOX),
    account_email: Boolean(env.GMAIL_ACCOUNT_EMAIL),
    pubsub_auth: Boolean(env.PUBSUB_AUDIENCE && env.PUBSUB_SERVICE_ACCOUNT_EMAIL),
    oauth_client: Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET),
    gmail_auth: Boolean(env.GMAIL_REFRESH_TOKEN && env.GMAIL_REDIRECT_URI),
    pubsub_topic: Boolean(env.GMAIL_PUBSUB_TOPIC),
    run_token: Boolean(env.RUN_TOKEN),
    ai: Boolean(env.AI),
  };
}

function hasMailboxConfig(env: Env): boolean {
  const configuration = configurationStatus(env);
  return configuration.mailbox && configuration.account_email && configuration.pubsub_auth;
}

function authFailure(request: Request, env: Env): Response | undefined {
  if (!env.RUN_TOKEN) return json({ error: 'Configuration unavailable' }, { status: 503 });
  const authorization = request.headers.get('authorization');
  if (!authorization) return json({ error: 'Unauthorized' }, { status: 401 });
  if (authorization !== 'Bearer ' + env.RUN_TOKEN) return json({ error: 'Forbidden' }, { status: 403 });
  return undefined;
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InvalidRequestError('Invalid JSON request');
  }
}

function reprocessIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new InvalidRequestError('messageIds is required');
  const messageIds = (payload as { messageIds?: unknown }).messageIds;
  if (!Array.isArray(messageIds) || messageIds.length === 0 || messageIds.length > 20 || messageIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]+$/i.test(id))) {
    throw new InvalidRequestError('messageIds must contain at most 20 hexadecimal message IDs');
  }
  return messageIds;
}

function errorResponse(error: unknown): Response {
  if (error instanceof InvalidRequestError) return json({ error: error.message }, { status: 400 });
  if (error instanceof PushAuthError) return json({ error: error.status === 503 ? 'Configuration unavailable' : 'Invalid push authentication' }, { status: error.status });
  console.error(error instanceof Error ? error.name : 'request failure');
  return json({ error: 'Internal error' }, { status: 500 });
}

async function handlePubSub(request: Request, env: Env): Promise<Response> {
  if (!hasMailboxConfig(env)) return json({ error: 'Configuration unavailable' }, { status: 503 });
  await verifyPush(request, env);
  let notification: GmailPubSubNotification;
  try {
    notification = await parseGmailPubSubPush(request);
  } catch (error) {
    // Do not log the payload or JSON parser messages (which may quote it).
    console.warn(JSON.stringify({ event: 'pubsub_invalid_payload', errorType: error instanceof Error ? error.name : 'unknown' }));
    throw new InvalidRequestError('Invalid Pub/Sub payload');
  }
  if (notification.emailAddress !== env.GMAIL_ACCOUNT_EMAIL) return json({ error: 'Forbidden' }, { status: 403 });
  await getMailbox(env).enqueueNotification(notification.historyId);
  return new Response(null, { status: 204 });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const configuration = configurationStatus(env);
        return json({
          ok: Object.values(configuration).every(Boolean),
          model: 'typesafe/jev',
          configuration,
        });
      }
      if (request.method === 'GET' && url.pathname === '/oauth/start') {
        return json({ authorization_url: await buildAuthorizationUrl(env, request) });
      }
      if (request.method === 'GET' && url.pathname === '/oauth/callback') {
        const refreshToken = await exchangeAuthorizationCode(env, request);
        return new Response(
          'OAuth succeeded. Save this refresh token as GMAIL_REFRESH_TOKEN, then remove it from this browser history:\n\n' + refreshToken,
          { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
        );
      }
      if (url.pathname === '/pubsub' && request.method === 'POST') return await handlePubSub(request, env);

      if (['/run', '/watch', '/reprocess', '/resume', '/status'].includes(url.pathname)) {
        if (!hasMailboxConfig(env)) return json({ error: 'Configuration unavailable' }, { status: 503 });
        const auth = authFailure(request, env);
        if (auth) return auth;
        const mailbox = getMailbox(env);
        if (url.pathname === '/status' && request.method === 'GET') return json(await mailbox.getStatus());
        if (request.method !== 'POST') throw new InvalidRequestError('Method not allowed');
        if (url.pathname === '/run') await mailbox.enqueueScan();
        else if (url.pathname === '/watch') await mailbox.enqueueWatch();
        else if (url.pathname === '/resume') await mailbox.resume();
        else await mailbox.enqueueReprocess(reprocessIds(await body(request)));
        return json({ accepted: true }, { status: 202 });
      }
      return json({ error: 'Not found' }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    if (!hasMailboxConfig(env)) throw new Error('Mailbox configuration unavailable');
    const mailbox = getMailbox(env);
    await mailbox.enqueueScan();
    if (event.cron === '0 3 * * *') await mailbox.enqueueWatch();
  },
} satisfies ExportedHandler<Env>;

export default worker;
export { Mailbox } from './mailbox';
