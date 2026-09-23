/**
 * PR #1846 review follow-up (CodeRabbit): SqliteConnection's default write
 * mode AUTO-CREATES a missing state.db, so "the governance store was
 * deleted" never reached the catch-based marker — the load succeeded with
 * zero activations. RuleHost must detect the missing file BEFORE connecting
 * and leave the same durable out-of-workspace trace as the host-runtime
 * gate, while keeping the fail-open allow posture.
 *
 * os.homedir is mocked so the marker never lands in the real user home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: vi.fn() };
});

import { RuleHost } from '../../src/core/rule-host.js';
import { markerPathFor } from '../../src/core/degraded-enforcement-marker.js';
import type { RuleHostInput } from '@principles/core/runtime-v2';

let tempWorkspaceDir: string;
let testHome: string;

function makeInput(normalizedPath: string): RuleHostInput {
  return {
    action: {
      toolName: 'write_file',
      normalizedPath,
      paramsSummary: { path: normalizedPath },
    },
    workspace: { isRiskPath: false },
    session: { sessionId: 'marker-test', currentGfi: 0 },
    evolution: { epTier: 1 },
    derived: { estimatedLineChanges: 1, bashRisk: 'safe' as const },
  };
}

describe('RuleHost degraded-enforcement marker on missing state.db (PR #1846 review)', () => {
  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rh-marker-home-'));
    vi.mocked(os.homedir).mockReturnValue(testHome);
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rh-marker-ws-'));
    // Deliberately NO state.db: this is the deleted-store / never-created
    // workspace case the fix must not auto-bootstrap away.
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(testHome, { recursive: true, force: true });
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
  });

  it('records the durable marker, warns with activation_db_not_found, and still fails open', () => {
    const warns: string[] = [];
    const host = new RuleHost(path.join(tempWorkspaceDir, '.principles'), { warn: (m?: string) => { if (m) warns.push(m); } }, { workspaceDir: tempWorkspaceDir });

    const result = host.evaluate(makeInput('/etc/passwd'));

    expect(result).toBeUndefined();
    expect(warns.some((w) => w.includes('activation_db_not_found'))).toBe(true);

    const markerPath = markerPathFor(tempWorkspaceDir);
    expect(fs.existsSync(markerPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(record.reason).toBe('activation_db_not_found');
    expect(record.workspaceDir).toBe(path.resolve(tempWorkspaceDir));
    expect(record.occurrences).toBe(1);
    host.dispose();
  });

  it('does NOT auto-create state.db while probing for it', () => {
    const host = new RuleHost(path.join(tempWorkspaceDir, '.principles'), { warn: () => {} }, { workspaceDir: tempWorkspaceDir });
    host.evaluate(makeInput('/etc/passwd'));
    expect(fs.existsSync(path.join(tempWorkspaceDir, '.pd', 'state.db'))).toBe(false);
    host.dispose();
  });
});
