/**
 * Thinking OS Checkpoint Tests (P-10)
 * 
 * Tests the mandatory deep thinking checkpoint before high-risk operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import { recordThinkingCheckpoint, hasRecentThinking, clearSession } from '../../src/core/session-tracker.js';
import * as fs from 'fs';
import * as path from 'path';

const MOCK_SESSION_ID = 'test-thinking-session-001';
// Use os.tmpdir() for cross-platform compatibility
const MOCK_WORKSPACE = require('os').tmpdir() + '/pd-test-thinking-workspace';
const PROFILE_PATH = path.join(MOCK_WORKSPACE, '.principles', 'PROFILE.json');

// Profile with thinking checkpoint ENABLED for testing
const TEST_PROFILE = {
  thinking_checkpoint: {
    enabled: true,
    window_ms: 5 * 60 * 1000,
  high_risk_tools: ['run_shell_command', 'delete_file', 'move_file', 'pd_run_worker', 'write', 'edit'],
  },
};

function createMockContext(overrides = {}) {
  return {
    sessionId: MOCK_SESSION_ID,
    workspaceDir: MOCK_WORKSPACE,
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    ...overrides,
  };
}

function createMockEvent(toolName: string, params: Record<string, any> = {}) {
  return {
    toolName,
    params,
  };
}

describe('Thinking OS Checkpoint (P-10)', () => {
  beforeEach(() => {
    clearSession(MOCK_SESSION_ID);
    // Create workspace directory and PROFILE.json with checkpoint enabled
    fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(TEST_PROFILE));
  });

  afterEach(() => {
    // Clean up PROFILE.json
    if (fs.existsSync(PROFILE_PATH)) {
      fs.unlinkSync(PROFILE_PATH);
    }
  });

  describe('Blocking high-risk operations without thinking', () => {
    it('should block write tool without recent thinking', () => {
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('deep_reflect');
    });

    it('should block exec tool without recent thinking', () => {
      const result = handleBeforeToolCall(
        createMockEvent('run_shell_command', { command: 'ls -la' }),
        createMockContext()
      );
      
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });

    it('should block edit tool without recent thinking', () => {
      const result = handleBeforeToolCall(
        createMockEvent('edit', { file_path: '/test/file.ts', old_string: 'a', new_string: 'b' }),
        createMockContext()
      );
      
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });

  it('should block pd_run_worker without recent thinking', () => {
      const result = handleBeforeToolCall(
      createMockEvent('pd_run_worker', { agentType: 'explorer' }),
        createMockContext()
      );
      
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });
  });

  describe('Allowing operations after thinking', () => {
    it('should allow write tool after recording thinking checkpoint', () => {
      // Record thinking
      recordThinkingCheckpoint(MOCK_SESSION_ID, MOCK_WORKSPACE);
      
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      
      // Should not be blocked by thinking gate (may be blocked by other gates like risk path)
      // If blocked, the reason should NOT be about thinking checkpoint
      if (result?.block) {
        expect(result.blockReason).not.toContain('Thinking OS');
      }
    });

    it('should allow exec tool after recording thinking checkpoint', () => {
      recordThinkingCheckpoint(MOCK_SESSION_ID, MOCK_WORKSPACE);
      
      const result = handleBeforeToolCall(
        createMockEvent('run_shell_command', { command: 'echo hello' }),
        createMockContext()
      );
      
      if (result?.block) {
        expect(result.blockReason).not.toContain('Thinking OS');
      }
    });
  });

  describe('Session state tracking', () => {
    it('should initially have no recent thinking', () => {
      expect(hasRecentThinking(MOCK_SESSION_ID)).toBe(false);
    });

    it('should have recent thinking after recording checkpoint', () => {
      recordThinkingCheckpoint(MOCK_SESSION_ID, MOCK_WORKSPACE);
      expect(hasRecentThinking(MOCK_SESSION_ID)).toBe(true);
    });

    it('should expire after time window passes', async () => {
      recordThinkingCheckpoint(MOCK_SESSION_ID, MOCK_WORKSPACE);
      // Initially should be true
      expect(hasRecentThinking(MOCK_SESSION_ID, 1000)).toBe(true);
      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(hasRecentThinking(MOCK_SESSION_ID, 100)).toBe(false);
    });
  });

  describe('Non-high-risk tools bypass', () => {
    it('should not block read tool', () => {
      const result = handleBeforeToolCall(
        createMockEvent('read', { file_path: '/test/file.ts' }),
        createMockContext()
      );
      expect(result).toBeUndefined();
    });

    it('should not block web_search tool', () => {
      const result = handleBeforeToolCall(
        createMockEvent('web_search', { query: 'test' }),
        createMockContext()
      );
      expect(result).toBeUndefined();
    });
  });

  describe('Boundary: thinking_checkpoint config variations', () => {
    it('should not crash when PROFILE.json is missing', () => {
      // Remove PROFILE.json
      if (fs.existsSync(PROFILE_PATH)) {
        fs.unlinkSync(PROFILE_PATH);
      }
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      // Should not crash, should use defaults (checkpoint disabled)
      expect(result).toBeUndefined();
    });

    it('should not crash when thinking_checkpoint is null', () => {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify({ thinking_checkpoint: null }));
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      expect(result).toBeUndefined();
    });

    it('should not crash when thinking_checkpoint.enabled is null', () => {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify({ thinking_checkpoint: { enabled: null } }));
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      expect(result).toBeUndefined();
    });

    it('should not crash when high_risk_tools is null', () => {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify({ thinking_checkpoint: { enabled: true, high_risk_tools: null } }));
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      // Should use default high_risk_tools list
      expect(result).toBeUndefined();
    });

    it('should not block any tool when high_risk_tools is empty array', () => {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify({ thinking_checkpoint: { enabled: true, high_risk_tools: [] } }));
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      // Empty list = no tools are high risk
      expect(result).toBeUndefined();
    });

    it('should not crash when thinking_checkpoint is invalid type (string)', () => {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify({ thinking_checkpoint: "invalid" }));
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      expect(result).toBeUndefined();
    });

    it('should not crash when PROFILE.json is malformed JSON', () => {
      fs.writeFileSync(PROFILE_PATH, '{ invalid json }');
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      // Should fall back to defaults
      expect(result).toBeUndefined();
    });

    it('should respect custom high_risk_tools list', () => {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify({ thinking_checkpoint: { enabled: true, high_risk_tools: ['write'] } }));
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      // write is in the list, should be blocked
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });

    it('should not block tool not in custom high_risk_tools list', () => {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify({ thinking_checkpoint: { enabled: true, high_risk_tools: ['delete_file'] } }));
      const result = handleBeforeToolCall(
        createMockEvent('write', { file_path: '/test/file.ts', content: 'test' }),
        createMockContext()
      );
      // write is NOT in the list, should not be blocked
      expect(result).toBeUndefined();
    });
  });
});
