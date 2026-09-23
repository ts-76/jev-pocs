import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const varsPath = fileURLToPath(new URL('../.dev.vars', import.meta.url));
const localVars = parseEnv(readFileSync(varsPath, 'utf8'));
const runtimeVars = ['GMAIL_ACCOUNT_EMAIL', 'PUBSUB_AUDIENCE', 'PUBSUB_SERVICE_ACCOUNT_EMAIL'];
const missing = runtimeVars.filter((key) => !localVars[key]);

if (missing.length > 0) {
  console.error('Set these local runtime variables in apps/gmail-triage/.dev.vars: ' + missing.join(', '));
  process.exit(1);
}

const args = ['exec', 'wrangler', 'dev', '--port', process.env.WRANGLER_DEV_PORT ?? '8787'];
for (const key of [...runtimeVars, 'MAILBOX_TIMEZONE']) {
  if (localVars[key]) args.push('--var', `${key}:${localVars[key]}`);
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(command, args, { cwd: appDirectory, stdio: 'inherit' });
child.on('error', (error) => {
  console.error('Could not start Wrangler dev: ' + error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
