// Read RUN_TOKEN locally; never place it in a shell argument or print it.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const [command = 'status', ...args] = process.argv.slice(2);
const varsIndex = args.indexOf('--vars');
const varsPath = varsIndex >= 0 ? args.splice(varsIndex, 2)[1] : fileURLToPath(new URL('../.dev.vars', import.meta.url));
if (!['status', 'run', 'watch', 'resume', 'reprocess'].includes(command)) throw new Error('Unsupported admin command');
if (command === 'reprocess' && (args.length < 1 || args.length > 20 || args.some(id => !/^[a-f0-9]+$/i.test(id)))) throw new Error('Supply 1–20 Gmail message IDs');
const secrets = parseEnv(readFileSync(varsPath, 'utf8'));
if (!secrets.RUN_TOKEN) throw new Error('RUN_TOKEN is missing');
if (!secrets.WORKER_URL) throw new Error('WORKER_URL is missing');
const response = await fetch(new URL(command, secrets.WORKER_URL).toString(), {
  method: command === 'status' ? 'GET' : 'POST',
  headers: { authorization: 'Bearer ' + secrets.RUN_TOKEN, 'content-type': 'application/json' },
  ...(command === 'reprocess' ? { body: JSON.stringify({ messageIds: args }) } : {}),
  signal: AbortSignal.timeout(30_000),
});
console.log(JSON.stringify({ status: response.status, result: await response.json() }));
if (!response.ok) process.exitCode = 1;
