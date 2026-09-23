import type { JevAnswer, JevResponse, TriageDecision } from './types.js';
import { validateJevResponse } from './jev.js';
import { TRIAGE_CONFIG } from './triage-config.js';

function answer(answers: JevResponse['answers'], key: string): JevAnswer {
  return answers![key];
}

function noul(answers: JevResponse['answers'], key: string): number {
  const value = answer(answers, key);
  return value.type === 'noul' ? value.noul! : 0;
}

function choice(answers: JevResponse['answers'], key: string): TriageDecision['issueType'] {
  const value = answer(answers, key);
  return value.type === 'choice' && Object.hasOwn(TRIAGE_CONFIG.issueTypes, value.choice ?? '')
    ? value.choice as TriageDecision['issueType']
    : 'other';
}

function score(answers: JevResponse['answers'], key: string): number {
  const value = answer(answers, key);
  return value.type === 'score' ? value.score! : 0;
}

export function toDecision(response: unknown): TriageDecision {
  const validated = validateJevResponse(response);
  const severityScore = score(validated.answers, 'severity');
  const issueType = choice(validated.answers, 'issue_type');
  const needsRepoInvestigation = noul(validated.answers, 'needs_repo_investigation') >= TRIAGE_CONFIG.thresholds.needsRepoInvestigation;
  const hasEnoughInformation = noul(validated.answers, 'has_enough_information') >= TRIAGE_CONFIG.thresholds.hasEnoughInformation;
  const severity = Object.entries(TRIAGE_CONFIG.severityLevels).sort((left, right) => left[1].order - right[1].order)[Math.round(severityScore)]?.[0] ?? 'low';
  const matchedRuleIds: string[] = [];
  if (issueType === 'bug' && needsRepoInvestigation) matchedRuleIds.push('flue-investigation');
  if (!hasEnoughInformation) matchedRuleIds.push('needs-more-information');
  return {
    issueType,
    severity: severity as TriageDecision['severity'],
    severityScore,
    needsRepoInvestigation,
    hasEnoughInformation,
    matchedRuleIds,
    raw: validated,
  };
}

export function labelsForDecision(decision: TriageDecision, flue: 'dispatched' | 'failed' | 'not-configured'): string[] {
  const labels = [
    TRIAGE_CONFIG.issueTypes[decision.issueType].label,
    TRIAGE_CONFIG.severityLevels[decision.severity].label,
  ];
  if (decision.needsRepoInvestigation) labels.push(TRIAGE_CONFIG.labels.needsInvestigation.label);
  if (!decision.hasEnoughInformation) labels.push(TRIAGE_CONFIG.labels.needsInformation.label);
  if (flue === 'dispatched') labels.push(TRIAGE_CONFIG.labels.flueRequested.label);
  if (flue === 'failed') labels.push(TRIAGE_CONFIG.labels.flueDispatchFailed.label);
  return labels;
}

export function shouldDispatchToFlue(decision: TriageDecision): boolean {
  return decision.matchedRuleIds.includes('flue-investigation');
}

export function formatTriageComment(decision: TriageDecision, flueMessage: string): string {
  const marker = '<!-- jev-issue-triage -->';
  return [
    marker,
    '## Jev triage',
    '',
    '- Type: ' + decision.issueType,
    '- Severity: ' + decision.severity + ' (score ' + decision.severityScore.toFixed(2) + '/3)',
    '- Repository investigation: ' + (decision.needsRepoInvestigation ? 'yes' : 'no'),
    '- Enough information to start: ' + (decision.hasEnoughInformation ? 'yes' : 'no'),
    '- Matched routing rules: ' + (decision.matchedRuleIds.join(', ') || 'none'),
    '- Flue: ' + flueMessage,
    '',
    '_This is an automated first-pass classification. Please review before taking action._',
  ].join('\n');
}
