/**
 * PRI-1208 Stage 0 — frozen RuleHost decision corpus.
 *
 * This file freezes the OBSERVABLE decision tuple of the single live runtime
 * path (`createProductionRuleHostGate`, reached through
 * `createProductionHostRuntime(...).dispatch`). It intentionally runs no
 * legacy `RuleHost` oracle: the legacy path has no production wiring, and the
 * audit baseline (`docs/reports/PD_RULEHOST_SEMANTIC_AUDIT_20261112.md`,
 * `38ef598`) already established that the live path is the only verdict
 * producer.
 *
 * The expected tuples in `fixtures/rulehost-semantics/cases.json` are typed by
 * hand from the live path. They are NOT snapshots: do not run `-u` or
 * `toMatchSnapshot`. Changing an expected value is a semantic change and needs
 * its own reviewed diff.
 *
 * `reason` text is deliberately not compared (wording is not semantics).
 *
 * Adjacent frozen evidence lives in dedicated tests and is referenced instead
 * of duplicated here:
 *   - resource bounds / 32-rule limit / 64KB / 3s deadline:
 *     `tests/production-host-runtime.test.ts`
 *   - duplicate target_ref, tampered digest:
 *     `tests/production-rulehost-gate-digest.test.ts`
 *   - v2 suspension when history is unavailable:
 *     `tests/production-rulehost-gate-v2-isolation.test.ts`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteActivationStateStore, SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime';
import { createProductionHostRuntime } from '../../src/index.js';

type RuleMode = 'live' | 'shadow';

interface RuleSpec {
  mode: RuleMode;
  behavior: string;
  ruleId: string;
  principleId?: string;
}

interface ExpectedTuple {
  decision: 'allow' | 'deny';
  matched: boolean | null;
  ruleId: string | null;
  principleId: string | null;
  ruleDecision: string | null;
  warningCodes: string[];
  evaluationDecisions: string[];
  hasCorrectionProposal: boolean;
}

interface CorpusCase {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  rules: RuleSpec[];
  expected: ExpectedTuple;
}

interface CorpusFile {
  corpusVersion: number;
  cases: CorpusCase[];
}

interface GateResult {
  decision: 'allow' | 'deny';
  reason?: string;
  warnings?: string[];
  metadata?: Readonly<Record<string, unknown>>;
}

const CORPUS = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'rulehost-semantics', 'cases.json'),
  'utf8',
)) as CorpusFile;

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulehost-corpus-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function behaviorBody(behavior: string): string {
  switch (behavior) {
    case 'block-on-risk-path':
      return `
  if (typeof input.action.normalizedPath === 'string' && input.action.normalizedPath.indexOf('/etc/') === 0) {
    return { decision: 'block', matched: true, reason: 'risk path' };
  }
  return { decision: 'allow', matched: false, reason: 'not a risk path' };`;
    case 'block-empty-reason':
      return `\n  return { decision: 'block', matched: true, reason: '' };`;
    case 'allow':
      return `\n  return { decision: 'allow', matched: false, reason: 'no opinion' };`;
    case 'auto-correct':
      return `
  return {
    decision: 'auto_correct',
    matched: true,
    reason: 'rewrite unsafe content',
    correctionProposal: {
      proposedParams: { file_path: input.action.normalizedPath, content: 'safe' },
      correctedFields: [{ field: 'content', original: 'unsafe', proposed: 'safe', reason: 'unsafe content' }],
      applicationMode: 'live',
      confidence: 0.9,
      ruleId: 'R_AC',
      principleId: 'P_AC',
      notifyAgent: true
    }
  };`;
    case 'require-approval':
      return `\n  return { decision: 'requireApproval', matched: true, reason: 'owner approval required' };`;
    case 'invalid-output':
      return `\n  return { decision: 'nope' };`;
    case 'block-on-synthetic-target':
      return `
  if (typeof input.action.normalizedPath === 'string' && input.action.normalizedPath.indexOf('<tool:') === 0) {
    return { decision: 'block', matched: true, reason: 'synthetic target' };
  }
  return { decision: 'allow', matched: false, reason: 'has a real path' };`;
    case 'block-on-risk-flag':
      return `
  if (input.workspace.isRiskPath === true) {
    return { decision: 'block', matched: true, reason: 'risk flag' };
  }
  return { decision: 'allow', matched: false, reason: 'not a risk flag' };`;
    case 'block-on-line-changes':
      return `
  if (input.derived.estimatedLineChanges > 0) {
    return { decision: 'block', matched: true, reason: 'line changes visible' };
  }
  return { decision: 'allow', matched: false, reason: 'no line changes' };`;
    case 'block-on-tier':
      return `
  if (input.evolution.epTier === 1) {
    return { decision: 'block', matched: true, reason: 'tier one' };
  }
  return { decision: 'allow', matched: false, reason: 'not tier one' };`;
    default:
      throw new Error(`unknown corpus behavior: ${behavior}`);
  }
}

function ruleCode(rule: RuleSpec): string {
  return `function evaluate(input) {${behaviorBody(rule.behavior)}
}
var meta = { name: ${JSON.stringify(rule.ruleId)}, version: '1', ruleId: ${JSON.stringify(rule.ruleId)}, coversCondition: 'all' };`;
}

async function seedRule(workspaceDir: string, rule: RuleSpec, suffix: string): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const now = new Date().toISOString();
    connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `art-${suffix}`, 'rule', `task-${suffix}`, rule.principleId ?? 'P_CORPUS', rule.ruleId, '[]', 'validated',
      JSON.stringify({
        principleId: rule.principleId ?? 'P_CORPUS',
        ruleId: rule.ruleId,
        implementationCode: ruleCode(rule),
      }),
      now, now,
    );
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-${suffix}`,
      idempotencyKey: `${suffix}::${rule.mode}`,
      artifactId: `art-${suffix}`,
      channel: 'code_tool_hook',
      action: rule.mode === 'live' ? 'code_tool_hook_live_activate' : 'code_tool_hook_shadow_activate',
      targetRef: `impl://${rule.ruleId}`,
      activatedAt: now,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

function gateEvent(workspaceDir: string, toolName: string, params: Record<string, unknown>) {
  return {
    kind: 'before_tool_call' as const,
    context: { workspaceDir, sessionId: 'session-corpus', toolName },
    rawPayload: { toolInput: { toolName, params } },
    source: 'test:rulehost-corpus',
  };
}

function warningCode(warning: string): string {
  const head = warning.split('; nextAction=')[0] ?? warning;
  const colon = head.indexOf(':');
  return (colon >= 0 ? head.slice(0, colon) : head).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decisionTuple(result: GateResult): ExpectedTuple {
  const metadata = result.metadata ?? {};
  const rawEvaluations = Array.isArray(metadata['evaluations']) ? metadata['evaluations'] : [];
  const evaluationDecisions = rawEvaluations
    .filter(isRecord)
    .map((entry) => {
      const mode = typeof entry['activationMode'] === 'string' ? entry['activationMode'] : 'live';
      const decision = typeof entry['decision'] === 'string' ? entry['decision'] : 'unknown';
      return `${mode}:${decision}`;
    })
    .sort();
  return {
    decision: result.decision,
    matched: typeof metadata['matched'] === 'boolean' ? metadata['matched'] : null,
    ruleId: typeof metadata['ruleId'] === 'string' ? metadata['ruleId'] : null,
    principleId: typeof metadata['principleId'] === 'string' ? metadata['principleId'] : null,
    ruleDecision: typeof metadata['ruleDecision'] === 'string' ? metadata['ruleDecision'] : null,
    // `[RuleHost] ...` lines are forwarded internal log text, not host contract
    // warnings; the tuple freezes the latter only (wording is not semantics).
    warningCodes: (result.warnings ?? []).map(warningCode).filter((code) => !code.startsWith('[RuleHost]')).sort(),
    evaluationDecisions,
    hasCorrectionProposal: Object.hasOwn(metadata, 'correctionProposal') && metadata['correctionProposal'] !== undefined,
  };
}

export function compareDecisionTuples(actual: ExpectedTuple, expected: ExpectedTuple): string[] {
  const diffs: string[] = [];
  for (const key of ['decision', 'matched', 'ruleId', 'principleId', 'ruleDecision', 'hasCorrectionProposal'] as const) {
    if (actual[key] !== expected[key]) diffs.push(`${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`);
  }
  for (const key of ['warningCodes', 'evaluationDecisions'] as const) {
    if (actual[key].join('|') !== expected[key].join('|')) {
      diffs.push(`${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`);
    }
  }
  return diffs;
}

async function runCorpusCase(testCase: CorpusCase): Promise<GateResult> {
  const workspaceDir = tempWorkspace();
  // Create the governance store even for the zero-rule case: a missing DB is a
  // different degradation (`activation_db_not_found`) than "armed but empty".
  const bootstrap = new SqliteConnection(workspaceDir);
  bootstrap.getDb();
  bootstrap.close();
  for (const [index, rule] of testCase.rules.entries()) {
    await seedRule(workspaceDir, rule, `${testCase.id}-${index}`);
  }
  const runtime = createProductionHostRuntime({
    hostKind: 'openclaw',
    afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
  });
  return runtime.dispatch(gateEvent(workspaceDir, testCase.toolName, testCase.params));
}

describe('RuleHost frozen semantic corpus (PRI-1208 stage 0)', () => {
  it('loads a non-empty, versioned corpus', () => {
    expect(CORPUS.corpusVersion).toBe(1);
    expect(CORPUS.cases.length).toBeGreaterThanOrEqual(10);
    const ids = CORPUS.cases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const testCase of CORPUS.cases) {
    it(`freezes ${testCase.id}`, async () => {
      const actual = decisionTuple(await runCorpusCase(testCase));
      expect(compareDecisionTuples(actual, testCase.expected)).toEqual([]);
    });
  }

  it('sensitivity: the comparator rejects a flipped decision, matched flag and ruleId', async () => {
    const sample = CORPUS.cases.find((entry) => entry.id === 'live-allow');
    if (!sample) throw new Error('corpus is missing the live-allow sensitivity sample');
    const actual = decisionTuple(await runCorpusCase(sample));
    expect(compareDecisionTuples(actual, sample.expected)).toEqual([]);
    expect(compareDecisionTuples(actual, { ...sample.expected, decision: 'deny' })).toContain(
      'decision: expected "deny", got "allow"',
    );
    expect(compareDecisionTuples(actual, { ...sample.expected, matched: true })).toContain(
      'matched: expected true, got false',
    );
    expect(compareDecisionTuples(actual, { ...sample.expected, ruleId: 'R_FAKE' })).toContain(
      'ruleId: expected "R_FAKE", got null',
    );
  });

  it('freezes the epTier policy: absent enrichment=0, OpenClaw enrichment=1', async () => {
    const workspaceDir = tempWorkspace();
    await seedRule(workspaceDir, {
      mode: 'live', behavior: 'block-on-tier', ruleId: 'R_TIER', principleId: 'P_TIER',
    }, 'tier');

    const defaultRuntime = createProductionHostRuntime({
      hostKind: 'openclaw',
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    await expect(defaultRuntime.dispatch(gateEvent(workspaceDir, 'write_file', { file_path: '/tmp/tier.txt', content: 'x' })))
      .resolves.toMatchObject({ decision: 'allow' });

    const enrichedRuntime = createProductionHostRuntime({
      hostKind: 'openclaw',
      ruleInputEnrichmentProvider: () => ({ epTier: 1, bashRisk: 'normal' }),
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    await expect(enrichedRuntime.dispatch(gateEvent(workspaceDir, 'write_file', { file_path: '/tmp/tier.txt', content: 'x' })))
      .resolves.toMatchObject({ decision: 'deny' });
  });
});
