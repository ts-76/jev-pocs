import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export interface PushAuthConfig { PUBSUB_AUDIENCE?: string; PUBSUB_SERVICE_ACCOUNT_EMAIL?: string }

export class PushAuthError extends Error {
  constructor(public readonly status: number) { super(status === 503 ? 'Push authentication is not configured' : 'Invalid push authentication'); }
}

export async function verifyPush(request: Request, config: PushAuthConfig, keys: JWTVerifyGetKey = googleKeys): Promise<void> {
  if (!config.PUBSUB_AUDIENCE || !config.PUBSUB_SERVICE_ACCOUNT_EMAIL) throw new PushAuthError(503);
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new PushAuthError(401);
  try {
    const { payload } = await jwtVerify(authorization.slice(7), keys, {
      algorithms: ['RS256'], issuer: ['accounts.google.com', 'https://accounts.google.com'],
      audience: config.PUBSUB_AUDIENCE, requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified'],
      maxTokenAge: '1h', clockTolerance: 30,
    });
    if (payload.email !== config.PUBSUB_SERVICE_ACCOUNT_EMAIL || payload.email_verified !== true) throw new Error('Unexpected identity');
  } catch {
    throw new PushAuthError(401);
  }
}
