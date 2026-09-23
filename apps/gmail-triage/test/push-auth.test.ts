import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { verifyPush } from '../src/push-auth';

const config = { PUBSUB_AUDIENCE: 'https://worker.example/pubsub', PUBSUB_SERVICE_ACCOUNT_EMAIL: 'push@example.iam.gserviceaccount.com' };
let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256' }] });
});
async function request(overrides = {}, audience = config.PUBSUB_AUDIENCE, expiration = '1h') {
  const token = await new SignJWT({ email: config.PUBSUB_SERVICE_ACCOUNT_EMAIL, email_verified: true, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('123').setIssuer('https://accounts.google.com')
    .setAudience(audience).setIssuedAt().setExpirationTime(expiration).sign(privateKey);
  return new Request(config.PUBSUB_AUDIENCE, { headers: { authorization: 'Bearer ' + token } });
}
describe('Pub/Sub identity verification', () => {
  it('accepts signed expected identity', async () => { await expect(verifyPush(await request(), config, keys)).resolves.toBeUndefined(); });
  it('rejects missing auth', async () => { await expect(verifyPush(new Request(config.PUBSUB_AUDIENCE), config, keys)).rejects.toMatchObject({ status: 401 }); });
  it('fails closed when unconfigured', async () => { await expect(verifyPush(await request(), {}, keys)).rejects.toMatchObject({ status: 503 }); });
  it('rejects wrong audience', async () => { await expect(verifyPush(await request({}, 'other'), config, keys)).rejects.toMatchObject({ status: 401 }); });
  it('rejects wrong service account', async () => { await expect(verifyPush(await request({ email: 'other@example.com' }), config, keys)).rejects.toMatchObject({ status: 401 }); });
  it('rejects unverified email', async () => { await expect(verifyPush(await request({ email_verified: false }), config, keys)).rejects.toMatchObject({ status: 401 }); });
  it('rejects expired token', async () => { await expect(verifyPush(await request({}, config.PUBSUB_AUDIENCE, '-1h'), config, keys)).rejects.toMatchObject({ status: 401 }); });
  it('rejects forged signature', async () => {
    const req = await request(); const token = req.headers.get('authorization')!;
    req.headers.set('authorization', token.slice(0, token.lastIndexOf('.') + 1) + 'AAAA');
    await expect(verifyPush(req, config, keys)).rejects.toMatchObject({ status: 401 });
  });
});
