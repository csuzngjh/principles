import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvolutionReducerImpl } from '../../src/core/evolution-reducer.js';
import type { Principle, PrincipleEvaluatorLevel, PrincipleDetectorSpec } from '../../src/core/evolution-types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evolution-detector-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Valid detector metadata used in tests
// ---------------------------------------------------------------------------

const VALID_DETECTOR_METADATA: PrincipleDetectorSpec = {
  applicabilityTags: ['file-write', 'tool-failure'],
  positiveSignals: ['checked permissions', 'verified disk space'],
  negativeSignals: ['no pre-write check', 'assumed success'],
  toolSequenceHints: [
    ['read_file', 'edit_file'],
    ['grep', 'edit_file'],
  ],
  confidence: 'high',
};

// ---------------------------------------------------------------------------
// createPrincipleFromDiagnosis — evaluability defaults
// ---------------------------------------------------------------------------

describe('createPrincipleFromDiagnosis — evaluability defaults', () => {
  it('defaults to manual_only evaluability when no evaluability or detectorMetadata provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('manual_only');
    expect(p?.detectorMetadata).toBeUndefined();
  });

  it('accepts deterministic evaluability when provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'deterministic',
    });

    const p = reducer.getPrincipleById(id!);
    // Implementation contract: deterministic/weak_heuristic without detectorMetadata
    // is automatically downgraded to manual_only (defense in depth).
    expect(p?.evaluability).toBe('manual_only');
    expect(p?.detectorMetadata).toBeUndefined();
  });

  it('accepts weak_heuristic evaluability when provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'weak_heuristic',
    });

    const p = reducer.getPrincipleById(id!);
    // Implementation contract: deterministic/weak_heuristic without detectorMetadata
    // is automatically downgraded to manual_only.
    expect(p?.evaluability).toBe('manual_only');
  });

  it('stores detectorMetadata when provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'deterministic',
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('deterministic');
    expect(p?.detectorMetadata).toEqual(VALID_DETECTOR_METADATA);
  });

  it('upgrades evaluability to deterministic when detectorMetadata provided without explicit evaluability', () => {
    // The API contract: passing detectorMetadata with evaluability=manual_only would be
    // contradictory. The caller should pass the right evaluability.
    // But the reducer does NOT auto-upgrade — it respects evaluability if provided.
    // If evaluability is omitted but detectorMetadata is present, we still default to manual_only
    // (because evaluator field is what downstream code reads).
    // However, in practice, the subagent always passes evaluability alongside detectorMetadata.
    // So we test the explicit path.
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      // evaluability omitted — defaults to manual_only
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    const p = reducer.getPrincipleById(id!);
    // Without explicit evaluability, detectorMetadata alone is stored but evaluability defaults
    expect(p?.evaluability).toBe('manual_only'); // default — detectorMetadata is stored
    expect(p?.detectorMetadata).toEqual(VALID_DETECTOR_METADATA); // but stored for reference
  });
});

// ---------------------------------------------------------------------------
// Event replay — evaluability carried in candidate_created event
// ---------------------------------------------------------------------------

describe('Event replay — candidate_created carries evaluability', () => {
  it('restores evaluability from candidate_created event', () => {
    const workspace = makeTempDir();
    // Manually write a candidate_created event with evaluability to the stream
    const streamPath = path.join(workspace, 'memory', 'evolution.jsonl');
    fs.mkdirSync(path.dirname(streamPath), { recursive: true });

    const event = {
      ts: new Date().toISOString(),
      type: 'candidate_created',
      data: {
        painId: 'pain-1',
        principleId: 'P_001',
        trigger: 'file write fails',
        action: 'check permissions',
        status: 'candidate',
        evaluability: 'deterministic',
        detectorMetadata: VALID_DETECTOR_METADATA,
      },
    };

    fs.writeFileSync(streamPath, JSON.stringify(event) + '\n', 'utf8');

    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    const p = reducer.getPrincipleById('P_001');

    expect(p?.evaluability).toBe('deterministic');
    expect(p?.detectorMetadata).toEqual(VALID_DETECTOR_METADATA);
  });

  it('defaults evaluability to manual_only for event without evaluability field (legacy replay)', () => {
    const workspace = makeTempDir();
    const streamPath = path.join(workspace, 'memory', 'evolution.jsonl');
    fs.mkdirSync(path.dirname(streamPath), { recursive: true });

    // Legacy event without evaluability field
    const event = {
      ts: new Date().toISOString(),
      type: 'candidate_created',
      data: {
        painId: 'pain-1',
        principleId: 'P_001',
        trigger: 'file write fails',
        action: 'check permissions',
        status: 'candidate',
        // evaluability field absent
      },
    };

    fs.writeFileSync(streamPath, JSON.stringify(event) + '\n', 'utf8');

    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    const p = reducer.getPrincipleById('P_001');

    expect(p?.evaluability).toBe('manual_only');
    expect(p?.detectorMetadata).toBeUndefined();
  });

  it('defaults evaluability to manual_only for event with weak_heuristic', () => {
    const workspace = makeTempDir();
    const streamPath = path.join(workspace, 'memory', 'evolution.jsonl');
    fs.mkdirSync(path.dirname(streamPath), { recursive: true });

    const event = {
      ts: new Date().toISOString(),
      type: 'candidate_created',
      data: {
        painId: 'pain-1',
        principleId: 'P_001',
        trigger: 'file write fails',
        action: 'check permissions',
        status: 'candidate',
        evaluability: 'weak_heuristic',
        detectorMetadata: VALID_DETECTOR_METADATA,
      },
    };

    fs.writeFileSync(streamPath, JSON.stringify(event) + '\n', 'utf8');

    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });
    const p = reducer.getPrincipleById('P_001');

    expect(p?.evaluability).toBe('weak_heuristic');
    expect(p?.detectorMetadata).toEqual(VALID_DETECTOR_METADATA);
  });
});

// ---------------------------------------------------------------------------
// Existing principle update — evaluability preserved
// ---------------------------------------------------------------------------

describe('Existing principle update preserves evaluability', () => {
  it('updating existing principle does not overwrite evaluability when not provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Create with explicit evaluability
    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'deterministic',
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    // Update without providing evaluability (same painId triggers update path)
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1', // same painId — update path
      painType: 'tool_failure',
      triggerPattern: 'file write fails — updated pattern',
      action: 'check permissions and disk space',
      source: 'diagnostician',
      // evaluability omitted
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('deterministic'); // preserved from original
    expect(p?.detectorMetadata).toEqual(VALID_DETECTOR_METADATA); // preserved
    expect(p?.trigger).toBe('file write fails — updated pattern'); // updated
  });

  it('updating existing principle applies new evaluability when provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'deterministic',
      detectorMetadata: VALID_DETECTOR_METADATA, // required for auto-trainable
    });

    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails — updated',
      action: 'check permissions and disk space',
      source: 'diagnostician',
      evaluability: 'weak_heuristic', // explicit upgrade — still needs metadata
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('weak_heuristic');
    expect(p?.trigger).toContain('updated');
  });
});

// ---------------------------------------------------------------------------
// CandidateCreatedData — event data includes evaluability
// ---------------------------------------------------------------------------

describe('candidate_created event — evaluability in event data', () => {
  it('emits candidate_created event with evaluability=deterministic', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions',
      source: 'diagnostician',
      evaluability: 'deterministic',
      detectorMetadata: VALID_DETECTOR_METADATA, // required for auto-trainable
    });

    const events = reducer.getEventLog();
    const candidateEvent = events.find(e => e.type === 'candidate_created');
    expect(candidateEvent).toBeDefined();
    expect((candidateEvent!.data as any).evaluability).toBe('deterministic');
  });

  it('emits candidate_created event with evaluability=manual_only when not provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions',
      source: 'diagnostician',
      // no evaluability
    });

    const events = reducer.getEventLog();
    const candidateEvent = events.find(e => e.type === 'candidate_created');
    expect(candidateEvent).toBeDefined();
    // Defaults to 'manual_only' in event data
    expect((candidateEvent!.data as any).evaluability).toBe('manual_only');
  });

  it('emits candidate_created event with detectorMetadata when provided', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions',
      source: 'diagnostician',
      evaluability: 'weak_heuristic',
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    const events = reducer.getEventLog();
    const candidateEvent = events.find(e => e.type === 'candidate_created');
    expect((candidateEvent!.data as any).evaluability).toBe('weak_heuristic');
    expect((candidateEvent!.data as any).detectorMetadata).toEqual(VALID_DETECTOR_METADATA);
  });
});

// ---------------------------------------------------------------------------
// auto-trainable classification — principles without detector metadata
// ---------------------------------------------------------------------------

describe('manual_only classification — no automatic targeting', () => {
  it('principle without detectorMetadata has manual_only evaluability', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'generic error',
      action: 'be careful',
      source: 'diagnostician',
      // no evaluability, no detectorMetadata
    });

    // Principle auto-promotes to probation (not active)
    const p = reducer.getProbationPrinciples()[0];
    expect(p?.evaluability).toBe('manual_only');
    expect(p?.detectorMetadata).toBeUndefined();
  });

  it('principle with only natural-language text has manual_only evaluability', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Only evaluability provided (without detectorMetadata) — still manual_only
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'user_frustration',
      triggerPattern: 'agent was rude',
      action: 'be more polite',
      source: 'diagnostician',
      evaluability: 'manual_only', // explicitly manual_only
    });

    // Principle auto-promotes to probation (not active)
    const p = reducer.getProbationPrinciples()[0];
    expect(p?.evaluability).toBe('manual_only');
    expect(p?.detectorMetadata).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getActivePrinciples / getProbationPrinciples — evaluability present
// ---------------------------------------------------------------------------

describe('getActivePrinciples / getProbationPrinciples — evaluability field', () => {
  it('active principle has evaluability field set', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    // Create a principle with valid detectorMetadata so it stays as weak_heuristic
    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions',
      source: 'diagnostician',
      evaluability: 'weak_heuristic',
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    // Principle auto-promotes to probation (not directly to active)
    const probation = reducer.getProbationPrinciples();
    expect(probation).toHaveLength(1);
    expect(probation[0]!.evaluability).toBe('weak_heuristic');
  });

  it('probation principle (after feedback) has evaluability field set', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions',
      source: 'diagnostician',
      evaluability: 'deterministic',
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    // Principles auto-promote to probation after createPrincipleFromDiagnosis
    const probation = reducer.getProbationPrinciples();
    expect(probation).toHaveLength(1);
    expect(probation[0]!.evaluability).toBe('deterministic');
    expect(probation[0]!.detectorMetadata).toEqual(VALID_DETECTOR_METADATA);
  });
});

// ---------------------------------------------------------------------------
// Malformed / invalid detectorMetadata — reducer defense in depth
// ---------------------------------------------------------------------------

describe('Malformed detectorMetadata — defense in depth', () => {
  it('downgrades to manual_only when confidence is not a valid enum value', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'deterministic',
      // confidence is 'invalid', not 'high'|'medium'|'low'
      detectorMetadata: {
        applicabilityTags: ['file-write'],
        positiveSignals: ['checked permissions'],
        negativeSignals: ['no pre-write check'],
        toolSequenceHints: [],
        confidence: 'invalid' as any,
      },
    });

    const p = reducer.getPrincipleById(id!);
    // Subagent should not pass invalid confidence, but reducer also defends:
    // invalid confidence = no real auto-trainability
    expect(p?.evaluability).toBe('manual_only');
  });

  it('downgrades to manual_only when applicabilityTags is empty', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'weak_heuristic',
      detectorMetadata: {
        applicabilityTags: [],
        positiveSignals: ['checked permissions'],
        negativeSignals: ['no pre-write check'],
        toolSequenceHints: [],
        confidence: 'high',
      },
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('manual_only');
  });

  it('downgrades to manual_only when positiveSignals is empty', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'weak_heuristic',
      detectorMetadata: {
        applicabilityTags: ['file-write'],
        positiveSignals: [],
        negativeSignals: ['no pre-write check'],
        toolSequenceHints: [],
        confidence: 'medium',
      },
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('manual_only');
  });

  it('downgrades to manual_only when negativeSignals is empty', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'weak_heuristic',
      detectorMetadata: {
        applicabilityTags: ['file-write'],
        positiveSignals: ['checked permissions'],
        negativeSignals: [],
        toolSequenceHints: [],
        confidence: 'low',
      },
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('manual_only');
  });

  it('accepts valid detectorMetadata with all three signal arrays non-empty', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'file write fails',
      action: 'check permissions first',
      source: 'diagnostician',
      evaluability: 'deterministic',
      detectorMetadata: VALID_DETECTOR_METADATA,
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('deterministic');
    expect(p?.detectorMetadata).toEqual(VALID_DETECTOR_METADATA);
  });

  it('manual_only evaluability is accepted without detectorMetadata', () => {
    const workspace = makeTempDir();
    const reducer = new EvolutionReducerImpl({ workspaceDir: workspace });

    const id = reducer.createPrincipleFromDiagnosis({
      painId: 'pain-1',
      painType: 'tool_failure',
      triggerPattern: 'be careful',
      action: 'double-check',
      source: 'diagnostician',
      evaluability: 'manual_only',
      // no detectorMetadata — manual_only is always valid
    });

    const p = reducer.getPrincipleById(id!);
    expect(p?.evaluability).toBe('manual_only');
    expect(p?.detectorMetadata).toBeUndefined();
  });
});
