import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleEvolutionStatusCommand } from '../../src/commands/evolution-status.js';
import { handlePrincipleRollbackCommand } from '../../src/commands/principle-rollback.js';
import { appendCandidateArtifactLineageRecord } from '../../src/core/nocturnal-artifact-lineage.js';
import { getImplementationAssetRoot } from '../../src/core/code-implementation-storage.js';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import { saveLedger } from '../../src/core/principle-tree-ledger.js';
import { WorkflowFunnelLoader } from '../../src/core/workflow-funnel-loader.js';
import { RuntimeSummaryService } from '../../src/service/runtime-summary-service.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-command-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.state', 'logs'), { recursive: true });
  return dir;
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('evolution commands', () => {
  it('returns evolution status from canonical runtime summary sources', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    
    // Create principle from diagnosis
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check file permissions',
      source: 'write',
    });

    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 85,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'q1', status: 'pending' },
    ]);
    writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
      active: true,
      task: 'fix something',
      timestamp: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'sessions', 's1.json'), {
      sessionId: 's1',
      currentGfi: 45,
      dailyGfiPeak: 78,
      lastActivityAt: 1,
    });
    fs.writeFileSync(
      path.join(workspace, '.state', 'logs', 'events.jsonl'),
      `${JSON.stringify({
        ts: '2026-03-20T10:00:01Z',
        type: 'pain_signal',
        category: 'detected',
        sessionId: 's1',
        data: { source: 'tool_failure', score: 50, reason: 'write failed' },
      })}\n`,
      'utf8'
    );

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
      sessionId: 's1',
    } as any);

    expect(result.text).toContain('Evolution Status');
    expect(result.text).toContain('Session GFI: current 45, peak 78');
    expect(result.text).toContain('Queue: pending 1, in_progress 0, completed 0');
    expect(result.text).toMatch(/Legacy Directive File: (present|missing) \(compatibility-only display artifact\)/);
    expect(result.text).toContain('Note: Legacy directive file is NOT a truth source for Phase 3 eligibility');
    expect(result.text).toContain('Queue is the only authoritative execution truth source');
    expect(result.text).toContain('Active Evolution Task: --');
    expect(result.text).toContain('Phase 3 Legacy Directive File: compatibility-only (queue is only truth source)');
    expect(result.text).toContain('Phase 3: ready');
    expect(result.text).toContain('queueTruthReady');
    expect(result.text).toContain('probation principles: 1');
    expect(result.text).toContain('internalization routes: --');
    expect(result.text).not.toContain('.state/principles');
  });

  it('returns localized evolution status summary in zh', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    
    // Create principle from diagnosis
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-zh',
      painType: 'tool_failure',
      triggerPattern: '文件写入操作失败',
      action: '检查文件权限',
      source: 'write',
    });

    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 59,
      last_updated: '2026-03-20T10:00:00Z',
    });

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'zh-CN' },
    } as any);

    expect(result.text).toContain('进化状态');
    expect(result.text).toContain('观察期原则: 1');
  });

  it('rolls back principle through command', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    
    // Create principle from diagnosis
    const principleId = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check file permissions',
      source: 'write',
    });

    const pid = reducer.getProbationPrinciples()[0].id;
    const result = handlePrincipleRollbackCommand({
      args: `${pid} test rollback`,
      config: { workspaceDir: workspace, language: 'en' },
    } as any);

    expect(result.text).toContain(`Rolled back principle ${pid}`);

    const updated = new EvolutionReducerImpl({ workspaceDir: workspace }).getPrincipleById(pid);
    expect(updated?.status).toBe('deprecated');
  });

  it('handles stale directive correctly in production scenario', () => {
    // Production evidence: evolution_directive.json stopped updating on 2026-03-22
    // Phase 3 eligibility should work based on queue and trust alone
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Create principle from diagnosis
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write operation fails',
      action: 'check file permissions',
      source: 'write',
    });

    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 85,
      frozen: true,
      last_updated: '2026-03-20T10:00:00Z',
    });

    // Valid queue with completed tasks
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'task-1', status: 'completed', completed_at: '2026-03-25T10:00:00.000Z', score: 50 },
      { id: 'task-2', status: 'completed', completed_at: '2026-03-25T11:00:00.000Z', score: 60 }
    ]);

    // Stale directive file (production scenario - stopped updating on 2026-03-22)
    writeJson(path.join(workspace, '.state', 'evolution_directive.json'), {
      active: true,
      task: 'old directive task',
      timestamp: '2026-03-22T00:00:00Z', // Stale
    });

    writeJson(path.join(workspace, '.state', 'sessions', 's1.json'), {
      sessionId: 's1',
      currentGfi: 45,
      dailyGfiPeak: 78,
      lastActivityAt: 1,
    });

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
      sessionId: 's1',
    } as any);

    // Verify Phase 3 eligibility based on queue only, not directive
    expect(result.text).toContain('Phase 3: ready yes');
    expect(result.text).toContain('queueTruthReady yes');
    expect(result.text).toContain('eligible 2');

    // Verify directive is labeled as compatibility-only
    expect(result.text).toMatch(/Legacy Directive File: (present|missing) \(compatibility-only display artifact\)/);
    expect(result.text).toContain('Note: Legacy directive file is NOT a truth source for Phase 3 eligibility');
    expect(result.text).toContain('Queue is the only authoritative execution truth source');

    // Verify directive status does not affect eligibility
    expect(result.text).toContain('Phase 3 Legacy Directive File: compatibility-only (queue is only truth source)');
  });

  it('surfaces reference-only outcomes separately from rejected outcomes', () => {
    const workspace = makeTempDir();
    writeJson(path.join(workspace, '.state', 'AGENT_SCORECARD.json'), {
      trust_score: 85,
      frozen: true,
      last_updated: '2026-03-20T10:00:00Z',
    });
    writeJson(path.join(workspace, '.state', 'evolution_queue.json'), [
      { id: 'timeout-1', status: 'completed', resolution: 'auto_completed_timeout', completed_at: '2026-03-25T10:00:00.000Z' },
    ]);

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
    } as any);

    expect(result.text).toContain('reference_only 1');
    expect(result.text).toContain('timeout_only');
  });

  it('includes internalization route recommendations when principle lifecycle evidence exists', () => {
    const workspace = makeTempDir();
    const stateDir = path.join(workspace, '.state');

    saveLedger(stateDir, {
      trainingStore: {
        'P-001': {
          principleId: 'P-001',
          evaluability: 'weak_heuristic',
          applicableOpportunityCount: 5,
          observedViolationCount: 2,
          complianceRate: 0.6,
          violationTrend: -0.2,
          generatedSampleCount: 0,
          approvedSampleCount: 0,
          includedTrainRunIds: [],
          deployedCheckpointIds: [],
          internalizationStatus: 'internalized',
        },
      },
      tree: {
        principles: {
          'P-001': {
            id: 'P-001',
            version: 1,
            text: 'Prefer cheap safe internalization',
            triggerPattern: 'write',
            action: 'prefer the cheapest viable fix',
            status: 'active',
            priority: 'P1',
            scope: 'general',
            evaluability: 'weak_heuristic',
            valueScore: 0,
            adherenceRate: 0,
            painPreventedCount: 0,
            derivedFromPainIds: [],
            ruleIds: ['R-001'],
            conflictsWithPrincipleIds: [],
            createdAt: '2026-04-08T00:00:00.000Z',
            updatedAt: '2026-04-08T00:00:00.000Z',
          },
        },
        rules: {
          'R-001': {
            id: 'R-001',
            version: 1,
            name: 'Coach cautious writes',
            description: 'Encourage safer writes before escalating to hard boundaries.',
            type: 'skill',
            triggerCondition: 'tool=write',
            enforcement: 'warn',
            action: 'warn before risky write',
            principleId: 'P-001',
            status: 'implemented',
            coverageRate: 0,
            falsePositiveRate: 0,
            implementationIds: ['IMPL-001'],
            createdAt: '2026-04-08T00:00:00.000Z',
            updatedAt: '2026-04-08T00:00:00.000Z',
          },
        },
        implementations: {
          'IMPL-001': {
            id: 'IMPL-001',
            ruleId: 'R-001',
            type: 'code',
            path: 'implementations/IMPL-001/entry.js',
            version: 'v1',
            coversCondition: 'risky write',
            coveragePercentage: 60,
            lifecycleState: 'candidate',
            createdAt: '2026-04-08T00:00:00.000Z',
            updatedAt: '2026-04-08T00:00:00.000Z',
          },
        },
        metrics: {},
        lastUpdated: '2026-04-08T00:00:00.000Z',
      },
    });

    const replayDir = path.join(getImplementationAssetRoot(stateDir, 'IMPL-001'), 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    writeJson(path.join(replayDir, '2026-04-08T00-00-00-000Z.json'), {
      implementationId: 'IMPL-001',
      generatedAt: '2026-04-08T00:00:00.000Z',
      overallDecision: 'needs-review',
      blockers: [],
      sampleFingerprints: ['sample-1', 'sample-2', 'sample-3'],
      replayResults: {
        painNegative: { total: 2, passed: 2, failed: 0, details: [] },
        successPositive: { total: 2, passed: 1, failed: 1, details: [] },
        principleAnchor: { total: 1, passed: 1, failed: 0, details: [] },
      },
    });

    appendCandidateArtifactLineageRecord(workspace, {
      artifactId: 'artifact-1',
      principleId: 'P-001',
      ruleId: 'R-001',
      sessionId: 'session-1',
      sourceSnapshotRef: 'snapshot-1',
      sourcePainIds: ['pain-1'],
      sourceGateBlockIds: ['gate-1'],
      storagePath: getImplementationAssetRoot(stateDir, 'IMPL-001'),
      implementationId: 'IMPL-001',
      createdAt: '2026-04-08T00:00:00.000Z',
    });

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
    } as any);

    expect(result.text).toContain('internalization routes: P-001:skill@');
  });

  it('renders workflowFunnel blocks when YAML-driven funnels are present', () => {
    const workspace = makeTempDir();
    const stateDir = path.join(workspace, '.state');

    // Write workflows.yaml with two funnels matching actual schema
    const workflowsYaml = `
version: "1.0"
funnels:
  - workflowId: nocturnal
    stages:
      - name: dreamer_completed
        eventType: nocturnal_dreamer_completed
        eventCategory: completed
        statsField: evolution.nocturnalDreamerCompleted
      - name: artifact_persisted
        eventType: nocturnal_artifact_persisted
        eventCategory: completed
        statsField: evolution.nocturnalArtifactPersisted
  - workflowId: rulehost
    stages:
      - name: evaluated
        eventType: rulehost_evaluated
        eventCategory: evaluated
        statsField: evolution.rulehostEvaluated
`;
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), workflowsYaml, 'utf8');

    // Write daily stats with matching event counts (must be in logs/ subdirectory)
    const today = new Date().toISOString().slice(0, 10);
    writeJson(path.join(stateDir, 'logs', 'daily-stats.json'), {
      [today]: {
        evolution: {
          nocturnalDreamerCompleted: 3,
          nocturnalArtifactPersisted: 2,
          rulehostEvaluated: 15,
        },
      },
    });

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
    } as any);

    expect(result.text).toContain('Workflow Funnel: nocturnal');
    expect(result.text).toMatch(/dreamer_completed: 3/);
    expect(result.text).toMatch(/artifact_persisted: 2/);
    expect(result.text).toContain('Workflow Funnel: rulehost');
    expect(result.text).toMatch(/evaluated: 15/);
  });

  it('skips funnel block when workflowFunnels is empty array', () => {
    const workspace = makeTempDir();

    // Write empty funnels array — valid YAML but no funnels defined
    const workflowsYaml = `version: "1.0"\nfunnels: []`;
    fs.writeFileSync(path.join(workspace, '.state', 'workflows.yaml'), workflowsYaml, 'utf8');

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
    } as any);

    expect(result.text).not.toContain('Workflow Funnel:');
  });

  it('shows degraded status and warning when YAML load has warnings', () => {
    const workspace = makeTempDir();
    const stateDir = path.join(workspace, '.state');

    // Write malformed YAML — loader emits a parse warning
    const badYaml = `
version: "1.0"
funnels:
  - workflowId: nocturnal
    stages:
      - name: "unclosed string
`;
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), badYaml, 'utf8');

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'en' },
    } as any);

    // Should still render — degraded but not crashed
    expect(result.text).toContain('Evolution Status');
    // Loader warning should appear in output
    expect(result.text).toMatch(/YAML load warning|YAML parse error|workflows\.yaml/);
  });

  it('renders Chinese workflow funnel labels from YAML', () => {
    const workspace = makeTempDir();
    const stateDir = path.join(workspace, '.state');

    const workflowsYaml = `
version: "1.0"
funnels:
  - workflowId: nocturnal
    stages:
      - name: 做梦完成
        eventType: nocturnal_dreamer_completed
        eventCategory: completed
        statsField: evolution.nocturnalDreamerCompleted
`;
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), workflowsYaml, 'utf8');

    const today = new Date().toISOString().slice(0, 10);
    writeJson(path.join(stateDir, 'logs', 'daily-stats.json'), {
      [today]: {
        evolution: { nocturnalDreamerCompleted: 7 },
      },
    });

    const result = handleEvolutionStatusCommand({
      config: { workspaceDir: workspace, language: 'zh' },
    } as any);

    expect(result.text).toContain('Workflow 漏斗: nocturnal');
    expect(result.text).toMatch(/做梦完成: 7/);
  });
});

describe('YAML funnel E2E integration tests', () => {
  // TEST-01: Full YAML-driven flow with real WorkflowFunnelLoader
  it('e2e_test_full_yaml_driven_flow', () => {
    const workspace = makeTempDir();
    const stateDir = path.join(workspace, '.state');

    // Create real WorkflowFunnelLoader (not mocked)
    const loader = new WorkflowFunnelLoader(stateDir);
    loader.watch();

    // Write valid workflows.yaml
    const workflowsYaml = `
version: "1.0"
funnels:
  - workflowId: nocturnal
    stages:
      - name: dreamer_completed
        eventType: nocturnal_dreamer_completed
        eventCategory: completed
        statsField: evolution.nocturnalDreamerCompleted
      - name: artifact_persisted
        eventType: nocturnal_artifact_persisted
        eventCategory: completed
        statsField: evolution.nocturnalArtifactPersisted
  - workflowId: rulehost
    stages:
      - name: evaluated
        eventType: rulehost_evaluated
        eventCategory: evaluated
        statsField: evolution.rulehostEvaluated
`;
    fs.writeFileSync(path.join(stateDir, 'workflows.yaml'), workflowsYaml, 'utf8');
    loader.load(); // reload after writing file

    // Write daily-stats.json
    const today = new Date().toISOString().slice(0, 10);
    writeJson(path.join(stateDir, 'logs', 'daily-stats.json'), {
      [today]: {
        evolution: {
          nocturnalDreamerCompleted: 3,
          nocturnalArtifactPersisted: 2,
          rulehostEvaluated: 15,
        },
      },
    });

    // Call getSummary directly with real loader data
    const summary = RuntimeSummaryService.getSummary(workspace, {
      funnels: loader.getAllFunnels(),
      loaderWarnings: loader.getWarnings(),
    });

    // Assert workflowFunnels structure
    expect(summary.workflowFunnels).toBeDefined();
    expect(summary.workflowFunnels!.length).toBe(2);
    expect(summary.workflowFunnels![0].funnelKey).toBe('nocturnal');
    expect(summary.workflowFunnels![0].stages[0].label).toBe('dreamer_completed');
    expect(summary.workflowFunnels![0].stages[0].count).toBe(3);
    expect(summary.workflowFunnels![0].stages[1].label).toBe('artifact_persisted');
    expect(summary.workflowFunnels![0].stages[1].count).toBe(2);
    expect(summary.workflowFunnels![1].funnelKey).toBe('rulehost');
    expect(summary.workflowFunnels![1].stages[0].label).toBe('evaluated');
    expect(summary.workflowFunnels![1].stages[0].count).toBe(15);
    expect(summary.workflowFunnels![0].funnelLabel).toBe('nocturnal');

    // DEGRADED-01: valid YAML + valid stats → status ok, no funnel-related warnings
    expect(summary.metadata.status).toBe('ok');
    // Note: warnings array may contain non-funnel warnings (GFI/Daily stats defaults); funnel warnings are checked separately
    const funnelWarnings = summary.metadata.warnings.filter(w => w.includes('statsField') || w.includes('YAML load'));
    expect(funnelWarnings).toHaveLength(0);

    loader.dispose();
  });

  // TEST-02: Degraded fallback when YAML is missing
  it('e2e_test_degraded_fallback_on_missing_yaml', () => {
    const workspace = makeTempDir();
    const stateDir = path.join(workspace, '.state');

    // Create real loader pointing at stateDir with NO workflows.yaml
    const loader = new WorkflowFunnelLoader(stateDir);
    loader.watch();

    // Write daily-stats.json (so the file exists, but no YAML)
    const today = new Date().toISOString().slice(0, 10);
    writeJson(path.join(stateDir, 'logs', 'daily-stats.json'), {
      [today]: { evolution: {} },
    });

    // Call getSummary — should not crash
    const summary = RuntimeSummaryService.getSummary(workspace, {
      funnels: loader.getAllFunnels(),
      loaderWarnings: loader.getWarnings(),
    });

    // Assert degraded status
    expect(summary.metadata.status).toBe('degraded');
    // loaderWarnings are prefixed with "YAML load warning: " when propagated to metadata.warnings
    expect(summary.metadata.warnings).toContain('YAML load warning: workflows.yaml file not found.');
    // DEGRADED-02: funnels absent/empty when YAML missing — empty array is acceptable, just not rendered
    expect(summary.workflowFunnels == null || summary.workflowFunnels.length === 0).toBe(true);

    loader.dispose();
  });

  // TEST-03: Hot-reload — YAML changes reflected after loader.load()
  it('e2e_test_hot_reload_reflects_yaml_changes', () => {
    const workspace = makeTempDir();
    const stateDir = path.join(workspace, '.state');

    const loader = new WorkflowFunnelLoader(stateDir);
    loader.watch();

    // Write initial workflows.yaml with original_label
    const workflowsYamlV1 = `
version: "1.0"
funnels:
  - workflowId: nocturnal
    stages:
      - name: original_label
        eventType: nocturnal_dreamer_completed
        eventCategory: completed
        statsField: evolution.nocturnalDreamerCompleted
`;
    const yamlPath = path.join(stateDir, 'workflows.yaml');
    fs.writeFileSync(yamlPath, workflowsYamlV1, 'utf8');
    loader.load();

    const today = new Date().toISOString().slice(0, 10);
    writeJson(path.join(stateDir, 'logs', 'daily-stats.json'), {
      [today]: { evolution: { nocturnalDreamerCompleted: 5 } },
    });

    // First call — should show original_label
    const summary1 = RuntimeSummaryService.getSummary(workspace, {
      funnels: loader.getAllFunnels(),
      loaderWarnings: loader.getWarnings(),
    });
    expect(summary1.workflowFunnels![0].stages[0].label).toBe('original_label');
    expect(summary1.workflowFunnels![0].stages[0].count).toBe(5);

    // Modify workflows.yaml to use modified_label
    const workflowsYamlV2 = `
version: "1.0"
funnels:
  - workflowId: nocturnal
    stages:
      - name: modified_label
        eventType: nocturnal_dreamer_completed
        eventCategory: completed
        statsField: evolution.nocturnalDreamerCompleted
`;
    fs.writeFileSync(yamlPath, workflowsYamlV2, 'utf8');
    loader.load(); // trigger hot-reload manually

    // Second call — should show modified_label
    const summary2 = RuntimeSummaryService.getSummary(workspace, {
      funnels: loader.getAllFunnels(),
      loaderWarnings: loader.getWarnings(),
    });
    expect(summary2.workflowFunnels![0].stages[0].label).toBe('modified_label');
    expect(summary2.workflowFunnels![0].stages[0].count).toBe(5);

    loader.dispose();
  });
});
