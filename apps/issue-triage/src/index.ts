import { readFileSync } from 'node:fs';
import { dispatchToFlue, FlueDispatchError } from './flue.js';
import { GitHubClient } from './github.js';
import { evaluateIssue } from './jev.js';
import { formatTriageComment, labelsForDecision, shouldDispatchToFlue, toDecision } from './triage.js';
import { TRIAGE_CONFIG } from './triage-config.js';
import type { Env, FlueDispatchResult, IssueEvent } from './types.js';

const ACTIONS = new Set(['opened', 'edited', 'reopened']);

function readEnv(): Env {
  const env = process.env as unknown as Partial<Env>;
  const required: Array<keyof Env> = [
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'GITHUB_EVENT_PATH',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
  ];
  for (const key of required) {
    if (!env[key]) throw new Error(key + ' is not configured');
  }
  return env as Env;
}

function readEvent(path: string): IssueEvent {
  return JSON.parse(readFileSync(path, 'utf8')) as IssueEvent;
}

function flueIdempotencyKey(env: Env, event: IssueEvent): string {
  return [event.repository.full_name, event.issue.number, event.issue.updated_at ?? env.GITHUB_SHA ?? 'unknown'].join(':');
}

function flueMessage(result: FlueDispatchResult): string {
  if (result.status === 'dispatched') return 'requested';
  if (result.status === 'not-configured') return 'not configured';
  return 'failed: ' + (result.message ?? 'unknown error');
}

async function main(): Promise<void> {
  const env = readEnv();
  const event = readEvent(env.GITHUB_EVENT_PATH);
  if (!ACTIONS.has(event.action)) {
    console.log('Skipping unsupported action: ' + event.action);
    return;
  }

  const jevResponse = await evaluateIssue(env, event);
  const decision = toDecision(jevResponse);
  let flue: FlueDispatchResult = { status: 'not-configured', message: 'not needed' };
  let flueError: Error | undefined;

  if (shouldDispatchToFlue(decision)) {
    try {
      flue = await dispatchToFlue(env, {
        repository: event.repository.full_name,
        issueNumber: event.issue.number,
        title: event.issue.title,
        body: event.issue.body ?? '',
        url: event.issue.html_url,
        ref: env.GITHUB_REF_NAME ?? event.repository.default_branch ?? 'main',
        sha: env.GITHUB_SHA ?? '',
        idempotencyKey: flueIdempotencyKey(env, event),
        decision,
      });
    } catch (error) {
      const code = error instanceof FlueDispatchError ? error.code : 'flue_dispatch_error';
      flueError = new Error('Flue dispatch failed');
      flue = { status: 'failed', message: code };
    }
  }

  const github = new GitHubClient(env);
  const labels = labelsForDecision(decision, flue.status);
  const labelStyles: Record<string, [string, string]> = Object.fromEntries([
    ...Object.values(TRIAGE_CONFIG.issueTypes),
    ...Object.values(TRIAGE_CONFIG.severityLevels),
    ...Object.values(TRIAGE_CONFIG.labels),
  ].map((definition) => [definition.label, [definition.color, definition.description]]));

  await Promise.all(labels.map(async (label) => {
    const [color, description] = labelStyles[label] ?? ['ededed', 'Jev triage label'];
    await github.ensureLabel(label, color, description);
  }));
  await github.replaceManagedLabels(event.issue.number, event.issue.labels ?? [], labels);
  await github.upsertTriageComment(event.issue.number, formatTriageComment(decision, flueMessage(flue)));

  if (flueError) throw flueError;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
