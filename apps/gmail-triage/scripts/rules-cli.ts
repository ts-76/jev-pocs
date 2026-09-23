import { existsSync, readFileSync } from 'node:fs';
import { createRuleEngine } from '../src/rule-engine';
import type { EmailState } from '../src/types';

const [command, emailFile, configFile] = process.argv.slice(2);
const personalConfig = new URL('../config/rules.json', import.meta.url);
const defaultConfig = new URL('../config/rules.default.json', import.meta.url);
const config = JSON.parse(readFileSync(configFile ? configFile : existsSync(personalConfig) ? personalConfig : defaultConfig, 'utf8'));
const classify = createRuleEngine(config);
if (command === 'validate') {
  console.log('Rule configuration is valid.');
} else if (command === 'dry-run' && emailFile) {
  const data: unknown = JSON.parse(readFileSync(emailFile, 'utf8'));
  const emails = Array.isArray(data) ? data : [data];
  emails.forEach((email, index) => {
    if (!email || typeof email !== 'object' || typeof email.from !== 'string' || typeof email.subject !== 'string'
      || typeof email.snippet !== 'string' || ['body', 'receivedAt', 'evaluatedAt', 'timezone'].some(key => email[key] !== undefined && typeof email[key] !== 'string')) {
      throw new Error('Invalid EmailState at index ' + index);
    }
    console.log(JSON.stringify({ index, ...classify(email as EmailState) }));
  });
} else {
  throw new Error('Usage: rules-cli.ts validate | dry-run <email.json> [rules.json]');
}
