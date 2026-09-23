/**
 * Security audit run-1: gate-failopen-allow-on-state-corruption.
 *
 * A missing governance store must leave a durable, out-of-workspace marker
 * (best-effort) while the gate still fails open with its structured warning.
 * os.homedir is mocked so the test never writes into the real user home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: vi.fn() };
});

import type { HostEvent } from '@principles/core/host';
import { createProductionRuleHostGate } from '../src/production-rulehost-gate.js';
import { markerPathFor } from '../src/degraded-enforcement-marker.js';
import type { RuleImplementationRuntime, RuleBatchEvaluation } from '../src/rule-implementation-runtime.js';

let tempWorkspaceDir: string;
let testHome: string;

function makeStubRuntime(): RuleImplementationRuntime {
  return {
    evaluateBatch(): RuleBatchEvaluation {
      return { ok: true, results: [] };
    },
  };
}

describe('production gate: durable degraded-enforcement marker on missing state.db', () => {
  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-marker-'));
    vi.mocked(os.homedir).mockReturnValue(testHome);
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-marker-ws-'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  });

  it('records the out-of-workspace marker when state.db is absent, and still fails open', async () => {
    // No state.db was created — the workspace has no governance store.
    const gate = createProductionRuleHostGate({ implementationRuntime: makeStubRuntime() });
    const event: HostEvent = {
      kind: 'before_tool_call',
      context: { workspaceDir: tempWorkspaceDir, sessionId: 'marker-test', toolName: 'write_file' },
      rawPayload: { toolInput: { toolName: 'write_file', params: { path: '/etc/passwd' } } },
      source: 'test',
    } as unknown as HostEvent;

    const result = await gate(event);

    expect(result.decision).toBe('allow');
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('activation_db_not_found')]),
    );

    const markerPath = markerPathFor(tempWorkspaceDir);
    expect(fs.existsSync(markerPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(record.reason).toBe('activation_db_not_found');
    expect(record.workspaceDir).toBe(path.resolve(tempWorkspaceDir));
    expect(record.occurrences).toBe(1);
  });
});
