import config from './generated/rules-config.json';
import { createRuleEngine, parseRuleConfig } from './rule-engine';
import type { EmailEvaluation } from './types';

const validated = parseRuleConfig(config);
const labels = validated.labels;
export const LABELS = {
  triaged: labels.triaged, reply: labels.action, priority: labels.action,
  sales: labels.information, billing: labels.billing, revenue: labels.revenue,
  development: labels.development, work: labels.work, security: labels.security,
  disposable: labels.disposable,
} as const;
export const LABEL_NAMES = [...new Set([...Object.values(LABELS), ...Object.values(labels)])];
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  ['billing', 'revenue', 'development', 'work', 'information', 'security'].map(id => [id, labels[id]]),
);
export const classifyPattern = createRuleEngine(validated);

export function labelsForEvaluation(evaluation: EmailEvaluation): string[] {
  const result: string[] = [LABELS.triaged, ...(evaluation.ruleLabels ?? [])];
  const threshold = validated.thresholds;
  if (evaluation.category && (evaluation.categoryConfidence ?? 0) >= threshold.category && Object.hasOwn(CATEGORY_LABELS, evaluation.category)) {
    result.push(CATEGORY_LABELS[evaluation.category]);
  }
  if (evaluation.requiresReply >= threshold.requiresReply) result.push(LABELS.reply);
  if (evaluation.unsolicitedSales >= threshold.unsolicitedSales) result.push(LABELS.sales);
  if (evaluation.priority >= threshold.priority) result.push(LABELS.priority);
  return [...new Set(result)];
}
