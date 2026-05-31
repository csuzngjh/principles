import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  evaluateConfirmFirstGateSync,
  detectApprovalMarker,
  setConfirmFirstDirective,
  setConfirmFirstApproval,
  resetConfirmFirst,
  isSessionApproved,
  hasActiveDirective,
  clearAllConfirmFirstState,
  setConfirmFirstStore,
  hydrateFromStore,
  setConfirmFirstGateEnabled,
  isConfirmFirstGateEnabled,
} from '../../src/core/confirm-first-gate.js';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { SqliteConfirmFirstStateStore } from '@principles/core/runtime-v2';

describe('Confirm-First Gate', () => {
  beforeEach(() => {
    clearAllConfirmFirstState();
    setConfirmFirstGateEnabled(false); // Default OFF (PRI-286)
  });

  afterEach(() => {
    setConfirmFirstGateEnabled(false);
  });

  describe('detectApprovalMarker', () => {
    it('detects Chinese approval markers', () => {
      expect(detectApprovalMarker('确认')).toBe(true);
      expect(detectApprovalMarker('批准')).toBe(true);
      expect(detectApprovalMarker('按计划执行')).toBe(true);
      expect(detectApprovalMarker('可以执行')).toBe(true);
      expect(detectApprovalMarker('就这么做')).toBe(true);
      expect(detectApprovalMarker('去执行')).toBe(true);
      expect(detectApprovalMarker('开始执行')).toBe(true);
      expect(detectApprovalMarker('执行吧')).toBe(true);
      expect(detectApprovalMarker('同意')).toBe(true);
    });

    it('detects English approval markers', () => {
      expect(detectApprovalMarker('approved')).toBe(true);
      expect(detectApprovalMarker('go ahead')).toBe(true);
      expect(detectApprovalMarker('lgtm')).toBe(true);
      expect(detectApprovalMarker('yes, do it')).toBe(true);
      expect(detectApprovalMarker('do it')).toBe(true);
      expect(detectApprovalMarker('yes, proceed')).toBe(true);
      expect(detectApprovalMarker('yes, execute')).toBe(true);
      expect(detectApprovalMarker('proceed with the plan')).toBe(true);
      expect(detectApprovalMarker('execute the plan')).toBe(true);
      expect(detectApprovalMarker('please proceed with the plan')).toBe(true);
    });

    it('rejects vague text', () => {
      expect(detectApprovalMarker('看看')).toBe(false);
      expect(detectApprovalMarker('继续想想')).toBe(false);
      expect(detectApprovalMarker('你决定')).toBe(false);
      expect(detectApprovalMarker('hello world')).toBe(false);
      expect(detectApprovalMarker('')).toBe(false);
    });

    it('rejects negated Chinese approval', () => {
      expect(detectApprovalMarker('不同意')).toBe(false);
      expect(detectApprovalMarker('不确认')).toBe(false);
      expect(detectApprovalMarker('先不执行')).toBe(false);
      expect(detectApprovalMarker('还没准备好确认')).toBe(false);
      expect(detectApprovalMarker('暂不批准')).toBe(false);
    });

    it('rejects negated English approval', () => {
      expect(detectApprovalMarker("don't proceed")).toBe(false);
      expect(detectApprovalMarker("don't do it")).toBe(false);
      expect(detectApprovalMarker("not ready to confirm")).toBe(false);
      expect(detectApprovalMarker("can't approve yet")).toBe(false);
      expect(detectApprovalMarker("won't proceed")).toBe(false);
      expect(detectApprovalMarker("stop")).toBe(false);
    });

    it('rejects ambiguous English phrases without explicit approval context', () => {
      expect(detectApprovalMarker('please confirm requirements before proceeding')).toBe(false);
      expect(detectApprovalMarker('how should we proceed?')).toBe(false);
      expect(detectApprovalMarker('confirm the requirement first')).toBe(false);
      expect(detectApprovalMarker('should I proceed?')).toBe(false);
      expect(detectApprovalMarker('I need to confirm something')).toBe(false);
      expect(detectApprovalMarker('let me confirm the plan')).toBe(false);
    });
  });

  // ── PRI-286: Feature flag gate ──
  describe('Feature flag gate (PRI-286)', () => {
    it('gate is OFF by default', () => {
      expect(isConfirmFirstGateEnabled()).toBe(false);
    });

    it('gate skips ALL tool calls when feature flag is OFF', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      // Even with active directive, gate skips because feature flag is OFF
      const result = evaluateConfirmFirstGateSync('session-1', 'write', { path: 'test.json' });
      expect(result.action).toBe('skip');
    });

    it('gate skips write tool when feature flag is OFF even with directive', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      expect(evaluateConfirmFirstGateSync('session-1', 'write', {}).action).toBe('skip');
      expect(evaluateConfirmFirstGateSync('session-1', 'edit', {}).action).toBe('skip');
      expect(evaluateConfirmFirstGateSync('session-1', 'exec', { command: 'rm -rf /' }).action).toBe('skip');
    });

    it('gate can be enabled via setConfirmFirstGateEnabled', () => {
      setConfirmFirstGateEnabled(true);
      expect(isConfirmFirstGateEnabled()).toBe(true);
    });
  });

  // ── PRI-286: PLAN.md self-unblock ──
  describe('PLAN.md self-unblock (PRI-286)', () => {
    beforeEach(() => {
      setConfirmFirstGateEnabled(true);
    });

    it('never blocks writes to PLAN.md via write tool', () => {
      setConfirmFirstDirective('session-1', true, 'princ-cf');
      const result = evaluateConfirmFirstGateSync('session-1', 'write', { path: 'PLAN.md' });
      expect(result.action).toBe('allow');
    });

    it('never blocks writes to PLAN.md via edit tool', () => {
      setConfirmFirstDirective('session-1', true, 'princ-cf');
      const result = evaluateConfirmFirstGateSync('session-1', 'edit', { file_path: 'PLAN.md' });
      expect(result.action).toBe('allow');
    });

    it('never blocks writes to nested PLAN.md', () => {
      setConfirmFirstDirective('session-1', true, 'princ-cf');
      const result = evaluateConfirmFirstGateSync('session-1', 'write', { path: 'D:\\Code\\project\\PLAN.md' });
      expect(result.action).toBe('allow');
    });

    it('never blocks bash commands targeting PLAN.md', () => {
      setConfirmFirstDirective('session-1', true, 'princ-cf');
      const result = evaluateConfirmFirstGateSync('session-1', 'exec', { command: 'echo "hello" > PLAN.md' });
      expect(result.action).toBe('allow');
    });

    it('still blocks other .md files', () => {
      setConfirmFirstDirective('session-1', true, 'princ-cf');
      const result = evaluateConfirmFirstGateSync('session-1', 'write', { path: 'README.md' });
      expect(result.action).toBe('block');
    });
  });

  describe('evaluateConfirmFirstGateSync — when gate enabled', () => {
    beforeEach(() => {
      setConfirmFirstGateEnabled(true);
    });

    it('skips when no sessionId', () => {
      const result = evaluateConfirmFirstGateSync(undefined, 'write', {});
      expect(result.action).toBe('skip');
    });

    it('skips when no confirm-first directive active', () => {
      const result = evaluateConfirmFirstGateSync('session-1', 'write', {});
      expect(result.action).toBe('skip');
    });

    it('allows non-mutating tools even with active directive', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'read', {});
      expect(result.action).toBe('allow');
    });

    it('blocks write tool when directive active and not approved', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'write', { path: 'test.json' });
      expect(result.action).toBe('block');
      expect(result.reason).toBe('confirm_first_required');
      expect(result.principleId).toBe('princ-mvp-acceptance-confirm-first');
      expect(result.nextAction).toContain('owner approval');
    });

    it('blocks edit tool when directive active and not approved', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'edit', { file_path: 'test.ts' });
      expect(result.action).toBe('block');
      expect(result.reason).toBe('confirm_first_required');
    });

    it('blocks delete_file when directive active and not approved', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'delete_file', { path: 'test.txt' });
      expect(result.action).toBe('block');
    });

    it('blocks mutating exec when directive active and not approved', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'exec', { command: 'rm -rf /tmp/test' });
      expect(result.action).toBe('block');
    });

    it('allows non-mutating exec when directive active and not approved', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'exec', { command: 'ls -la' });
      expect(result.action).toBe('allow');
    });

    it('allows bash with undefined params when directive active', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'bash', undefined);
      expect(result.action).toBe('allow');
    });

    it('allows read tool when directive active and not approved', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'read', { file_path: 'test.ts' });
      expect(result.action).toBe('allow');
    });

    it('allows write after approval', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      setConfirmFirstApproval('session-1');
      const result = evaluateConfirmFirstGateSync('session-1', 'write', { path: 'test.json' });
      expect(result.action).toBe('allow');
      expect(isSessionApproved('session-1')).toBe(true);
    });

    it('approval is session-scoped', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      setConfirmFirstDirective('session-2', true, 'princ-mvp-acceptance-confirm-first');
      setConfirmFirstApproval('session-1');

      expect(evaluateConfirmFirstGateSync('session-1', 'write', {}).action).toBe('allow');
      expect(evaluateConfirmFirstGateSync('session-2', 'write', {}).action).toBe('block');
    });

    it('blocks apply_patch with no path when directive active', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      const result = evaluateConfirmFirstGateSync('session-1', 'apply_patch', { patch: '@@ -1 +1 @@\n-old\n+new' });
      expect(result.action).toBe('block');
      expect(result.reason).toBe('confirm_first_required');
    });

    it('allows apply_patch after approval', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      setConfirmFirstApproval('session-1');
      const result = evaluateConfirmFirstGateSync('session-1', 'apply_patch', { patch: '@@ -1 +1 @@\n-old\n+new' });
      expect(result.action).toBe('allow');
    });

    it('reset clears both directive and approval state', () => {
      setConfirmFirstDirective('session-1', true, 'princ-mvp-acceptance-confirm-first');
      setConfirmFirstApproval('session-1');
      resetConfirmFirst('session-1');

      expect(hasActiveDirective('session-1')).toBe(false);
      expect(isSessionApproved('session-1')).toBe(false);
      expect(evaluateConfirmFirstGateSync('session-1', 'write', {}).action).toBe('skip');
    });
  });
});

describe('Cross-restart persistence', () => {
  let tmpDir: string;
  let connection: SqliteConnection;
  let store: SqliteConfirmFirstStateStore;

  beforeEach(() => {
    clearAllConfirmFirstState();
    setConfirmFirstStore(null);
    setConfirmFirstGateEnabled(true); // Enable for persistence tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cf-test-'));
    connection = new SqliteConnection(tmpDir);
    store = new SqliteConfirmFirstStateStore(connection);
  });

  afterEach(() => {
    setConfirmFirstGateEnabled(false);
    setConfirmFirstStore(null);
    clearAllConfirmFirstState();
    try {
      connection.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('directive + approval survive restart', () => {
    setConfirmFirstStore(store);
    setConfirmFirstDirective('sess-restart', true, 'princ-123');
    setConfirmFirstApproval('sess-restart');

    expect(evaluateConfirmFirstGateSync('sess-restart', 'write', {}).action).toBe('allow');

    setConfirmFirstStore(null);
    clearAllConfirmFirstState();
    setConfirmFirstStore(store);
    hydrateFromStore('sess-restart');

    expect(evaluateConfirmFirstGateSync('sess-restart', 'write', {}).action).toBe('allow');
    expect(hasActiveDirective('sess-restart')).toBe(true);
    expect(isSessionApproved('sess-restart')).toBe(true);
  });

  it('directive without approval survives restart', () => {
    setConfirmFirstStore(store);
    setConfirmFirstDirective('sess-restart', true, 'princ-456');

    expect(evaluateConfirmFirstGateSync('sess-restart', 'write', {}).action).toBe('block');

    setConfirmFirstStore(null);
    clearAllConfirmFirstState();
    setConfirmFirstStore(store);
    hydrateFromStore('sess-restart');

    expect(evaluateConfirmFirstGateSync('sess-restart', 'write', {}).action).toBe('block');
    expect(hasActiveDirective('sess-restart')).toBe(true);
    expect(isSessionApproved('sess-restart')).toBe(false);
  });

  it('no directive survives restart', () => {
    setConfirmFirstStore(store);

    setConfirmFirstStore(null);
    clearAllConfirmFirstState();
    setConfirmFirstStore(store);
    hydrateFromStore('sess-noexist');

    expect(evaluateConfirmFirstGateSync('sess-noexist', 'write', {}).action).toBe('skip');
    expect(hasActiveDirective('sess-noexist')).toBe(false);
  });

  it('stale state does not block after restart when feature flag is OFF (PRI-286)', () => {
    setConfirmFirstStore(store);
    setConfirmFirstDirective('sess-stale', true, 'princ-stale');
    // State persisted with directive active

    // Simulate restart: gate disabled by default
    setConfirmFirstGateEnabled(false);
    setConfirmFirstStore(null);
    clearAllConfirmFirstState();
    setConfirmFirstStore(store);
    hydrateFromStore('sess-stale');

    // Even though directive is active in store, gate is OFF → skip
    expect(evaluateConfirmFirstGateSync('sess-stale', 'write', {}).action).toBe('skip');
    expect(hasActiveDirective('sess-stale')).toBe(true); // directive IS active
  });
});

describe('Store degradation (ERR-002)', () => {
  afterEach(() => {
    setConfirmFirstGateEnabled(false);
    setConfirmFirstStore(null);
    clearAllConfirmFirstState();
  });

  it('store write failure degrades gracefully to cache-only', () => {
    setConfirmFirstGateEnabled(true);
    const throwingStore = {
      upsertDirective: () => { throw new Error('DB unavailable'); },
      upsertApproval: () => { throw new Error('DB unavailable'); },
      getState: () => null,
      deleteState: () => { throw new Error('DB unavailable'); },
      deleteAllState: () => { throw new Error('DB unavailable'); },
      pruneStaleRows: () => 0,
      getAllState: () => [],
    } as unknown as SqliteConfirmFirstStateStore;

    setConfirmFirstStore(throwingStore);
    setConfirmFirstDirective('sess-degrade', true, 'princ-123');

    expect(hasActiveDirective('sess-degrade')).toBe(true);

    setConfirmFirstApproval('sess-degrade');
    expect(isSessionApproved('sess-degrade')).toBe(true);
    expect(evaluateConfirmFirstGateSync('sess-degrade', 'write', {}).action).toBe('allow');
  });
});

describe('Stale directive cleared on reset (PRI-266)', () => {
  beforeEach(() => {
    clearAllConfirmFirstState();
    setConfirmFirstGateEnabled(true);
  });

  afterEach(() => {
    setConfirmFirstGateEnabled(false);
  });

  it('resetConfirmFirst clears directive and approval from cache and store', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cf-stale-'));
    try {
      const connection = new SqliteConnection(tmpDir);
      const store = new SqliteConfirmFirstStateStore(connection);
      setConfirmFirstStore(store);

      setConfirmFirstDirective('sess-stale', true, 'princ-stale');
      setConfirmFirstApproval('sess-stale');

      expect(hasActiveDirective('sess-stale')).toBe(true);
      expect(isSessionApproved('sess-stale')).toBe(true);

      resetConfirmFirst('sess-stale');

      expect(hasActiveDirective('sess-stale')).toBe(false);
      expect(isSessionApproved('sess-stale')).toBe(false);
      expect(evaluateConfirmFirstGateSync('sess-stale', 'write', {}).action).toBe('skip');

      connection.close();
    } finally {
      setConfirmFirstStore(null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resetConfirmFirst without store clears in-memory cache only', () => {
    setConfirmFirstDirective('sess-nostore', true, 'princ-nostore');
    setConfirmFirstApproval('sess-nostore');

    expect(hasActiveDirective('sess-nostore')).toBe(true);
    expect(isSessionApproved('sess-nostore')).toBe(true);

    resetConfirmFirst('sess-nostore');

    expect(hasActiveDirective('sess-nostore')).toBe(false);
    expect(isSessionApproved('sess-nostore')).toBe(false);
  });
});
