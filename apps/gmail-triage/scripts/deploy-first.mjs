import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const secretsPath = fileURLToPath(new URL('../.secrets.production', import.meta.url));
const wranglerPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const secrets = parseEnv(readFileSync(secretsPath, 'utf8'));
const required = JSON.parse(readFileSync(wranglerPath, 'utf8')).secrets.required;
const missing = required.filter((key) => !secrets[key]?.trim());
const unexpected = Object.keys(secrets).filter((key) => !required.includes(key));
const placeholders = required.filter((key) => /(^|[/.])(?:your-|replace-with-)|<[^>]+>/i.test(secrets[key]?.trim() ?? ''));

if (missing.length || unexpected.length || placeholders.length) {
  if (missing.length) console.error('Missing production secrets: ' + missing.join(', '));
  if (unexpected.length) console.error('Remove non-secret or unknown keys from .secrets.production: ' + unexpected.join(', '));
  if (placeholders.length) console.error('Replace template values for: ' + placeholders.join(', '));
  process.exit(1);
}

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const child = spawn(command, [
  'exec', 'wrangler', 'deploy', '--keep-vars', '--secrets-file', '.secrets.production',
], { cwd: appDirectory, stdio: 'inherit' });
child.on('error', (error) => {
  console.error('Could not start Wrangler deploy: ' + error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
