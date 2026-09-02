/**
 * PRI-642 SPEC §9/§13 — painIngress.v1 dual-write SQLite round trip.
 *
 * submitPainSignal must persist BOTH the versioned `painIngress` namespace
 * and the legacy top-level fields from one builder, consistently, in the
 * real state store; re-entry validation must accept the round-tripped
 * payload and reject a tampered nested/top-level contradiction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { DiagnosticianRunnerLike } from '../pain-signal-bridge.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { checkIngressTopLevelConsistency, parsePainIngressV1Payload } from '../pain-ingress-payload.js';
import type { PainIngressV1Payload } from '../pain-ingress-payload.js';

let tmpDir: string;
let stateManager: RuntimeStateManager;

function makeBridge(): PainSignalBridge {
  const runner: DiagnosticianRunnerLike = { run: async () => ({ status: 'succeeded', taskId: 't', attemptCount: 1 }) };
  return new PainSignalBridge({
    stateManager,
    runner,
    intakeService: {} as never,
    ledgerAdapter: { register: () => undefined, existsForCandidate: () => undefined, getEntries: () => [] } as never,
  });
}

const BOUND_INGRESS: PainIngressV1Payload = {
  version: 'v1',
  origin: { kind: 'owner_manual', channel: 'openclaw_command' },
  correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'sess-rt-1' },
  evidenceClass: { status: 'available', entryCount: 2 },
};

describe('painIngress.v1 dual-write round trip (PRI-642 §9, §13)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ingress-rt-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the nested namespace beside the legacy top-level fields, consistently', async () => {
    const bridge = makeBridge();
    const { taskId } = await bridge.submitPainSignal({
      painId: 'manual_rt_1',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'round trip',
      score: 70,
      sessionId: 'sess-rt-1',
      provenance: 'host_context_bound',
      hostKind: 'openclaw',
      evidence: [
        { sourceRef: 'owner_message:t1', note: 'fix it' },
        { sourceRef: 'tool_call_failure:t2', note: 'Tool bash failed' },
      ],
      painIngress: BOUND_INGRESS,
    });

    const task = await stateManager.getTask(taskId);
    expect(task).not.toBeNull();
    if (task === null) throw new Error('task missing after submit');
    const parsed = JSON.parse(task.diagnosticJson as string) as Record<string, unknown>;

    // Legacy top-level fields all present.
    expect(parsed.sourcePainId).toBe('manual_rt_1');
    expect(parsed.provenance).toBe('host_context_bound');
    expect(parsed.sessionIdHint).toBe('sess-rt-1');
    expect((parsed.evidence as unknown[]).length).toBe(2);
    expect(parsed.hostKind).toBe('openclaw');

    // Nested namespace present, parseable, consistent with top-level.
    const ingress = parsePainIngressV1Payload(parsed.painIngress);
    expect(ingress.ok).toBe(true);
    if (!ingress.ok) return;
    const mismatch = checkIngressTopLevelConsistency({
      payload: ingress.payload,
      topLevelProvenance: parsed.provenance,
      topLevelSessionIdHint: parsed.sessionIdHint,
      topLevelEvidenceCount: (parsed.evidence as unknown[]).length,
    });
    expect(mismatch).toBeNull();

    // Re-entry accepts the round-tripped payload.
    const executed = await bridge.executePendingDiagnosis({ taskId });
    expect(executed.message).not.toContain('diagnostic_payload_invalid');
    expect(executed.message).not.toContain('ingress_payload_mismatch');
  });

  it('a submission without ingress facts keeps the legacy-only payload (compatibility window)', async () => {
    const bridge = makeBridge();
    const { taskId } = await bridge.submitPainSignal({
      painId: 'manual_rt_2',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'legacy shape',
      provenance: 'owner_reported_no_host_trace',
      evidence: [],
    });
    const task = await stateManager.getTask(taskId);
    if (task === null) throw new Error('task missing after submit');
    const parsed = JSON.parse(task.diagnosticJson as string) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, 'painIngress')).toBe(false);
    expect(parsed.provenance).toBe('owner_reported_no_host_trace');
  });

  it('re-entry rejects a payload whose nested facts were tampered after the write', async () => {
    const bridge = makeBridge();
    const { taskId } = await bridge.submitPainSignal({
      painId: 'manual_rt_3',
      painType: 'user_frustration',
      source: 'manual',
      reason: 'tamper target',
      sessionId: 'sess-rt-1',
      provenance: 'host_context_bound',
      hostKind: 'openclaw',
      evidence: [{ sourceRef: 'owner_message:t1', note: 'fix it' }],
      painIngress: {
        version: 'v1',
        origin: { kind: 'owner_manual', channel: 'openclaw_command' },
        correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'sess-rt-1' },
        evidenceClass: { status: 'available', entryCount: 1 },
      },
    });

    // Corrupt the persisted nested evidence count (simulates drift between
    // the two namespaces).
    const task = await stateManager.getTask(taskId);
    if (task === null) throw new Error('task missing after submit');
    const payload = JSON.parse(task.diagnosticJson as string) as Record<string, unknown>;
    const nested = payload.painIngress as Record<string, unknown>;
    const cls = nested.evidenceClass as Record<string, unknown>;
    cls.entryCount = 9;
    await stateManager.updateTask(taskId, { diagnosticJson: JSON.stringify(payload) });

    const executed = await bridge.executePendingDiagnosis({ taskId });
    expect(executed.status).toBe('failed');
    expect(executed.message).toContain('ingress_payload_mismatch');
  });
});

// ── Review blocker 2: re-entry validation must equal write-time validation ──

describe('painIngress.v1 re-entry invariant parity (review blocker 2)', () => {
  const baseV1 = {
    version: 'v1' as const,
    origin: { kind: 'owner_manual' as const, channel: 'openclaw_command' },
    correlation: { status: 'bound' as const, hostKind: 'openclaw' as const, sessionId: 'sess-real' },
    evidenceClass: { status: 'available' as const, entryCount: 2 },
  };

  it('T1: bound/openclaw/sessionId="cli" → reject (session_sentinel_invalid)', () => {
    const parsed = parsePainIngressV1Payload({
      ...baseV1,
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'cli' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('session_sentinel_invalid');
  });

  it('T2: bound/openclaw/sessionId="unknown" → reject (session_sentinel_invalid)', () => {
    const parsed = parsePainIngressV1Payload({
      ...baseV1,
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'unknown' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('session_sentinel_invalid');
  });

  it('T3: evidenceClass available with entryCount 0 → reject (write-time requires >= 1)', () => {
    const parsed = parsePainIngressV1Payload({
      ...baseV1,
      evidenceClass: { status: 'available', entryCount: 0 },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('ingress_evidence_class_invalid');
  });

  it('T4: owner_manual.external_cli_unbound + bound correlation → reject (impossible combination)', () => {
    const parsed = parsePainIngressV1Payload({
      ...baseV1,
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('origin_correlation_mismatch');
  });

  it('T5: owner_manual.cli_explicit_session + unbound correlation → reject (impossible combination)', () => {
    const parsed = parsePainIngressV1Payload({
      ...baseV1,
      origin: { kind: 'owner_manual', channel: 'cli_explicit_session' },
      correlation: { status: 'unbound', reason: 'external_cli' },
      evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasonCode).toBe('origin_correlation_mismatch');
  });

  it('T6: legal bound OpenClaw v1 (real session, available entryCount > 0) → accept', () => {
    const parsed = parsePainIngressV1Payload(baseV1);
    expect(parsed.ok).toBe(true);
  });

  it('T7: legal external CLI unbound v1 (unbound + not_applicable_unbound) → accept', () => {
    const parsed = parsePainIngressV1Payload({
      version: 'v1',
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      correlation: { status: 'unbound', reason: 'external_cli' },
      evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
    });
    expect(parsed.ok).toBe(true);
  });
});

// ── Review blocker 2 closure: nested/top-level consistency must catch
// every tampered dimension (not just provenance/session/count). ─────────────

describe('checkIngressTopLevelConsistency (review blocker 2 closure)', () => {
  it('flags unavailable evidenceClass against a non-zero legacy evidence count', () => {
    const payload: PainIngressV1Payload = {
      version: 'v1',
      origin: { kind: 'owner_manual', channel: 'openclaw_command' },
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'sess-real' },
      evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
    };
    const mismatch = checkIngressTopLevelConsistency({
      payload,
      topLevelProvenance: 'host_context_bound',
      topLevelSessionIdHint: 'sess-real',
      topLevelEvidenceCount: 2, // ← forged legacy entries
    });
    expect(mismatch).toBe('ingress_payload_mismatch:unavailable_evidence_count');
  });

  it('flags unbound v1 with a non-empty legacy sessionIdHint', () => {
    const payload: PainIngressV1Payload = {
      version: 'v1',
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      correlation: { status: 'unbound', reason: 'external_cli' },
      evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
    };
    const mismatch = checkIngressTopLevelConsistency({
      payload,
      topLevelProvenance: 'owner_reported_no_host_trace',
      topLevelSessionIdHint: 'sess-forged',
      topLevelEvidenceCount: 0,
    });
    expect(mismatch).toBe('ingress_payload_mismatch:unbound_session_hint');
  });

  it('accepts a consistent bound OpenClaw v1 with matching evidence count', () => {
    const payload: PainIngressV1Payload = {
      version: 'v1',
      origin: { kind: 'owner_manual', channel: 'openclaw_command' },
      correlation: { status: 'bound', hostKind: 'openclaw', sessionId: 'sess-real' },
      evidenceClass: { status: 'available', entryCount: 2 },
    };
    const mismatch = checkIngressTopLevelConsistency({
      payload,
      topLevelProvenance: 'host_context_bound',
      topLevelSessionIdHint: 'sess-real',
      topLevelEvidenceCount: 2,
    });
    expect(mismatch).toBeNull();
  });

  it('accepts a consistent external unbound v1 with no session hint', () => {
    const payload: PainIngressV1Payload = {
      version: 'v1',
      origin: { kind: 'owner_manual', channel: 'external_cli_unbound' },
      correlation: { status: 'unbound', reason: 'external_cli' },
      evidenceClass: { status: 'unavailable', reason: 'not_applicable_unbound' },
    };
    const mismatch = checkIngressTopLevelConsistency({
      payload,
      topLevelProvenance: 'owner_reported_no_host_trace',
      topLevelSessionIdHint: null,
      topLevelEvidenceCount: 0,
    });
    expect(mismatch).toBeNull();
  });
});
