import type { Env } from './types';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function decodeBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

async function createState(env: Env, redirectUri: string): Promise<string> {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    issuedAt: Date.now(),
    redirectUri,
  })));
  return payload + '.' + await sign(payload, env.OAUTH_STATE_SECRET);
}

async function verifyState(env: Env, state: string): Promise<{ redirectUri: string }> {
  const [payload, signature] = state.split('.');
  if (!payload || !signature || signature !== await sign(payload, env.OAUTH_STATE_SECRET)) {
    throw new Error('Invalid OAuth state');
  }

  const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as {
    issuedAt?: number;
    redirectUri?: string;
  };
  if (!parsed.issuedAt || Date.now() - parsed.issuedAt > 10 * 60 * 1000 || !parsed.redirectUri) {
    throw new Error('Expired OAuth state');
  }
  return { redirectUri: parsed.redirectUri };
}

export async function buildAuthorizationUrl(env: Env, request: Request): Promise<string> {
  const redirectUri = env.GMAIL_REDIRECT_URI ?? new URL('/oauth/callback', request.url).toString();
  const state = await createState(env, redirectUri);
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.GMAIL_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', GMAIL_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeAuthorizationCode(env: Env, request: Request): Promise<string> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('Missing code or state');

  const { redirectUri } = await verifyState(env, state);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const payload = await response.json() as { refresh_token?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.refresh_token) {
    throw new Error(payload.error_description ?? payload.error ?? 'Google OAuth token exchange failed');
  }
  return payload.refresh_token;
}
