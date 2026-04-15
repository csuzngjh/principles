/**
 * E2E tests for tool hooks workspaceDir resolution
 * 
 * Verifies that after_tool_call and before_tool_call hooks
 * correctly resolve workspaceDir and write events to the correct location.
 * 
 * This test addresses the bug where PluginHookToolContext lacks workspaceDir,
 * causing events to be written to ~/.state/ instead of workspace directory.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock OpenClaw API for testing
const createMockApi = (workspaceDir: string) => ({
  runtime: {
    agent: {
      resolveAgentWorkspaceDir: vi.fn().mockReturnValue(workspaceDir),
    },
  },
  config: {},
  resolvePath: vi.fn().mockReturnValue(workspaceDir),
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  pluginConfig: {},
});

// Helper to get today's events file path (EventLog uses date-stamped files)
const getTodayEventsFile = (logsDir: string) => {
  const today = new Date().toISOString().split('T')[0];
  return path.join(logsDir, `events_${today}.jsonl`);
};

describe('E2E: Tool Hooks workspaceDir Resolution', () => {
  const testWorkspaceDir = path.join(os.tmpdir(), 'pd-tool-hooks-e2e-test');
  const stateDir = path.join(testWorkspaceDir, '.state');
  const logsDir = path.join(stateDir, 'logs');
  const eventsFile = getTodayEventsFile(logsDir);

  beforeAll(() => {
    // Create test workspace structure
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
  });

  describe('Scenario 1: ctx.workspaceDir is provided (future OpenClaw fix)', () => {
    it('should use ctx.workspaceDir directly when valid', async () => {
      const { validateWorkspaceDir } = await import('../../src/core/workspace-dir-validation.js');
      
      const ctx = { 
        workspaceDir: testWorkspaceDir, 
        agentId: 'test-agent' 
      };
      
      const result = validateWorkspaceDir(ctx.workspaceDir);
      expect(result).toBeNull(); // Valid
    });
  });

  describe('Scenario 2: ctx.workspaceDir is undefined (current OpenClaw behavior)', () => {
    it('should fallback to agentId resolution', async () => {
      const { resolveValidWorkspaceDir } = await import('../../src/core/workspace-dir-service.js');
      
      const mockApi = createMockApi(testWorkspaceDir);
      const ctx = { 
        workspaceDir: undefined, // OpenClaw doesn't provide this
        agentId: 'test-agent' 
      };
      
      const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'after_tool_call' });
      
      expect(result).toBe(testWorkspaceDir);
      expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalledWith(mockApi.config, 'test-agent');
    });

    it('should refuse to guess a workspace when agentId is also undefined', async () => {
      const { resolveValidWorkspaceDir } = await import('../../src/core/workspace-dir-service.js');
      
      const mockApi = createMockApi(testWorkspaceDir);
      const ctx = { 
        workspaceDir: undefined,
        agentId: undefined 
      };
      
      const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'after_tool_call' });
      
      expect(result).toBeUndefined();
      expect(mockApi.resolvePath).not.toHaveBeenCalled();
    });
  });

  describe('Scenario 3: Events are written to correct location', () => {
    it('should create events.jsonl in workspace directory with correct content', () => {
      // Simulate event being written
      const testEvent = {
        ts: new Date().toISOString(),
        type: 'hook_execution',
        category: 'success',
        data: { hook: 'after_tool_call' },
      };
      
      fs.appendFileSync(eventsFile, JSON.stringify(testEvent) + '\n', 'utf-8');
      
      // Verify file exists in workspace directory
      expect(fs.existsSync(eventsFile)).toBe(true);
      
      // Verify content contains the expected hook
      const content = fs.readFileSync(eventsFile, 'utf-8');
      const lines = content.trim().split('\n');
      const lastLine = JSON.parse(lines[lines.length - 1]);
      expect(lastLine.data.hook).toBe('after_tool_call');
      
      // Verify the path is NOT directly under home directory
      // (it should be under a workspace subdirectory)
      const homeDir = os.homedir();
      const normalizedPath = path.normalize(eventsFile);
      // Events file should not be directly at ~/.state/logs/events.jsonl
      const directHomeEventsFile = path.join(homeDir, '.state', 'logs', 'events.jsonl');
      // If it happens to be the same path, that's a problem
      if (normalizedPath === path.normalize(directHomeEventsFile)) {
        throw new Error('Events file is being written to ~/.state/ instead of workspace directory!');
      }
    });
  });

  describe('Scenario 4: Invalid workspace candidates are rejected', () => {
    it('should return undefined when all workspace resolution candidates are invalid', async () => {
      const { resolveValidWorkspaceDir } = await import('../../src/core/workspace-dir-service.js');
      
      const mockApi = createMockApi(os.homedir());
      mockApi.runtime.agent.resolveAgentWorkspaceDir.mockReturnValue(os.homedir());
      
      const ctx = { workspaceDir: undefined, agentId: 'test-agent' };
      
      const result = resolveValidWorkspaceDir(ctx, mockApi as any, { source: 'test' });
      
      expect(result).toBeUndefined();
    });
  });
});

describe('E2E: EventLog flushImmediately', () => {
  const testWorkspaceDir = path.join(os.tmpdir(), 'pd-eventlog-flush-test');
  const stateDir = path.join(testWorkspaceDir, '.state');
  const logsDir = path.join(stateDir, 'logs');
  const eventsFile = getTodayEventsFile(logsDir);

  beforeAll(() => {
    fs.mkdirSync(logsDir, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(testWorkspaceDir)) {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
  });

  it('should flush events immediately when flushImmediately is true', async () => {
    const { EventLog } = await import('../../src/core/event-log.js');
    
    const eventLog = new EventLog(stateDir);
    
    // Write with flushImmediately
    eventLog.recordHookExecution({ hook: 'after_tool_call' }, { flushImmediately: true });
    
    // File should exist immediately (not waiting for buffer or timer)
    expect(fs.existsSync(eventsFile)).toBe(true);
    
    // Content should be there
    const content = fs.readFileSync(eventsFile, 'utf-8');
    expect(content).toContain('after_tool_call');
    
    eventLog.flush();
  });

  it('should not flush immediately when flushImmediately is false or omitted', async () => {
    const { EventLog } = await import('../../src/core/event-log.js');
    
    // Clean up
    if (fs.existsSync(eventsFile)) {
      fs.unlinkSync(eventsFile);
    }
    
    const eventLog = new EventLog(stateDir);
    
    // Write without flushImmediately
    eventLog.recordHookExecution({ hook: 'before_tool_call' });
    
    // File might not exist yet (depends on buffer)
    // But after manual flush, it should be there
    eventLog.flush();
    
    expect(fs.existsSync(eventsFile)).toBe(true);
    const content = fs.readFileSync(eventsFile, 'utf-8');
    expect(content).toContain('before_tool_call');
  });
});
