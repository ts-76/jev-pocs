import validateSchema from './generated/rules-validator.cjs';
import type { EmailState } from './types';

export type Condition = { all: Condition[] } | { any: Condition[] }
  | { field: 'from.address' | 'subject' | 'body'; operator: 'equals' | 'startsWith' | 'contains' | 'matches'; value: string; ignoreCase?: boolean }
  | { field: 'ageDays'; operator: 'greaterThanOrEqual'; value: number };
export interface RuleConfig {
  $schema?: string;
  version: 1;
  labels: Record<string, string>;
  thresholds: { category: number; requiresReply: number; unsolicitedSales: number; priority: number };
  rules: Array<{ id: string; description: string; when: Condition; actions: { addLabels: string[]; ai?: 'skip' } }>;
}

const requiredLabels = ['triaged', 'action', 'billing', 'revenue', 'development', 'work', 'information', 'security', 'disposable'];
const validate = validateSchema as unknown as ((input: unknown) => input is RuleConfig) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

/** Fail at module initialization, before any Gmail or AI calls. */
export function parseRuleConfig(input: unknown): RuleConfig {
  if (!validate(input)) throw new Error('Invalid triage config: ' + validate.errors?.map(error => (error.instancePath || '/') + ' ' + error.message).join('; '));
  const config = structuredClone(input);
  for (const id of requiredLabels) if (!config.labels[id]) throw new Error('Missing label ID: ' + id);
  if (config.labels.triaged !== 'AI/Triaged') throw new Error('triaged must remain AI/Triaged (processing checkpoint)');
  if (new Set(Object.values(config.labels)).size !== Object.keys(config.labels).length) throw new Error('Duplicate label display name');
  const ids = new Set<string>();
  function check(condition: Condition): void {
    if ('all' in condition) condition.all.forEach(check);
    else if ('any' in condition) condition.any.forEach(check);
    else if (condition.operator === 'matches') {
      try { new RegExp(condition.value, condition.ignoreCase ? 'i' : ''); }
      catch { throw new Error('Invalid regular expression in rule configuration'); }
    }
  }
  for (const rule of config.rules) {
    if (ids.has(rule.id)) throw new Error('Duplicate rule ID: ' + rule.id);
    ids.add(rule.id);
    for (const id of rule.actions.addLabels) {
      if (!Object.hasOwn(config.labels, id)) throw new Error('Unknown label ID: ' + id);
      if (id === 'triaged') throw new Error('Rules cannot set the processing checkpoint');
    }
    check(rule.when);
  }
  return config;
}

/** Compile once; configuration is trusted deployment input, email content is data. */
export function createRuleEngine(input: unknown) {
  const config = parseRuleConfig(input);
  type Context = { 'from.address': string; subject: string; body: string; ageDays: number };
  function compile(condition: Condition): (context: Context) => boolean {
    if ('all' in condition) { const parts = condition.all.map(compile); return ctx => parts.every(part => part(ctx)); }
    if ('any' in condition) { const parts = condition.any.map(compile); return ctx => parts.some(part => part(ctx)); }
    if (condition.field === 'ageDays') return ctx => Number.isFinite(ctx.ageDays) && ctx.ageDays >= condition.value;
    const regex = condition.operator === 'matches' ? new RegExp(condition.value, condition.ignoreCase ? 'i' : '') : undefined;
    const expected = condition.ignoreCase ? condition.value.toLowerCase() : condition.value;
    return ctx => {
      const original = ctx[condition.field];
      if (regex) return regex.test(original);
      const actual = condition.ignoreCase ? original.toLowerCase() : original;
      if (condition.operator === 'equals') return actual === expected;
      if (condition.operator === 'startsWith') return actual.startsWith(expected);
      return actual.includes(expected);
    };
  }
  const rules = config.rules.map(rule => ({ ...rule, matches: compile(rule.when) }));
  return (state: EmailState) => {
    const context: Context = {
      'from.address': (state.from.match(/<([^<>]+)>\s*$/)?.[1] ?? state.from.trim()).toLowerCase(),
      subject: state.subject, body: state.body ?? state.snippet,
      ageDays: (Date.parse(state.evaluatedAt ?? '') - Date.parse(state.receivedAt ?? '')) / 86400_000,
    };
    const matched = rules.filter(rule => rule.matches(context));
    const complete = matched.some(rule => rule.actions.ai === 'skip');
    return {
      labels: [...new Set(matched.flatMap(rule => rule.actions.addLabels.map(id => config.labels[id])))],
      complete,
      matchedRuleIds: matched.map(rule => rule.id),
      aiReason: complete ? 'complete_rule' as const : 'requires_evaluation' as const,
    };
  };
}
