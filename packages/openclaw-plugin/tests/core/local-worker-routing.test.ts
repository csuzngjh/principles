/**
 * Local Worker Routing Policy — Tests
 * ====================================
 *
 * Tests for task classification and routing decision logic.
 *
 * Test organization:
 *   - Without deployment: classification-only tests (reader_eligible, editor_eligible, high_entropy, risk, ambiguous)
 *   - With deployment enabled: full route_local decision
 *   - With deployment disabled: stay_main with deployment_unavailable
 *   - Helper functions: canRouteToProfile, isAnyLocalRoutingEnabled, listEnabledProfiles
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  classifyTask,
  canRouteToProfile,
  isAnyLocalRoutingEnabled,
  listEnabledProfiles,
  type RoutingInput,
  type RoutingDecision,
} from '../../src/core/local-worker-routing.js';
import {
  registerTrainingRun,
  startTrainingRun,
  completeTrainingRun,
  registerCheckpoint,
  attachEvalSummary,
  markCheckpointDeployable,
} from '../../src/core/model-training-registry.js';
import {
  advancePromotion,
  DEFAULT_BASELINE_METRICS,
} from '../../src/core/promotion-gate.js';
import {
  bindCheckpointToWorkerProfile,
  enableRoutingForProfile,
  disableRoutingForProfile,
} from '../../src/core/model-deployment-registry.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-routing-test-'));
}

function rmdir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
}

/** Set up a fully deployable reader-family checkpoint and bind to local-reader */
function setupReaderDeployment(tmpDir: string, routingEnabled = false): string {
  const run = registerTrainingRun(tmpDir, {
    targetModelFamily: 'claude-reader-latest',
    datasetFingerprint: 'sha256-rdr',
    exportId: 'export-rdr',
    sampleCount: 10,
    configFingerprint: 'cfg-v1',
  });
  const ck = registerCheckpoint(tmpDir, {
    trainRunId: run.trainRunId,
    targetModelFamily: 'claude-reader-latest',
    artifactPath: '/ck/reader.safetensors',
  });
  attachEvalSummary(tmpDir, ck.checkpointId, {
    evalId: 'eval-rdr',
    checkpointId: ck.checkpointId,
    targetModelFamily: 'claude-reader-latest',
    benchmarkId: 'bench',
    mode: 'reduced_prompt',
    baselineScore: 0.5,
    candidateScore: 0.65,
    delta: 0.15,
    verdict: 'pass',
  });
  startTrainingRun(tmpDir, run.trainRunId);
  completeTrainingRun(tmpDir, run.trainRunId);
  markCheckpointDeployable(tmpDir, ck.checkpointId, true);
  advancePromotion(tmpDir, {
    checkpointId: ck.checkpointId,
    targetProfile: 'local-reader',
    baselineMetrics: DEFAULT_BASELINE_METRICS,
    orchestratorReviewPassed: true,
    reviewNote: 'Test approval',
  });
  bindCheckpointToWorkerProfile(tmpDir, 'local-reader', ck.checkpointId, 'reader deployment');
  if (routingEnabled) {
    enableRoutingForProfile(tmpDir, 'local-reader');
  }
  return ck.checkpointId;
}

/** Set up a fully deployable editor-family checkpoint and bind to local-editor */
function setupEditorDeployment(tmpDir: string, routingEnabled = false): string {
  const run = registerTrainingRun(tmpDir, {
    targetModelFamily: 'gpt-editor-v4',
    datasetFingerprint: 'sha256-edt',
    exportId: 'export-edt',
    sampleCount: 10,
    configFingerprint: 'cfg-v1',
  });
  const ck = registerCheckpoint(tmpDir, {
    trainRunId: run.trainRunId,
    targetModelFamily: 'gpt-editor-v4',
    artifactPath: '/ck/editor.safetensors',
  });
  attachEvalSummary(tmpDir, ck.checkpointId, {
    evalId: 'eval-edt',
    checkpointId: ck.checkpointId,
    targetModelFamily: 'gpt-editor-v4',
    benchmarkId: 'bench',
    mode: 'reduced_prompt',
    baselineScore: 0.5,
    candidateScore: 0.7,
    delta: 0.2,
    verdict: 'pass',
  });
  startTrainingRun(tmpDir, run.trainRunId);
  completeTrainingRun(tmpDir, run.trainRunId);
  markCheckpointDeployable(tmpDir, ck.checkpointId, true);
  advancePromotion(tmpDir, {
    checkpointId: ck.checkpointId,
    targetProfile: 'local-editor',
    baselineMetrics: DEFAULT_BASELINE_METRICS,
    orchestratorReviewPassed: true,
    reviewNote: 'Test approval',
  });
  bindCheckpointToWorkerProfile(tmpDir, 'local-editor', ck.checkpointId, 'editor deployment');
  if (routingEnabled) {
    enableRoutingForProfile(tmpDir, 'local-editor');
  }
  return ck.checkpointId;
}

describe('LocalWorkerRouting reader_eligible classification', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('classifies "read_file" taskIntent as reader_eligible', () => {
    const decision = classifyTask({ taskIntent: 'read_file', taskDescription: 'Read the config file' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable'); // eligible but no deployment
    expect(decision.decision).toBe('stay_main'); // No deployment
    expect(decision.deploymentCheck.performed).toBe(true);
    expect(decision.deploymentCheck.routingEnabled).toBe(false);
  });

  it('classifies "grep" taskIntent as reader_eligible', () => {
    const decision = classifyTask({ taskIntent: 'grep', taskDescription: 'Find all occurrences of foo in src/' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
  });

  it('classifies "summarize" taskIntent as reader_eligible', () => {
    const decision = classifyTask({ taskIntent: 'summarize', taskDescription: 'Summarize the changelog' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
  });

  it('classifies "inspect" keyword in description as reader_eligible', () => {
    const decision = classifyTask({ taskIntent: 'read', taskDescription: 'inspect the package.json for dependencies' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
  });

  it('classifies with only taskIntent (no description) as reader_eligible', () => {
    const decision = classifyTask({ taskIntent: 'grep' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Tests: Editor-Eligible Classification (no deployment)
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting editor_eligible classification', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('classifies "edit" taskIntent as editor_eligible', () => {
    const decision = classifyTask({ taskIntent: 'edit_file', taskDescription: 'Edit the config to add new key' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable'); // eligible but no deployment
    expect(decision.decision).toBe('stay_main'); // No deployment
  });

  it('classifies "fix" taskIntent as editor_eligible', () => {
    const decision = classifyTask({ taskIntent: 'fix', taskDescription: 'Fix the typo in README.md' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
  });

  it('classifies "replace" keyword in description as editor_eligible', () => {
    const decision = classifyTask({ taskIntent: 'replace', taskDescription: 'Replace all old API calls with new ones' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
  });

  it('classifies "add" keyword as editor_eligible', () => {
    const decision = classifyTask({ taskIntent: 'add', taskDescription: 'add logging to the function' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Tests: High-Entropy Rejection
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting high_entropy_disallowed', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('rejects "design" taskIntent as high_entropy', () => {
    const decision = classifyTask({ taskIntent: 'design_system', taskDescription: 'Design the new architecture' }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
    expect(decision.decision).toBe('stay_main');
    expect(decision.blockers.length).toBeGreaterThan(0);
  });

  it('rejects "plan" keyword as high_entropy', () => {
    const decision = classifyTask({ taskIntent: 'plan', taskDescription: 'Plan the refactoring approach' }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('rejects "architect" keyword as high_entropy', () => {
    const decision = classifyTask({ taskIntent: 'architect', taskDescription: 'Architect the microservices layout' }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('rejects "research" keyword as high_entropy', () => {
    const decision = classifyTask({ taskIntent: 'research', taskDescription: 'Research the best approach for this problem' }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('rejects "investigate" keyword as high_entropy', () => {
    const decision = classifyTask({ taskIntent: 'investigate', taskDescription: 'Investigate the memory leak' }, tmpDir);
    // Note: "investigate" is high entropy but "fix" is editor-eligible
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('rejects complexity hint "multi_step" as high_entropy', () => {
    const decision = classifyTask({
      taskIntent: 'fix',
      taskDescription: 'Fix the bug',
      complexityHints: ['multi_step', 'cross_file'],
    }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('rejects "ambiguous" complexity hint as high_entropy', () => {
    const decision = classifyTask({
      taskIntent: 'fix',
      taskDescription: 'Improve the code',
      complexityHints: ['ambiguous'],
    }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('high_entropy blocks even with editor-eligible keywords', () => {
    // "design" + "edit" → high_entropy wins
    const decision = classifyTask({
      taskIntent: 'edit',
      taskDescription: 'design and edit the new module',
    }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('rejects large-scale multi-file editing (4+ files) as high_entropy', () => {
    // Bounded scope: 1-3 files → editor_eligible
    // Too broad: 4+ files → high_entropy_disallowed (requires main agent coordination)
    const decision = classifyTask({
      taskIntent: 'edit',
      taskDescription: 'Fix the bug across multiple modules',
      requestedFiles: [
        'src/auth/login.ts',
        'src/auth/session.ts',
        'src/auth/middleware.ts',
        'src/auth/guards.ts',
      ],
    }, tmpDir);
    expect(decision.classification).toBe('high_entropy_disallowed');
    expect(decision.blockers[0]).toContain('large-scale multi-file edit');
    expect(decision.decision).toBe('stay_main');
  });

  it('allows bounded multi-file editing (1-3 files) as editor_eligible', () => {
    const decision = classifyTask({
      taskIntent: 'edit',
      taskDescription: 'Fix the bug in auth files',
      requestedFiles: [
        'src/auth/login.ts',
        'src/auth/session.ts',
      ],
    }, tmpDir);
    // Raw classification is editor_eligible; no deployment → final is deployment_unavailable
    expect(decision.classification).toBe('deployment_unavailable');
    expect(decision.decision).toBe('stay_main'); // no deployment
  });
});

// ---------------------------------------------------------------------------
// Tests: Risk Disallowed
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting risk_disallowed', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('rejects bash tool as risk', () => {
    const decision = classifyTask({
      taskIntent: 'run',
      taskDescription: 'Execute a bash command',
      requestedTools: ['bash'],
    }, tmpDir);
    expect(decision.classification).toBe('risk_disallowed');
    expect(decision.decision).toBe('stay_main');
    expect(decision.blockers).toContain('risk tool requested (bash/exec/sudo/DROP/DELETE)');
  });

  it('rejects rm/destroy tools as risk', () => {
    const decision = classifyTask({
      taskIntent: 'process',
      requestedTools: ['rm', 'delete'],
      riskSignals: ['destructive'],
    }, tmpDir);
    expect(decision.classification).toBe('risk_disallowed');
  });

  it('rejects production file as risk', () => {
    const decision = classifyTask({
      taskIntent: 'edit',
      requestedFiles: ['production-config.yaml', '.env'],
    }, tmpDir);
    expect(decision.classification).toBe('risk_disallowed');
    expect(decision.blockers).toContain('risk file pattern detected (production/secrets/.git/node_modules)');
  });

  it('rejects .git/config as risk file', () => {
    const decision = classifyTask({
      taskIntent: 'edit',
      requestedFiles: ['.git/config'],
    }, tmpDir);
    expect(decision.classification).toBe('risk_disallowed');
  });

  it('rejects explicit riskSignals as risk', () => {
    const decision = classifyTask({
      taskIntent: 'edit',
      riskSignals: ['destructive', 'irreversible'],
    }, tmpDir);
    expect(decision.classification).toBe('risk_disallowed');
    expect(decision.blockers).toContain('risk tool requested (bash/exec/sudo/DROP/DELETE)');
  });

  it('risk blocks even reader-eligible tasks', () => {
    // bash + read → risk wins
    const decision = classifyTask({
      taskIntent: 'grep',
      taskDescription: 'Search for pattern in files',
      requestedTools: ['bash'],
    }, tmpDir);
    expect(decision.classification).toBe('risk_disallowed');
  });

  it('rejects node_modules as risk file', () => {
    const decision = classifyTask({
      taskIntent: 'edit',
      requestedFiles: ['node_modules/some/package.json'],
    }, tmpDir);
    expect(decision.classification).toBe('risk_disallowed');
  });
});

// ---------------------------------------------------------------------------
// Tests: Ambiguous Scope
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting ambiguous_scope', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('rejects very short generic taskDescription as ambiguous', () => {
    const decision = classifyTask({ taskIntent: 'process', taskDescription: 'fix it' }, tmpDir);
    expect(decision.classification).toBe('ambiguous_scope');
  });

  it('rejects "todo" as ambiguous', () => {
    const decision = classifyTask({ taskIntent: 'todo', taskDescription: 'todo' }, tmpDir);
    expect(decision.classification).toBe('ambiguous_scope');
  });

  it('rejects "improve" as ambiguous', () => {
    const decision = classifyTask({ taskIntent: 'improve', taskDescription: 'improve' }, tmpDir);
    expect(decision.classification).toBe('ambiguous_scope');
  });

  it('rejects open-ended question words as ambiguous', () => {
    const decision = classifyTask({
      taskIntent: 'analyze',
      taskDescription: 'Should we refactor this or rewrite it?',
    }, tmpDir);
    expect(decision.classification).toBe('ambiguous_scope');
    expect(decision.blockers).toContain('open-ended question words detected');
  });

  it('rejects when no intent and no description', () => {
    const decision = classifyTask({}, tmpDir);
    expect(decision.classification).toBe('ambiguous_scope');
  });

  it('does NOT classify a detailed description as ambiguous', () => {
    const decision = classifyTask({
      taskIntent: 'fix',
      taskDescription: 'Fix the null pointer exception thrown when parsing the config file in parseConfig()',
    }, tmpDir);
    // Task is editor_eligible (fix keyword in intent and description)
    // No deployment exists, so final classification is deployment_unavailable
    expect(decision.classification).toBe('deployment_unavailable');
    expect(decision.decision).toBe('stay_main'); // no deployment exists
  });

  it('DEBUG: detailed fix description classification', () => {
    const decision = classifyTask({
      taskIntent: 'fix',
      taskDescription: 'Fix the null pointer exception thrown when parsing the config file in parseConfig()',
    }, tmpDir);
    // Same as above — editor_eligible but no deployment → deployment_unavailable
    expect(decision.classification).toBe('deployment_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Tests: Deployment Availability (no deployment at all)
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting deployment_unavailable', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('returns deployment_unavailable when no deployment exists', () => {
    const decision = classifyTask({ taskIntent: 'read_file', taskDescription: 'read the config' }, tmpDir);
    expect(decision.classification).toBe('deployment_unavailable');
    expect(decision.decision).toBe('stay_main');
    expect(decision.deploymentCheck.performed).toBe(true);
    expect(decision.deploymentCheck.routingEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Routing with Enabled Deployment
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting with enabled deployment', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('reader task routes to local-reader when deployment is enabled', () => {
    setupReaderDeployment(tmpDir, true);

    const decision = classifyTask({ taskIntent: 'read_file', taskDescription: 'read the config' }, tmpDir);

    expect(decision.decision).toBe('route_local');
    expect(decision.targetProfile).toBe('local-reader');
    expect(decision.classification).toBe('reader_eligible');
    expect(decision.deploymentCheck.routingEnabled).toBe(true);
    expect(decision.blockers).toHaveLength(0);
  });

  it('editor task routes to local-editor when deployment is enabled', () => {
    setupEditorDeployment(tmpDir, true);

    const decision = classifyTask({ taskIntent: 'edit', taskDescription: 'edit the config' }, tmpDir);

    expect(decision.decision).toBe('route_local');
    expect(decision.targetProfile).toBe('local-editor');
    expect(decision.classification).toBe('editor_eligible');
    expect(decision.blockers).toHaveLength(0);
  });

  it('reader task still blocked as high_entropy even with enabled deployment', () => {
    setupReaderDeployment(tmpDir, true);

    const decision = classifyTask({
      taskIntent: 'design',
      taskDescription: 'Design the new system architecture',
    }, tmpDir);

    expect(decision.decision).toBe('stay_main');
    expect(decision.classification).toBe('high_entropy_disallowed');
  });

  it('reader task blocked as risk even with enabled deployment', () => {
    setupReaderDeployment(tmpDir, true);

    const decision = classifyTask({
      taskIntent: 'grep',
      requestedTools: ['bash'],
    }, tmpDir);

    expect(decision.decision).toBe('stay_main');
    expect(decision.classification).toBe('risk_disallowed');
  });
});

// ---------------------------------------------------------------------------
// Tests: Routing with Disabled Deployment
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting with disabled deployment (routing=false)', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('reader-eligible task stays_main when routing is disabled', () => {
    setupReaderDeployment(tmpDir, false); // routingEnabled = false

    const decision = classifyTask({ taskIntent: 'read_file', taskDescription: 'read the config' }, tmpDir);

    expect(decision.decision).toBe('stay_main');
    expect(decision.classification).toBe('deployment_unavailable');
    expect(decision.deploymentCheck.routingEnabled).toBe(false);
    expect(decision.reason).toContain('routing is not enabled');
  });

  it('editor-eligible task stays_main when routing is disabled', () => {
    setupEditorDeployment(tmpDir, false);

    const decision = classifyTask({ taskIntent: 'edit', taskDescription: 'edit the file' }, tmpDir);

    expect(decision.decision).toBe('stay_main');
    expect(decision.classification).toBe('deployment_unavailable');
  });

  it('re-enabling routing allows route_local again', () => {
    setupReaderDeployment(tmpDir, false);
    enableRoutingForProfile(tmpDir, 'local-reader');

    const decision = classifyTask({ taskIntent: 'read_file' }, tmpDir);
    expect(decision.decision).toBe('route_local');
    expect(decision.targetProfile).toBe('local-reader');
  });

  it('stays_main when active checkpoint has been revoked (no longer deployable)', () => {
    // Set up deployment with routing enabled
    const ckId = setupReaderDeployment(tmpDir, true);

    // Verify it routes successfully first
    const before = classifyTask({ taskIntent: 'read_file' }, tmpDir);
    expect(before.decision).toBe('route_local');

    // Revoke the checkpoint — it no longer passes evaluation
    markCheckpointDeployable(tmpDir, ckId, false);

    // Routing must now be blocked — governance: revoked checkpoints must not be used
    const after = classifyTask({ taskIntent: 'read_file' }, tmpDir);
    expect(after.decision).toBe('stay_main');
    expect(after.classification).toBe('deployment_unavailable');
    expect(after.deploymentCheck.checkpointDeployable).toBe(false);
    expect(after.blockers.some((b: string) => b.includes('no longer deployable'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: canRouteToProfile helper
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting canRouteToProfile', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('returns true when profile has enabled deployment and task is eligible', () => {
    setupReaderDeployment(tmpDir, true);

    const result = canRouteToProfile({ taskIntent: 'read_file', taskDescription: 'read config' }, tmpDir, 'local-reader');
    expect(result).toBe(true);
  });

  it('returns false when no deployment exists', () => {
    const result = canRouteToProfile({ taskIntent: 'read_file' }, tmpDir, 'local-reader');
    expect(result).toBe(false);
  });

  it('returns false when task is high-entropy', () => {
    setupReaderDeployment(tmpDir, true);

    const result = canRouteToProfile({ taskIntent: 'design', taskDescription: 'Design the system' }, tmpDir, 'local-reader');
    expect(result).toBe(false);
  });

  it('returns false when routing is disabled', () => {
    setupReaderDeployment(tmpDir, false);

    const result = canRouteToProfile({ taskIntent: 'read_file' }, tmpDir, 'local-reader');
    expect(result).toBe(false);
  });

  it('returns false for editor profile on reader task', () => {
    setupEditorDeployment(tmpDir, true);

    const result = canRouteToProfile({ taskIntent: 'read_file', taskDescription: 'read config' }, tmpDir, 'local-editor');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: isAnyLocalRoutingEnabled / listEnabledProfiles
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting isAnyLocalRoutingEnabled / listEnabledProfiles', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('returns false when no deployments exist', () => {
    expect(isAnyLocalRoutingEnabled(tmpDir)).toBe(false);
    expect(listEnabledProfiles(tmpDir)).toEqual([]);
  });

  it('returns false when deployments exist but routing is disabled', () => {
    setupReaderDeployment(tmpDir, false);
    setupEditorDeployment(tmpDir, false);

    expect(isAnyLocalRoutingEnabled(tmpDir)).toBe(false);
    expect(listEnabledProfiles(tmpDir)).toEqual([]);
  });

  it('returns true and lists profile when routing is enabled', () => {
    setupReaderDeployment(tmpDir, true);

    expect(isAnyLocalRoutingEnabled(tmpDir)).toBe(true);
    expect(listEnabledProfiles(tmpDir)).toEqual(['local-reader']);
  });

  it('lists multiple enabled profiles', () => {
    setupReaderDeployment(tmpDir, true);
    setupEditorDeployment(tmpDir, true);

    const enabled = listEnabledProfiles(tmpDir);
    expect(enabled).toContain('local-reader');
    expect(enabled).toContain('local-editor');
    expect(enabled).toHaveLength(2);
  });

  it('only lists profiles with routing enabled (not just bound)', () => {
    setupReaderDeployment(tmpDir, true); // enabled
    setupEditorDeployment(tmpDir, false); // bound but disabled

    const enabled = listEnabledProfiles(tmpDir);
    expect(enabled).toEqual(['local-reader']);
  });
});

// ---------------------------------------------------------------------------
// Tests: targetProfile override
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting targetProfile override', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('uses targetProfile from input when specified', () => {
    setupEditorDeployment(tmpDir, true); // Only editor is enabled

    // Reader deployment doesn't exist but we explicitly target reader
    const decision = classifyTask({
      taskIntent: 'read_file',
      taskDescription: 'read the config',
      targetProfile: 'local-reader',
    }, tmpDir);

    // Reader deployment doesn't exist → deployment_unavailable
    expect(decision.decision).toBe('stay_main');
    expect(decision.classification).toBe('deployment_unavailable');
  });

  it('rejects editor task targeting local-reader (profile-task mismatch)', () => {
    // Both deployments enabled
    setupReaderDeployment(tmpDir, true);
    setupEditorDeployment(tmpDir, true);

    // Editor-eligible task but explicitly targeting local-reader
    const decision = classifyTask({
      taskIntent: 'edit',
      taskDescription: 'Edit the file',
      targetProfile: 'local-reader',
    }, tmpDir);

    // MUST reject: editor task cannot route to reader profile
    expect(decision.decision).toBe('stay_main');
    expect(decision.classification).toBe('profile_mismatch');
    expect(decision.blockers).toContainEqual(expect.stringContaining('profile mismatch'));
  });

  it('accepts editor task targeting local-editor (correct profile)', () => {
    setupEditorDeployment(tmpDir, true);

    const decision = classifyTask({
      taskIntent: 'edit',
      taskDescription: 'Edit the file',
      targetProfile: 'local-editor',
    }, tmpDir);

    expect(decision.decision).toBe('route_local');
    expect(decision.targetProfile).toBe('local-editor');
  });
});

// ---------------------------------------------------------------------------
// Tests: Decision Explainability
// ---------------------------------------------------------------------------

describe('LocalWorkerRouting explainability', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmdir(tmpDir); });

  it('always provides a reason string', () => {
    setupReaderDeployment(tmpDir, true);

    const decision = classifyTask({ taskIntent: 'read_file' }, tmpDir);
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('blockers is empty when route_local', () => {
    setupReaderDeployment(tmpDir, true);

    const decision = classifyTask({ taskIntent: 'read_file' }, tmpDir);
    expect(decision.blockers).toEqual([]);
  });

  it('blockers is non-empty when stay_main', () => {
    const decision = classifyTask({ taskIntent: 'design', taskDescription: 'Design the system' }, tmpDir);
    expect(decision.blockers.length).toBeGreaterThan(0);
  });

  it('provides deployment check details', () => {
    const decision = classifyTask({ taskIntent: 'read_file' }, tmpDir);
    expect(decision.deploymentCheck).toBeDefined();
    expect('performed' in decision.deploymentCheck).toBe(true);
    expect('profileAvailable' in decision.deploymentCheck).toBe(true);
    expect('routingEnabled' in decision.deploymentCheck).toBe(true);
  });
});
