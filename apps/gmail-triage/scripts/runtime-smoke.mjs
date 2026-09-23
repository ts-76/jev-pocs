import assert from 'node:assert/strict';
import { createTestHarness } from 'wrangler';

const server = createTestHarness({ workers: [{ config: {
  name: 'gmail-triage-local-smoke', main: 'scripts/runtime-fixture.ts', compatibility_date: '2026-09-22',
  durable_objects: { bindings: [{ name: 'MAILBOX', class_name: 'Mailbox' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Mailbox'] }],
  vars: { RUN_TOKEN: 'local-test', GMAIL_CLIENT_ID: 'test', GMAIL_CLIENT_SECRET: 'test', GMAIL_REFRESH_TOKEN: 'test',
    GMAIL_ACCOUNT_EMAIL: 'user@example.com', GMAIL_PUBSUB_TOPIC: 'projects/test/topics/test',
    PUBSUB_AUDIENCE: 'https://worker.example/pubsub', PUBSUB_SERVICE_ACCOUNT_EMAIL: 'push@test.iam.gserviceaccount.com' },
} }] });
const headers = { authorization: 'Bearer local-test', 'content-type': 'application/json' };
async function calls() { return (await server.fetch('/test-calls')).json(); }
async function until(check) {
  for (let i = 0; i < 150; i++) {
    const result = await calls(); if (check(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local alarm processing did not finish');
}
try {
  await server.listen();
  assert.equal((await server.fetch('/status')).status, 401);
  assert.equal((await server.fetch('/pubsub', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await server.fetch('/reprocess', { method: 'POST', headers, body: JSON.stringify({ messageIds: ['not-an-id'] }) })).status, 400);
  assert.equal((await server.fetch('/run', { method: 'POST', headers })).status, 202);
  let result = await until(c => c.modify === 1);
  assert.equal(result.ai, 1);
  assert.deepEqual(result.applied, ['label_0', 'label_6', 'label_1']);
  assert.equal((await server.fetch('/run', { method: 'POST', headers })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal((await calls()).ai, 1);
  const before = await (await server.fetch('/status', { headers })).json();
  assert.equal((await server.fetch('/watch', { method: 'POST', headers })).status, 202);
  await until(c => c.watch === 1);
  const afterWatch = await (await server.fetch('/status', { headers })).json();
  assert.equal(afterWatch.historyCursor, before.historyCursor, 'watch must not skip pending history');
  await server.fetch('/test-fail-next-modify');
  assert.equal((await server.fetch('/reprocess', { method: 'POST', headers, body: JSON.stringify({ messageIds: ['aa'] }) })).status, 202);
  result = await until(c => c.modify === 2);
  assert.equal(result.ai, 2);
  assert.equal(result.modifyAttempts, 3, 'a transient label error must retry without a third AI call');
  console.log(JSON.stringify({ ok: true, scenario: 'real workerd + SQLite DO + alarms; authentication, Completed envelope, labels, duplicate scan, watch cursor, explicit reprocess, saved-evaluation retry after Gmail 503', calls: result, initialStatus: before }));
} finally {
  await server.close();
}
