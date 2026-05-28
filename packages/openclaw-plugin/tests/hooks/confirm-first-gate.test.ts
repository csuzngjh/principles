import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateConfirmFirstGateSync,
  detectApprovalMarker,
  setConfirmFirstDirective,
  setConfirmFirstApproval,
  resetConfirmFirst,
  isSessionApproved,
  hasActiveDirective,
  clearAllConfirmFirstState,
} from '../../src/core/confirm-first-gate.js';

describe('Confirm-First Gate', () => {
  beforeEach(() => {
    clearAllConfirmFirstState();
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
      expect(detectApprovalMarker('proceed')).toBe(true);
      expect(detectApprovalMarker('confirm')).toBe(true);
      expect(detectApprovalMarker('yes, do it')).toBe(true);
      expect(detectApprovalMarker('do it')).toBe(true);
      expect(detectApprovalMarker('lgtm')).toBe(true);
    });

    it('rejects vague text', () => {
      expect(detectApprovalMarker('看看')).toBe(false);
      expect(detectApprovalMarker('继续想想')).toBe(false);
      expect(detectApprovalMarker('你决定')).toBe(false);
      expect(detectApprovalMarker('hello world')).toBe(false);
      expect(detectApprovalMarker('')).toBe(false);
    });
  });

  describe('evaluateConfirmFirstGateSync', () => {
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
