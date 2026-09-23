import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredConfiguration = [
  'mailbox',
  'account_email',
  'pubsub_auth',
  'oauth_client',
  'gmail_auth',
  'pubsub_topic',
  'run_token',
  'ai',
];

const appDirectory = fileURLToPath(new URL('../', import.meta.url));

function readDevVars() {
  try {
    const contents = readFileSync(resolve(appDirectory, '.dev.vars'), 'utf8');
    return Object.fromEntries(
      contents
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))
        .filter(Boolean)
        .map(([, key, value]) => [key, value.replace(/^("|')(.*)\1$/, '$2')]),
    );
  } catch {
    return {};
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const devVars = readDevVars();
const workerUrl = argumentValue('--url') ?? process.env.WORKER_URL ?? devVars.WORKER_URL;

if (!workerUrl) {
  console.error('WORKER_URL is required. Set it in .dev.vars or pass --url <worker-url>.');
  process.exit(1);
}

const healthUrl = new URL('/health', workerUrl);
const response = await fetch(healthUrl);
const payload = await response.json().catch(() => undefined);
const configuration = payload?.configuration ?? {};
const missing = requiredConfiguration.filter((key) => configuration[key] !== true);

if (!response.ok || payload?.ok !== true || missing.length > 0) {
  console.error(JSON.stringify({ ok: false, status: response.status, missing }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, status: response.status, checked: requiredConfiguration }, null, 2));
