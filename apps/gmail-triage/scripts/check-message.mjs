// Read-only label verification. Does not print message contents or credentials.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const varsIndex = args.indexOf('--vars');
const varsPath = varsIndex < 0 ? fileURLToPath(new URL('../.dev.vars', import.meta.url)) : args.splice(varsIndex, 2)[1];
if (args.length !== 1 || !/^[0-9a-f]+$/i.test(args[0])) throw new Error('Usage: node scripts/check-message.mjs <message-id> [--vars /absolute/path/.dev.vars]');
const vars = parseEnv(readFileSync(varsPath, 'utf8'));
const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', signal: AbortSignal.timeout(20000),
  body: new URLSearchParams({ client_id: vars.GMAIL_CLIENT_ID, client_secret: vars.GMAIL_CLIENT_SECRET,
    refresh_token: vars.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }),
});
if (!response.ok) throw new Error('OAuth failed: HTTP ' + response.status);
const { access_token } = await response.json();
if (!access_token) throw new Error('OAuth returned no access token');
async function gmail(path) {
  const result = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    headers: { authorization: 'Bearer ' + access_token }, signal: AbortSignal.timeout(20000),
  });
  if (!result.ok) throw new Error('Gmail failed: HTTP ' + result.status);
  return result.json();
}
const [message, labelResponse] = await Promise.all([
  gmail('messages/' + args[0] + '?format=minimal'), gmail('labels'),
]);
const labels = new Map(labelResponse.labels.map(label => [label.id, label.name]));
console.log(JSON.stringify({ messageId: message.id, labels: (message.labelIds ?? []).map(id => labels.get(id) ?? id) }));
