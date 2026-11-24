/**
 * SPEC-PD-PIPELINE-SPINE-001 §4.2 point 3 (PRI-1292 Phase 2A) — the ONE
 * plugin-side PainToPrincipleService factory shared by the after-tool-call
 * hook (`src/hooks/pain.ts`) and the `/pd pain` command
 * (`src/commands/pain.ts`).
 *
 * Pinned here: the factory routes the five host collaborators through
 * `resolveWorkspacePipelineHostDeps`, passes the Gateway's in-process
 * `WorkspaceContext.trajectory` as the reader override, and constructs the
 * service in CONSTANT-SYNC mode (both sync collaborators mandatory).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const captured = {
  resolveInput: undefined as Record<string, unknown> | undefined,
  serviceOptions: undefined as Record<string, unknown> | undefined,
};

const FAKE_DEPS = {
  intentDocReader: { readIntentDoc: () => ({ ok: false, found: false, flagEnabled: false, reason: 'flag_disabled' }) },
  trajectoryTurnReader: { listUserTurnsForSession: () => [], listAssistantTurns: () => [] },
  sourceMaterialAuthorization: { isHostSourceMaterialAuthorized: () => ({ authorized: true }) },
  telemetrySink: { emitTelemetry: () => true },
  isAutoPainSubmissionAuthorized: () => true,
};

vi.mock('@principles/host-runtime', () => ({
  resolveWorkspacePipelineHostDeps: (input: Record<string, unknown>) => {
    captured.resolveInput = input;
    return FAKE_DEPS;
  },
  isAutomaticPainSubmissionAuthorized: () => true,
}));
vi.mock('@principles/core/runtime', () => ({
  PainToPrincipleService: function PainToPrincipleServiceMock(options: Record<string, unknown>) {
    captured.serviceOptions = options;
    this.recordPain = vi.fn();
  },
  PrincipleTreeLedgerAdapter: function PrincipleTreeLedgerAdapterMock() {},
}));
vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: () => ({ ok: true, effective: { marker: 'plugin-effective' }, source: 'workspace', warnings: [], errors: [] }),
}));

import { createPluginPainToPrincipleService } from '../../src/core/pain-service.js';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';

describe('createPluginPainToPrincipleService (PRI-1292 Phase 2A, Layer C)', () => {
  beforeEach(() => {
    captured.resolveInput = undefined;
    captured.serviceOptions = undefined;
  });

  it('routes the five collaborators through resolveWorkspacePipelineHostDeps with the trajectory override', () => {
    const wctx = {
      workspaceDir: '/mock/workspace',
      stateDir: '/mock/workspace/.state',
      trajectory: {
        listUserTurnsForSession: vi.fn().mockReturnValue([{ id: 't1' }]),
        listAssistantTurns: vi.fn().mockReturnValue([]),
      },
    } as unknown as WorkspaceContext;

    const service = createPluginPainToPrincipleService(wctx);
    expect(service).toBeDefined();

    // ONE assembly point with the entry's effectiveConfig and the Gateway
    // in-process trajectory as the reader override.
    expect(captured.resolveInput?.workspaceDir).toBe('/mock/workspace');
    expect(captured.resolveInput?.effectiveConfig).toEqual({ marker: 'plugin-effective' });
    const override = captured.resolveInput?.trajectoryTurnReaderOverride as {
      listUserTurnsForSession: (sessionId: string) => unknown;
    };
    expect(override.listUserTurnsForSession('sess-1')).toEqual([{ id: 't1' }]);
    expect(wctx.trajectory.listUserTurnsForSession).toHaveBeenCalledWith('sess-1');

    // Constant-sync construction (no asyncMode key — the union's sync branch):
    // the service receives the override reader, the shared authorization and
    // the rest of the deps verbatim.
    expect(captured.serviceOptions?.asyncMode).not.toBe(true);
    expect(captured.serviceOptions?.trajectoryTurnReader).toBe(FAKE_DEPS.trajectoryTurnReader);
    expect(captured.serviceOptions?.sourceMaterialAuthorization).toBe(FAKE_DEPS.sourceMaterialAuthorization);
    expect(captured.serviceOptions?.intentDocReader).toBe(FAKE_DEPS.intentDocReader);
    expect(captured.serviceOptions?.telemetrySink).toBe(FAKE_DEPS.telemetrySink);
    expect(captured.serviceOptions?.isAutoPainSubmissionAuthorized).toBe(FAKE_DEPS.isAutoPainSubmissionAuthorized);
    expect(captured.serviceOptions?.owner).toBe('openclaw-plugin');
  });
});
