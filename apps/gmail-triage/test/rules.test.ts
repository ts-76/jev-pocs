import { describe, expect, it } from 'vitest';
import { LABELS, labelsForEvaluation } from '../src/rules';
import type { EmailEvaluation } from '../src/types';

const evaluation = (overrides: Partial<EmailEvaluation> = {}): EmailEvaluation => ({
  requiresReply: 0.1,
  unsolicitedSales: 0.1,
  priority: 0.5,
  raw: {},
  ...overrides,
});

describe('gmail triage rules', () => {
  it('adds confident categories and leaves low-confidence categories unassigned', () => {
    expect(labelsForEvaluation(evaluation({ category: 'billing', categoryConfidence: 0.9 }))).toContain('請求・支払い');
    expect(labelsForEvaluation(evaluation({ category: 'billing', categoryConfidence: 0.5 }))).toEqual([LABELS.triaged]);
  });

  it('maps Jev scores to Gmail labels', () => {
    expect(labelsForEvaluation(evaluation({
      requiresReply: 0.9,
      unsolicitedSales: 0.9,
      priority: 2.4,
    }))).toEqual([LABELS.triaged, LABELS.reply, LABELS.sales]);
  });

  it('keeps legitimate zero scores as triaged only', () => {
    expect(labelsForEvaluation(evaluation({ requiresReply: 0, unsolicitedSales: 0, priority: 0 }))).toEqual([LABELS.triaged]);
  });

  it('includes labels at their exact thresholds', () => {
    expect(labelsForEvaluation(evaluation({ requiresReply: 0.75, unsolicitedSales: 0.85, priority: 2 }))).toEqual([LABELS.triaged, LABELS.reply, LABELS.sales]);
  });
});
