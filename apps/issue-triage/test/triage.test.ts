import { describe, expect, it } from 'vitest';
import { formatTriageComment, labelsForDecision, toDecision } from '../src/triage';
import type { TriageDecision } from '../src/types';

describe('issue triage rules', () => {
  it('converts Jev answers into a routing decision', () => {
    const decision = toDecision({
      model: 'jev-1.13.0',
      answers: {
        issue_type: { type: 'choice', choice: 'bug', confidence: 0.9 },
        severity: { type: 'score', score: 2.2, confidence: 0.8 },
        needs_repo_investigation: { type: 'noul', noul: 0.9 },
        has_enough_information: { type: 'noul', noul: 0.8 },
      },
    });

    expect(decision.issueType).toBe('bug');
    expect(decision.severity).toBe('high');
    expect(decision.needsRepoInvestigation).toBe(true);
    expect(decision.hasEnoughInformation).toBe(true);
    expect(labelsForDecision(decision, 'dispatched')).toContain('triage:flue-requested');
  });

  it('rejects a response when the model omits an answer', () => {
    expect(() => toDecision({ model: 'jev-1.13.0', answers: {} })).toThrow('answers.issue_type');
  });

  it('writes a stable idempotent comment marker', () => {
    const decision: TriageDecision = {
      issueType: 'question',
      severity: 'low',
      severityScore: 0,
      needsRepoInvestigation: false,
      hasEnoughInformation: true,
      matchedRuleIds: [],
      raw: {},
    };
    const comment = formatTriageComment(decision, 'not needed');
    expect(comment.startsWith('<!-- jev-issue-triage -->')).toBe(true);
    expect(comment).toContain('Type: question');
  });
});
