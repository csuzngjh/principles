/**
 * PRI-1309 characterization — production-boundary RuleHost target attribution.
 *
 * A live probe rule is executed by the real production host runtime and the
 * real Node RuleCode implementation runtime. The probe reports the action it
 * actually received through a requireApproval reason (chosen because the
 * shared gate records that reason while still returning the host-level
 * decision `allow`). This separates two funnels that are easy to confuse:
 *
 *   - mechanical gate funnel: an evaluable kind with a non-empty
 *     normalizedPath reaches RuleCode evaluation;
 *   - semantic resource attribution: the normalizedPath is proven to identify
 *     the resource(s) the host tool will mutate.
 *
 * Only the direct structured-path case is semantically resource-attributed.
 * Synthetic labels, opaque command text, first-token shell captures and
 * collapsed multi-target shapes are characterized honestly as non-resource or
 * attribution-unprovable. Positive and negative controls are explicit cases in
 * the matrix below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime';
import type { HostEvent, HostEventResult } from '@principles/core/host';
import { createProductionHostRuntime } from '../../src/index.js';

const RULE_ID = 'R_TARGET_ATTRIBUTION_PROBE_1309';
const PRINCIPLE_ID = 'P_TARGET_ATTRIBUTION_PROBE_1309';
const ARTIFACT_ID = 'art-target-attribution-probe-1309';
const ACTIVATION_ID = 'act-target-attribution-probe-1309';
const PROBE_REASON_PREFIX = 'TARGET_PROBE_1309:';

const SINGLE_FILE_PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '@@',
  '-old',
  '+new',
  '*** End Patch',
].join('\n');

const MULTI_FILE_PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '@@',
  '-old',
  '+new',
  '*** Update File: docs/readme.md',
  '@@',
  '-before',
  '+after',
  '*** End Patch',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The probe intentionally returns requireApproval, never block: this keeps the
 * host-level gate decision observable as `allow` while the ruleDecision layer
 * carries the action snapshot back to the test. It is instrumentation through
 * the production RuleCode contract, not evidence that approval pauses a host.
 */
function probeRuleSource(): string {
  return `
function evaluate(input) {
  return {
    decision: 'requireApproval',
    matched: true,
    reason: ${JSON.stringify(PROBE_REASON_PREFIX)} + JSON.stringify({
      normalizedPath: input.action.normalizedPath,
      canonicalKind: input.action.canonicalKind,
      toolName: input.action.toolName,
      paramsSummary: input.action.paramsSummary
    })
  };
}
var meta = { name: 'target-attribution-probe', version: '1', ruleId: ${JSON.stringify(RULE_ID)}, coversCondition: 'all' };
`;
}

async function seedProbeRule(workspaceDir: string): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const now = new Date().toISOString();
    connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ARTIFACT_ID,
      'rule',
      'task-target-attribution-probe-1309',
      PRINCIPLE_ID,
      RULE_ID,
      '[]',
      'validated',
      JSON.stringify({
        principleId: PRINCIPLE_ID,
        ruleId: RULE_ID,
        implementationCode: probeRuleSource(),
      }),
      now,
      now,
    );
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: ACTIVATION_ID,
      idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
      artifactId: ARTIFACT_ID,
      channel: 'code_tool_hook',
      action: 'code_tool_hook_live_activate',
      targetRef: `impl://${RULE_ID}`,
      activatedAt: now,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

interface ProbeObservation {
  normalizedPath: string;
  canonicalKind: string;
  toolName: string;
  paramsSummary: Record<string, unknown>;
}

/** Null means the production rule implementation was never invoked. */
function readProbeObservation(result: HostEventResult): ProbeObservation | null {
  const reason = result.metadata?.['ruleReason'];
  if (reason === undefined) return null;
  if (typeof reason !== 'string' || !reason.startsWith(PROBE_REASON_PREFIX)) {
    throw new Error(`probe reason missing or malformed: ${String(reason)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reason.slice(PROBE_REASON_PREFIX.length));
  } catch (error) {
    throw new Error(`probe reason JSON did not parse: ${String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('probe observation is not an object');
  const normalizedPath = parsed['normalizedPath'];
  const canonicalKind = parsed['canonicalKind'];
  const toolName = parsed['toolName'];
  const paramsSummary = parsed['paramsSummary'];
  if (typeof normalizedPath !== 'string' || typeof canonicalKind !== 'string' || typeof toolName !== 'string' || !isRecord(paramsSummary)) {
    throw new Error(`probe observation has an invalid shape: ${JSON.stringify(parsed)}`);
  }
  return { normalizedPath, canonicalKind, toolName, paramsSummary };
}

type MechanicalOutcome = 'evaluated' | 'skipped-before-evaluation';
type SemanticClassification =
  | 'resource-attributed-direct'
  | 'synthetic-target-not-resource'
  | 'opaque-command-not-resource'
  | 'attribution-unprovable-first-token'
  | 'multi-target-collapsed-unprovable'
  | 'no-target-skip'
  | 'non-evaluable-kind-skip';

interface MatrixCase {
  title: string;
  toolName: string;
  params: Record<string, unknown>;
  mechanical: MechanicalOutcome;
  semantic: SemanticClassification;
  expectedCanonicalKind: string;
  expectedNormalizedPath?: string;
  /** Targets present in the original payload but absent from normalizedPath. */
  invisibleTargets?: readonly string[];
}

const MATRIX: readonly MatrixCase[] = [
  {
    title: 'positive control: direct structured write path',
    toolName: 'write_file',
    params: { file_path: 'src/a.ts', content: 'x' },
    mechanical: 'evaluated',
    semantic: 'resource-attributed-direct',
    expectedCanonicalKind: 'write',
    expectedNormalizedPath: 'src/a.ts',
  },
  {
    title: 'native apply_patch command carrier',
    toolName: 'apply_patch',
    params: { command: SINGLE_FILE_PATCH },
    mechanical: 'evaluated',
    semantic: 'synthetic-target-not-resource',
    expectedCanonicalKind: 'write',
    expectedNormalizedPath: '<tool:apply_patch>',
  },
  {
    title: 'multi-file native apply_patch command carrier',
    toolName: 'apply_patch',
    params: { command: MULTI_FILE_PATCH },
    mechanical: 'evaluated',
    semantic: 'synthetic-target-not-resource',
    expectedCanonicalKind: 'write',
    expectedNormalizedPath: '<tool:apply_patch>',
    invisibleTargets: ['src/a.ts', 'docs/readme.md'],
  },
  {
    title: 'opaque git status command',
    toolName: 'bash',
    params: { command: 'git status' },
    mechanical: 'evaluated',
    semantic: 'opaque-command-not-resource',
    expectedCanonicalKind: 'execute',
    expectedNormalizedPath: 'git status',
  },
  {
    title: 'cp source destination shell mutation',
    toolName: 'bash',
    params: { command: 'cp src dst' },
    mechanical: 'evaluated',
    semantic: 'attribution-unprovable-first-token',
    expectedCanonicalKind: 'execute',
    expectedNormalizedPath: 'src',
    invisibleTargets: ['dst'],
  },
  {
    title: 'mv old new shell mutation',
    toolName: 'bash',
    params: { command: 'mv old new' },
    mechanical: 'evaluated',
    semantic: 'attribution-unprovable-first-token',
    expectedCanonicalKind: 'execute',
    expectedNormalizedPath: 'old',
    invisibleTargets: ['new'],
  },
  {
    title: 'rm with two operands shell mutation',
    toolName: 'bash',
    params: { command: 'rm a b' },
    mechanical: 'evaluated',
    semantic: 'multi-target-collapsed-unprovable',
    expectedCanonicalKind: 'execute',
    expectedNormalizedPath: 'a',
    invisibleTargets: ['b'],
  },
  {
    title: 'negative control: execute without command',
    toolName: 'bash',
    params: {},
    mechanical: 'skipped-before-evaluation',
    semantic: 'no-target-skip',
    expectedCanonicalKind: 'execute',
  },
  {
    title: 'negative control: pathless agent call',
    toolName: 'sessions_spawn',
    params: { task: 'investigate the workspace' },
    mechanical: 'skipped-before-evaluation',
    semantic: 'no-target-skip',
    expectedCanonicalKind: 'agent',
  },
  {
    title: 'negative control: read kind is outside the evaluable family even with a direct path',
    toolName: 'read',
    params: { file_path: 'src/a.ts' },
    mechanical: 'skipped-before-evaluation',
    semantic: 'non-evaluable-kind-skip',
    expectedCanonicalKind: 'read',
  },
];

let workspaceDir: string;
let runtime: ReturnType<typeof createProductionHostRuntime>;

beforeAll(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulehost-target-attribution-'));
  await seedProbeRule(workspaceDir);
  runtime = createProductionHostRuntime({
    afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
  });
});

afterAll(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function dispatchCase(testCase: MatrixCase): Promise<HostEventResult> {
  const event: HostEvent = {
    kind: 'before_tool_call',
    context: {
      workspaceDir,
      sessionId: 'target-attribution-session',
      toolName: testCase.toolName,
    },
    rawPayload: { toolInput: { toolName: testCase.toolName, params: testCase.params } },
    source: 'test:rulehost-target-attribution',
  };
  return runtime.dispatch(event);
}

describe('PRI-1309 production-boundary target attribution matrix', () => {
  for (const testCase of MATRIX) {
    it(`mechanical:${testCase.mechanical} semantic:${testCase.semantic} — ${testCase.title}`, async () => {
      const result = await dispatchCase(testCase);
      // The probe's requireApproval is a ruleDecision-layer fact only. It does
      // not become deny/pause at the shared HostEventResult.decision layer.
      expect(result.decision).toBe('allow');
      const observation = readProbeObservation(result);

      if (testCase.mechanical === 'skipped-before-evaluation') {
        expect(observation, 'negative control: the RuleCode implementation must not execute').toBeNull();
        expect(result.metadata?.['evaluatedLiveRules']).toBe(0);
        expect(result.metadata?.['ruleDecision']).toBeUndefined();
        expect(result.metadata?.['evaluations']).toBeUndefined();
        expect(result.warnings ?? []).toEqual([]);
        return;
      }

      expect(observation, 'positive control: an evaluated action must reach the live production probe').not.toBeNull();
      if (observation === null) throw new Error('probe did not observe an evaluated action');
      expect(observation.toolName).toBe(testCase.toolName);
      expect(observation.canonicalKind).toBe(testCase.expectedCanonicalKind);
      expect(
        observation.normalizedPath,
        `${testCase.semantic}: mechanical gate entry is not, by itself, semantic resource attribution`,
      ).toBe(testCase.expectedNormalizedPath);
      expect(result.metadata?.['evaluatedLiveRules']).toBe(1);
      expect(result.metadata?.['ruleDecision']).toBe('requireApproval');

      const evaluations = result.metadata?.['evaluations'];
      expect(Array.isArray(evaluations)).toBe(true);
      if (!Array.isArray(evaluations)) throw new Error('evaluations metadata missing for an evaluated action');
      const liveEvaluation = evaluations.find((entry) => isRecord(entry) && entry['activationMode'] === 'live');
      if (!isRecord(liveEvaluation)) throw new Error('live evaluation entry missing');
      expect(liveEvaluation['filePath']).toBe(testCase.expectedNormalizedPath);
      expect(liveEvaluation['decision']).toBe('requireApproval');

      if (testCase.semantic === 'synthetic-target-not-resource') {
        expect(observation.normalizedPath.startsWith('<tool:')).toBe(true);
      }
      if (testCase.semantic === 'opaque-command-not-resource') {
        expect(observation.normalizedPath).toBe(testCase.params['command']);
        expect(String(testCase.params['command'])).toContain(' ');
      }
      if (testCase.semantic === 'attribution-unprovable-first-token' || testCase.semantic === 'multi-target-collapsed-unprovable') {
        expect(observation.paramsSummary['command']).toBe(testCase.params['command']);
      }
      for (const invisibleTarget of testCase.invisibleTargets ?? []) {
        expect(
          observation.normalizedPath,
          `${testCase.semantic}: ${invisibleTarget} remains outside normalizedPath; the visible token is not trustworthy whole-resource attribution`,
        ).not.toContain(invisibleTarget);
      }
    });
  }
});
