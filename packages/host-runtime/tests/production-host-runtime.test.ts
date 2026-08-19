import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  getDefaultPdConfig,
  SqliteActivationStateStore,
  SqliteConnection,
  renderPrinciplesToDirectives,
} from '@principles/core/runtime-v2';
import {
  buildActivePrinciplePromptContext,
  createProductionHostRuntime,
  loadPdConfigForPlugin,
  resolveNearestPdWorkspace,
} from '../src/index.js';
import type { RuleContextV2 } from '@principles/core/runtime-v2';

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-production-'));
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

describe('shared production workspace and config', () => {
  it('resolves the nearest ancestor containing the exact .pd/config.yaml', () => {
    const outer = tempWorkspace();
    const inner = path.join(outer, 'nested', 'project');
    fs.mkdirSync(inner, { recursive: true });

    expect(resolveNearestPdWorkspace(inner)).toEqual({
      ok: true,
      workspaceDir: outer,
      configPath: path.join(outer, '.pd', 'config.yaml'),
      source: 'nearest',
    });
  });

  it('fails loud for relative cwd and missing config with a next action', () => {
    expect(resolveNearestPdWorkspace('relative/path')).toMatchObject({
      ok: false,
      reason: 'cwd_not_absolute',
      nextAction: expect.stringContaining('absolute'),
    });
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-missing-'));
    tempDirs.push(missing);
    expect(resolveNearestPdWorkspace(missing)).toMatchObject({
      ok: false,
      reason: 'config_not_found',
      nextAction: expect.stringContaining('.pd/config.yaml'),
    });
  });

  it('loads explicit rollout flags and reports malformed YAML without coercing to success', () => {
    const workspaceDir = tempWorkspace();
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = false;
    config.features.abstraction_layer_v1.enabled = false;
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
    expect(loadPdConfigForPlugin(workspaceDir)).toMatchObject({
      ok: true,
      source: 'user_config',
      effective: { config: { features: {
        'host.codex': { enabled: false },
        abstraction_layer_v1: { enabled: false },
      } } },
    });

    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), 'features: [unterminated', 'utf8');
    expect(loadPdConfigForPlugin(workspaceDir)).toMatchObject({
      ok: false,
      source: 'malformed',
      errors: [{ reason: expect.stringContaining('YAML parse error'), nextAction: expect.stringContaining('Fix YAML') }],
    });
  });
});

describe('shared production active-principle prompt kernel', () => {
  it('does not create or migrate state when the read-only state database is missing', async () => {
    const workspaceDir = tempWorkspace();
    const before = fs.readdirSync(path.join(workspaceDir, '.pd')).sort();

    const result = await buildActivePrinciplePromptContext({ workspaceDir });

    expect(result.additionalContext).toBe('');
    expect(result.warnings).toContain('activation_db_not_found; nextAction=initialize_workspace_runtime_state');
    expect(fs.readdirSync(path.join(workspaceDir, '.pd')).sort()).toEqual(before);
  });

  it('dispatches through the production runtime and reads a real activation plus artifact', async () => {
    const workspaceDir = tempWorkspace();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('art-shared-prompt', 'principle', 'task-shared-prompt', 'P_SHARED_PROMPT', null, '[]', 'validated', JSON.stringify({
        principleId: 'P_SHARED_PROMPT', text: 'UNIQUE_SHARED_PRODUCTION_PROMPT_TEXT',
      }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: 'act-shared-prompt', idempotencyKey: 'shared-prompt::prompt', artifactId: 'art-shared-prompt',
        channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_SHARED_PROMPT',
        activatedAt: now, deactivatedAt: null,
      });
    } finally {
      connection.close();
    }

    const runtime = createProductionHostRuntime({
      beforeToolCall: async (event) => ({ decision: 'allow', source: event.source }),
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    const result = await runtime.dispatch({
      kind: 'before_prompt_build', context: { workspaceDir, sessionId: 'session-shared-prompt' },
      rawPayload: {}, source: 'test:production-prompt',
    });

    expect(result).toMatchObject({
      decision: 'modify',
      source: 'test:production-prompt',
      additionalContext: expect.stringContaining('UNIQUE_SHARED_PRODUCTION_PROMPT_TEXT'),
    });
    await expect(buildActivePrinciplePromptContext({
      workspaceDir,
      excludePrincipleIds: new Set(['P_SHARED_PROMPT']),
    })).resolves.toMatchObject({
      additionalContext: '',
      principleIds: [],
      excludedPrincipleIds: ['P_SHARED_PROMPT'],
      excludedCount: 1,
      exclusionReason: 'host_principle_overlap',
      allValidatedPrinciplesExcluded: true,
    });
  });

  it('omits invalid artifacts with an observable warning and bounds rendered output', async () => {
    const workspaceDir = tempWorkspace();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('art-invalid-prompt', 'principle', 'task-invalid-prompt', 'P_INVALID_PROMPT', null, '[]', 'validated', '{bad-json', now, now);
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: 'act-invalid-prompt', idempotencyKey: 'invalid-prompt::prompt', artifactId: 'art-invalid-prompt',
        channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://P_INVALID_PROMPT',
        activatedAt: now, deactivatedAt: null,
      });
    } finally {
      connection.close();
    }

    const result = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(result.additionalContext).toBe('');
    expect(result.principleIds).toEqual([]);
    expect(result.warnings.join('\n')).toContain('artifact_content_json_parse_error');
    expect(result.additionalContext.length).toBeLessThanOrEqual(result.budget);
  });

  it('bounds the final escaped directive block to 2000 characters without cutting directive tags', async () => {
    const workspaceDir = tempWorkspace();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      const artifactInsert = connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const store = new SqliteActivationStateStore(connection);
      for (let index = 0; index < 10; index += 1) {
        const artifactId = `art-bounded-${index}`;
        const principleId = `P_BOUNDED_${index}`;
        artifactInsert.run(artifactId, 'principle', `task-bounded-${index}`, principleId, null, '[]', 'validated', JSON.stringify({ principleId, text: `${index}-${'&'.repeat(100)}` }), now, now);
        await store.recordActivation({ activationId: `act-bounded-${index}`, idempotencyKey: `${artifactId}::prompt`, artifactId, channel: 'prompt', action: 'prompt_activate', targetRef: `ledger://${principleId}`, activatedAt: now, deactivatedAt: null });
      }
      expect(await store.deactivateActivation('act-bounded-0', now)).toBe(true);
    } finally {
      connection.close();
    }

    const result = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(result.additionalContext).not.toContain('P_BOUNDED_0"');
    expect(result.budget).toBe(2_000);
    expect(result.additionalContext.length).toBeLessThanOrEqual(2_000);
    expect(result.truncated).toBe(true);
    expect(result.additionalContext.match(/<directive /g)?.length).toBe(result.additionalContext.match(/<\/directive>/g)?.length);
    expect(result.additionalContext.endsWith('Note: These directives do not override safety, security, or core system policy.')).toBe(true);
  });

  it('admits a whole escaped directive that exactly fits the final 2000-character budget', async () => {
    const workspaceDir = tempWorkspace();
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      const principleId = 'P_EXACT_FIT';
      const emptyRendered = renderPrinciplesToDirectives([
        { principleId, text: '', artifactId: 'art-exact-fit', activationId: 'act-exact-fit' },
      ], new Set([principleId]));
      const text = 'x'.repeat(2_000 - emptyRendered.length);
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('art-exact-fit', 'principle', 'task-exact-fit', principleId, null, '[]', 'validated', JSON.stringify({ principleId, text }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'act-exact-fit', idempotencyKey: 'exact-fit::prompt', artifactId: 'art-exact-fit', channel: 'prompt', action: 'prompt_activate', targetRef: `ledger://${principleId}`, activatedAt: now, deactivatedAt: null });
    } finally {
      connection.close();
    }

    const result = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(result.additionalContext).toHaveLength(2_000);
    expect(result.truncated).toBe(false);
    expect(result.principleIds).toEqual(['P_EXACT_FIT']);
  });
});

const SHARED_GATE_REASON = 'HOST_RUNTIME_SHARED_GATE_DENY_523';
const SHARED_GATE_CODE = `
function evaluate(input) {
  if (input.context && input.context.history && input.context.history.status === 'unavailable') {
    return { decision: 'allow', matched: false, reason: 'CONTEXT_V2_UNAVAILABLE_523' };
  }
  if (input.action.normalizedPath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: '${SHARED_GATE_REASON}' };
  }
  return { decision: 'allow', matched: false, reason: 'HOST_RUNTIME_SAFE_ALLOW_523' };
}
var meta = { name: 'shared-gate-523', version: '1', ruleId: 'R_SHARED_GATE_523', coversCondition: 'all' };
`;

async function seedLiveRule(workspaceDir: string, implementationCode: string, requiresContextVersion?: 2, suffix = ''): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const now = new Date().toISOString();
    connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`art-shared-gate${suffix}`, 'rule', `task-shared-gate${suffix}`, 'P_SHARED_GATE_523', `R_SHARED_GATE_523${suffix}`, '[]', 'validated', JSON.stringify({
      principleId: 'P_SHARED_GATE_523', ruleId: 'R_SHARED_GATE_523', implementationCode,
      ...(requiresContextVersion === 2 ? { requiresContextVersion: 2 } : {}),
    }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-shared-gate${suffix}`, idempotencyKey: `shared-gate${suffix}::live`, artifactId: `art-shared-gate${suffix}`,
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', targetRef: `impl://R_SHARED_GATE_523${suffix}`,
      activatedAt: now, deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

function gateEvent(workspaceDir: string, filePath: string) {
  return {
    kind: 'before_tool_call' as const,
    context: { workspaceDir, sessionId: 'session-shared-gate', toolName: 'write_file' },
    rawPayload: { toolInput: { toolName: 'write_file', params: { file_path: filePath, content: 'x' } } },
    source: 'test:production-gate',
  };
}

describe('shared production RuleHost gate kernel', () => {
  it('keeps node:vm execution exclusively inside the bounded child source', () => {
    // fileURLToPath (not import.meta.dirname): dirname needs Node >= 20.11,
    // and ADR-0020 declares Node >= 20 support for the host runtime.
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const runtimeSource = fs.readFileSync(path.join(testDir, '..', 'src', 'rule-implementation-runtime.ts'), 'utf8');
    expect(runtimeSource).not.toMatch(/^import .*node:vm/m);
    // 3 runInContext calls: compile rule, bootstrap the JSON-only call input, invoke evaluate.
    expect(runtimeSource.match(/runInContext/g)).toHaveLength(3);
    expect(runtimeSource.indexOf('const EVALUATION_PROCESS_SOURCE')).toBeLessThan(runtimeSource.indexOf('runInContext'));
    expect(runtimeSource).toContain("spawnSync(process.execPath, ['--max-old-space-size=32'");
  });

  it('rejects an oversized artifact envelope before parsing its small RuleCode', async () => {
    const workspaceDir = tempWorkspace();
    const oversizedEnvelopeCode = `function evaluate() { return { decision: 'block', matched: true, reason: 'OVERSIZED_ENVELOPE_MUST_NOT_RUN_523' }; }`;
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('art-oversized-envelope', 'rule', 'task-oversized-envelope', 'P_ENVELOPE_523', 'R_ENVELOPE_523', '[]', 'validated', JSON.stringify({
        ruleId: 'R_ENVELOPE_523', principleId: 'P_ENVELOPE_523', implementationCode: oversizedEnvelopeCode,
        irrelevant: 'x'.repeat(600_000),
      }), now, now);
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId: 'act-oversized-envelope', idempotencyKey: 'oversized-envelope::live', artifactId: 'art-oversized-envelope',
        channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', targetRef: 'impl://R_ENVELOPE_523', activatedAt: now, deactivatedAt: null,
      });
    } finally { connection.close(); }
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({
      decision: 'allow', warnings: [expect.stringMatching(/artifact_content_budget_exceeded.*nextAction=/)],
      metadata: { evaluatedLiveRules: 0 },
    });
  });

  it.each(['resolve', 'reject'] as const)('clears the provider deadline timer after early %s', async (settlement) => {
    vi.useFakeTimers();
    try {
      const workspaceDir = tempWorkspace();
      const provider = settlement === 'resolve'
        ? () => Promise.resolve(undefined)
        : () => Promise.reject(new Error('EARLY_PROVIDER_REJECT_523'));
      const runtime = createProductionHostRuntime({
        ruleContextProvider: provider,
        afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
      });
      const result = await runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'));
      expect(result.decision).toBe('allow');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('loads a live SQLite RuleCode and uniquely denies unsafe input while allowing the safe control', async () => {
    const workspaceDir = tempWorkspace();
    await seedLiveRule(workspaceDir, SHARED_GATE_CODE);
    const runtime = createProductionHostRuntime({
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });

    await expect(runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({
      decision: 'deny', reason: SHARED_GATE_REASON, source: 'test:production-gate',
      metadata: { ruleId: 'R_SHARED_GATE_523', principleId: 'P_SHARED_GATE_523' },
    });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/safe/project.txt'))).resolves.toMatchObject({
      decision: 'allow', source: 'test:production-gate', metadata: { evaluatedLiveRules: 1 },
    });
  });

  it('fails open observably for malformed implementation output', async () => {
    const workspaceDir = tempWorkspace();
    await seedLiveRule(workspaceDir, `function evaluate() { return { decision: 'block' }; }`);
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });

    await expect(runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({
      decision: 'allow',
      warnings: [expect.stringMatching(/invalid RuleHostResult.*nextAction=/)],
    });
  });

  it('does not create or migrate a missing state database on the hook path', async () => {
    const workspaceDir = tempWorkspace();
    const dbPath = path.join(workspaceDir, '.pd', 'state.db');
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });

    await expect(runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({
      decision: 'allow', warnings: [expect.stringContaining('activation_db_not_found')],
    });
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('injects context v2 through a neutral port and makes provider failure observable', async () => {
    const workspaceDir = tempWorkspace();
    await seedLiveRule(workspaceDir, SHARED_GATE_CODE, 2);
    const availableContext: RuleContextV2 = {
      version: 2,
      history: { status: 'available', truncated: false, calls: [] },
      facts: { priorReadOfTarget: 'no', readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: 0 },
    };
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => availableContext,
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({ decision: 'deny', reason: SHARED_GATE_REASON });

    const degraded = createProductionHostRuntime({
      ruleContextProvider: () => { throw new Error('UNIQUE_CONTEXT_PROVIDER_FAILURE_523'); },
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    await expect(degraded.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({
      decision: 'allow', warnings: [expect.stringContaining('UNIQUE_CONTEXT_PROVIDER_FAILURE_523')],
    });
  });

  it('preserves host-owned session and evolution enrichment through a neutral port', async () => {
    const workspaceDir = tempWorkspace();
    await seedLiveRule(workspaceDir, `
      function evaluate(input) {
        if (input.session.currentGfi === 523 && input.evolution.epTier === 7) {
          return { decision: 'block', matched: true, reason: 'HOST_ENRICHMENT_PARITY_523' };
        }
        return { decision: 'allow', matched: false, reason: 'host enrichment absent' };
      }
    `);
    const runtime = createProductionHostRuntime({
      ruleInputEnrichmentProvider: () => ({ currentGfi: 523, epTier: 7, bashRisk: 'normal' }),
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/safe/project.txt'))).resolves.toMatchObject({
      decision: 'deny', reason: 'HOST_ENRICHMENT_PARITY_523',
    });
  });

  it('returns neutral decision metadata so hosts retain approval UX enrichments', async () => {
    const workspaceDir = tempWorkspace();
    await seedLiveRule(workspaceDir, `function evaluate() { return { decision: 'requireApproval', matched: true, reason: 'HOST_APPROVAL_UX_523' }; }`);
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/safe/project.txt'))).resolves.toMatchObject({
      decision: 'allow', metadata: { ruleDecision: 'requireApproval', evaluatedLiveRules: 1 },
    });
  });

  it.each([
    ['top-level infinite loop', 'while (true) {}', /rule_batch_timeout.*nextAction=/],
    ['invalid source', 'function evaluate( {', /implementation_unhealthy.*nextAction=/],
    ['oversized source', `function evaluate() { return { decision: 'allow', matched: false, reason: '${'x'.repeat(300_000)}' }; }`, /rule_source_budget_exceeded.*nextAction=/],
    ['oversized output', `function evaluate() { return { decision: 'allow', matched: false, reason: 'x'.repeat(100000) }; }`, /rule_batch_output_exceeded.*nextAction=/],
    ['bounded memory', `var x = []; while (true) { x.push('${'x'.repeat(10_000)}' + x.length); }`, /rule_batch_(?:failed|timeout).*nextAction=/],
  ])('fails open observably when child RuleCode hits %s', async (_caseName, code, warning) => {
    const workspaceDir = tempWorkspace();
    await seedLiveRule(workspaceDir, code);
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({
      decision: 'allow', warnings: [expect.stringMatching(warning)],
    });
  });

  it('bounds total multi-rule gate elapsed time independently of active rule count', async () => {
    const workspaceDir = tempWorkspace();
    for (let index = 0; index < 8; index += 1) {
      await seedLiveRule(workspaceDir, `function evaluate() { const until = Date.now() + 800; while (Date.now() < until) {} return { decision: 'allow', matched: false, reason: 'slow-${index}' }; }`, undefined, `-${index}`);
    }
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });
    const started = Date.now();
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'));
    const elapsedMs = Date.now() - started;
    expect(result).toMatchObject({ decision: 'allow', warnings: [expect.stringMatching(/rule_batch_timeout.*nextAction=/)] });
    expect(elapsedMs).toBeLessThan(4_000);
  }, 10_000);

  it('caps active rules before executing unbounded workspace state', async () => {
    const workspaceDir = tempWorkspace();
    for (let index = 0; index < 40; index += 1) await seedLiveRule(workspaceDir, SHARED_GATE_CODE, undefined, `-${index}`);
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'));
    expect(result).toMatchObject({ decision: 'allow', warnings: [expect.stringMatching(/active_rule_limit_exceeded.*nextAction=/)] });
    expect(result.warnings?.length).toBeLessThanOrEqual(16);
  });

  it('caps observable warnings from malformed activation rows', async () => {
    const workspaceDir = tempWorkspace();
    for (let index = 0; index < 20; index += 1) await seedLiveRule(workspaceDir, SHARED_GATE_CODE, undefined, `-warning-${index}`);
    const connection = new SqliteConnection(workspaceDir);
    try { connection.getDb().prepare("UPDATE activations SET target_ref = ''").run(); }
    finally { connection.close(); }
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'));
    expect(result).toMatchObject({ decision: 'allow', warnings: expect.any(Array) });
    expect(result.warnings).toHaveLength(16);
    expect(result.warnings?.every((warning) => warning.length <= 500 && warning.includes('nextAction='))).toBe(true);
  });

  it('skips an invalid rule observably while a healthy sibling still denies', async () => {
    const workspaceDir = tempWorkspace();
    await seedLiveRule(workspaceDir, 'function evaluate( {', undefined, '-invalid');
    await seedLiveRule(workspaceDir, SHARED_GATE_CODE, undefined, '-healthy');
    const runtime = createProductionHostRuntime({ afterToolCall: async (event) => ({ decision: 'observe', source: event.source }) });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'))).resolves.toMatchObject({
      decision: 'deny', reason: SHARED_GATE_REASON,
      warnings: [expect.stringMatching(/implementation_unhealthy.*nextAction=/)],
      metadata: { evaluatedLiveRules: 1 },
    });
  });
});
