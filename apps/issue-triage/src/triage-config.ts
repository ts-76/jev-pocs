import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';

export type IssueType = 'bug' | 'feature' | 'question' | 'docs' | 'other';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type AnswerType = 'choice' | 'score' | 'noul';

export interface LabelDefinition {
  label: string;
  color: string;
  description: string;
}

export interface CatalogDefinition extends LabelDefinition {
  criteria: string;
  order?: number;
}

export interface TriageConfig {
  version: 1;
  model: string;
  thresholds: { needsRepoInvestigation: number; hasEnoughInformation: number };
  issueTypes: Record<IssueType, CatalogDefinition>;
  severityLevels: Record<Severity, CatalogDefinition & { order: number }>;
  labels: {
    needsInvestigation: LabelDefinition;
    needsInformation: LabelDefinition;
    flueRequested: LabelDefinition;
    flueDispatchFailed: LabelDefinition;
  };
  questions: Record<'issue_type' | 'severity' | 'needs_repo_investigation' | 'has_enough_information', { type: AnswerType; instructions: string; criteria?: string[] | Record<string, string> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Invalid triage config: ' + field);
  return value;
}

function requireThreshold(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid triage config: ' + field);
  return value;
}

function requireColor(value: unknown, field: string): string {
  const color = requireText(value, field);
  if (!/^[0-9a-fA-F]{6}$/.test(color)) throw new Error('Invalid triage config: ' + field);
  return color;
}

function catalog(value: unknown, field: string): Record<string, CatalogDefinition> {
  if (!isRecord(value) || Object.keys(value).length === 0) throw new Error('Invalid triage config: ' + field);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!isRecord(item)) throw new Error('Invalid triage config: ' + field + '.' + key);
    if (item.order !== undefined && (typeof item.order !== 'number' || !Number.isInteger(item.order) || item.order < 0)) throw new Error('Invalid triage config: ' + field + '.' + key + '.order');
    return [key, {
      label: requireText(item.label, field + '.' + key + '.label'),
      color: requireColor(item.color, field + '.' + key + '.color'),
      description: requireText(item.description, field + '.' + key + '.description'),
      criteria: requireText(item.criteria, field + '.' + key + '.criteria'),
      ...(item.order === undefined ? {} : { order: item.order }),
    }];
  }));
}

export function parseTriageConfig(value: unknown): TriageConfig {
  const schema = JSON.parse(readFileSync(new URL('../config/triage.schema.json', import.meta.url), 'utf8')) as object;
  const validator = new Ajv({ strict: true, allErrors: true }).compile(schema);
  if (!validator(value)) throw new Error('Invalid triage config schema: ' + (validator.errors ?? []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; '));
  if (!isRecord(value) || value.version !== 1) throw new Error('Invalid triage config: version');
  const thresholds = value.thresholds;
  if (!isRecord(thresholds)) throw new Error('Invalid triage config: thresholds');
  const issueTypes = catalog(value.issueTypes, 'issueTypes');
  const severityLevels = catalog(value.severityLevels, 'severityLevels');
  const labelsValue = value.labels;
  if (!isRecord(labelsValue)) throw new Error('Invalid triage config: labels');
  const labels = Object.fromEntries(['needsInvestigation', 'needsInformation', 'flueRequested', 'flueDispatchFailed'].map((key) => {
    const item = labelsValue[key];
    if (!isRecord(item)) throw new Error('Invalid triage config: labels.' + key);
    return [key, { label: requireText(item.label, 'labels.' + key + '.label'), color: requireColor(item.color, 'labels.' + key + '.color'), description: requireText(item.description, 'labels.' + key + '.description') }];
  }));
  const questionsValue = value.questions;
  if (!isRecord(questionsValue)) throw new Error('Invalid triage config: questions');
  const questions = Object.fromEntries(['issue_type', 'severity', 'needs_repo_investigation', 'has_enough_information'].map((key) => {
    const item = questionsValue[key];
    if (!isRecord(item) || !['choice', 'score', 'noul'].includes(item.type as string)) throw new Error('Invalid triage config: questions.' + key);
    const criteria = item.criteria;
    if (criteria !== undefined && !Array.isArray(criteria) && !isRecord(criteria)) throw new Error('Invalid triage config: questions.' + key + '.criteria');
    return [key, { type: item.type as AnswerType, instructions: requireText(item.instructions, 'questions.' + key + '.instructions'), ...(criteria === undefined ? {} : { criteria }) }];
  }));
  const typeKeys = Object.keys(issueTypes);
  if (typeKeys.length !== 5 || ['bug', 'feature', 'question', 'docs', 'other'].some((key) => !Object.hasOwn(issueTypes, key))) throw new Error('Invalid triage config: issueTypes');
  if (Object.keys(severityLevels).some((key) => !['low', 'medium', 'high', 'critical'].includes(key)) || Object.keys(severityLevels).length !== 4 || Object.values(severityLevels).some((item) => item.order === undefined)) throw new Error('Invalid triage config: severityLevels');
  const orders = Object.values(severityLevels).map((item) => item.order).filter((order): order is number => order !== undefined).sort((left, right) => left - right);
  if (JSON.stringify(orders) !== JSON.stringify([0, 1, 2, 3])) throw new Error('Invalid triage config: severityLevels.order');
  const expectedQuestionTypes: Record<string, AnswerType> = { issue_type: 'choice', severity: 'score', needs_repo_investigation: 'noul', has_enough_information: 'noul' };
  for (const [key, type] of Object.entries(expectedQuestionTypes)) if (questions[key as keyof typeof questions].type !== type) throw new Error('Invalid triage config: questions.' + key + '.type');
  const labelNames = [...Object.values(issueTypes), ...Object.values(severityLevels), ...Object.values(labels)].map((item) => item.label);
  if (new Set(labelNames).size !== labelNames.length) throw new Error('Invalid triage config: duplicate label');
  return {
    version: 1,
    model: requireText(value.model, 'model'),
    thresholds: {
      needsRepoInvestigation: requireThreshold(thresholds.needsRepoInvestigation, 'thresholds.needsRepoInvestigation'),
      hasEnoughInformation: requireThreshold(thresholds.hasEnoughInformation, 'thresholds.hasEnoughInformation'),
    },
    issueTypes: issueTypes as TriageConfig['issueTypes'],
    severityLevels: severityLevels as TriageConfig['severityLevels'],
    labels: labels as TriageConfig['labels'],
    questions: questions as TriageConfig['questions'],
  };
}

const configPath = process.env.ISSUE_TRIAGE_CONFIG;
const configUrl = configPath ? configPath : new URL('../config/triage.json', import.meta.url);
export const TRIAGE_CONFIG = parseTriageConfig(JSON.parse(readFileSync(configUrl, 'utf8')));
