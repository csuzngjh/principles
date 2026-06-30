/**
 * PrincipleTreeLedgerAdapter unit tests.
 *
 * Bug-O L3a coverage — verifies the `activatePrinciple` method that bridges
 * ApprovalsConsoleModel.approve() to the principle-tree-ledger status upgrade.
 *
 * Tested behaviors:
 *   1. `activatePrinciple` succeeds and upgrades ledger status 'candidate' -> 'active'.
 *   2. `activatePrinciple` on a missing principle returns `{ ok: false, reason }`
 *      WITHOUT throwing (rc-9-no-silent-fallback).
 *   3. `activatePrinciple` on one principle does not affect other principles' status.
 *
 * ERR entries considered:
 *   - ERR-009 / ERR-010: fail loud on missing required data — `updatePrinciple`
 *     throws when the principle id is not in the ledger. We surface that as
 *     `{ ok: false, reason }` so the caller can record a non-fatal warning
 *     instead of rolling back the already-committed activation (rc-9).
 *   - ERR-015 / ERR-018: loop-state freshness — `activatePrinciple` re-reads
 *     the ledger inside `updatePrinciple`'s mutateLedger, so it always acts
 *     on the latest committed state (no stale in-memory snapshot).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PrincipleTreeLedgerAdapter } from '../principle-tree-ledger-adapter.js';
import { loadLedger } from '../../../principle-tree-ledger.js';
import type { LedgerPrincipleEntry } from '../../candidate-intake.js';

// ── Test Setup ─────────────────────────────────────────────────────────────

let tempDir: string;
let stateDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ledger-adapter-test-'));
  stateDir = path.join(tempDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  // On Windows, SQLite / file lock handles may not release immediately.
  // Retry the cleanup with a short delay to avoid EPERM errors.
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      break;
    } catch (err) {
      attempts++;
      if (attempts >= maxAttempts) {
        console.warn(
          `Failed to clean up temp dir after ${maxAttempts} attempts:`,
          err instanceof Error ? err.message : String(err),
        );
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProbationEntry(overrides: Partial<LedgerPrincipleEntry> = {}): LedgerPrincipleEntry {
  const id = overrides.id ?? 'P_test_001';
  return {
    id,
    title: `Test principle ${id}`,
    text: 'Avoid silent fallback — surface a reason (rc-9).',
    triggerPattern: 'before_tool_call',
    action: 'inject review note',
    status: 'probation',
    evaluability: 'weak_heuristic',
    sourceRef: `candidate://candidate-${id}`,
    createdAt: '2026-06-29T00:00:00.000Z',
    ...overrides,
  };
}

// ── Bug-O L3a: activatePrinciple ───────────────────────────────────────────

describe('PrincipleTreeLedgerAdapter — activatePrinciple (Bug-O L3a)', () => {
  it('upgrades a candidate principle to active and returns { ok: true }', () => {
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });
    const entry = makeProbationEntry({ id: 'P_activate_ok' });
    adapter.writeProbationEntry(entry);

    const result = adapter.activatePrinciple('P_activate_ok');

    expect(result.ok).toBe(true);

    // Verify ledger state — writeProbationEntry records status='candidate',
    // activatePrinciple must flip it to 'active' on disk (rc-9: no silent
    // fallback; the caller relies on the persisted state being current).
    const ledger = loadLedger(stateDir);
    const stored = ledger.tree.principles.P_activate_ok;
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('active');
    // updatedAt must be refreshed by activatePrinciple so callers can observe
    // when the upgrade happened, not when the principle was first written.
    expect(stored?.updatedAt).not.toBe(entry.createdAt);
  });

  it('returns { ok: false, reason } without throwing when principle is missing', () => {
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });

    // No prior writeProbationEntry call — the ledger has no principles.
    // updatePrinciple() inside activatePrinciple throws
    //   "Cannot update missing principle \"<id>\"."
    // We must surface that as a non-fatal { ok: false, reason } instead of
    // propagating the throw (rc-9-no-silent-fallback + ERR-009/ERR-010).
    const result = adapter.activatePrinciple('P_does_not_exist');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Reason must be structured + actionable (cli-6-output-next-action).
      expect(result.reason).toContain('ledger_activate_failed');
      expect(result.reason).toContain('Cannot update missing principle');
      expect(result.reason).toContain('P_does_not_exist');
    }

    // Ledger on disk must remain empty — no orphan rows written on failure.
    const ledger = loadLedger(stateDir);
    expect(Object.keys(ledger.tree.principles)).toHaveLength(0);
  });

  it('does not affect other principles when activating one (rc-7 loop-state freshness)', () => {
    const adapter = new PrincipleTreeLedgerAdapter({ stateDir });

    // Seed two candidate principles.
    const entryA = makeProbationEntry({ id: 'P_target' });
    const entryB = makeProbationEntry({ id: 'P_bystander' });
    adapter.writeProbationEntry(entryA);
    adapter.writeProbationEntry(entryB);

    // Sanity check: both are candidates before activation.
    const before = loadLedger(stateDir);
    expect(before.tree.principles.P_target?.status).toBe('candidate');
    expect(before.tree.principles.P_bystander?.status).toBe('candidate');

    // Activate ONLY P_target.
    const result = adapter.activatePrinciple('P_target');
    expect(result.ok).toBe(true);

    // P_target flips to active; P_bystander stays candidate. This guards
    // against accidental bulk-update / stale-snapshot regressions
    // (ERR-015 / ERR-018 stale loop state class).
    const after = loadLedger(stateDir);
    expect(after.tree.principles.P_target?.status).toBe('active');
    expect(after.tree.principles.P_bystander?.status).toBe('candidate');

    // Bystander's updatedAt must be untouched.
    expect(after.tree.principles.P_bystander?.updatedAt).toBe(entryB.createdAt);
  });
});
