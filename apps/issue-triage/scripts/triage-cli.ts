import { readFileSync } from 'node:fs';
import { labelsForDecision, toDecision } from '../src/triage.js';
import { TRIAGE_CONFIG } from '../src/triage-config.js';

const [command, responseFile] = process.argv.slice(2);

if (command === 'validate') {
  console.log('Issue triage configuration is valid.');
} else if (command === 'dry-run' && responseFile) {
  const response = JSON.parse(readFileSync(responseFile, 'utf8')) as unknown;
  const decision = toDecision(response);
  console.log(JSON.stringify({
    ...decision,
    labels: labelsForDecision(decision, 'not-configured'),
    model: TRIAGE_CONFIG.model,
    raw: undefined,
  }));
} else {
  throw new Error('Usage: triage-cli.ts validate | dry-run <jev-response.json>');
}
