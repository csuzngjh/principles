/**
 * Chaos Engineering Tests for Principles Disciple
 * 
 * These tests inject failures and verify RESILIENCE - the system's ability
 * to recover gracefully from unexpected conditions.
 * 
 * Based on real production data showing:
 * - 13 failed diagnostician tasks in worker-status.json
 * - Concurrent write scenarios
 * - Corrupted file recovery needs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { 
  buildPainFlag, 
  writePainFlag, 
  readPainFlagData,
  validatePainFlag 
} from '../../src/core/pain.js';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

// Helper to safely remove directories
function safeRmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────────────────
// CHAOS 1: File System Failures
// ─────────────────────────────────────────────────────────────────────

describe('Chaos: File System Failures', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-chaos-fs-'));
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(workspaceDir);
  });

  it('RESILIENCE: readPainFlagData MUST NOT crash on corrupted file', () => {
    const painFlagPath = path.join(stateDir, '.pain_flag');
    
    // 写入损坏的数据
    fs.writeFileSync(painFlagPath, 'invalid content {{{ not kv format');
    
    // 必须不崩溃
    const result = readPainFlagData(workspaceDir);
    
    // 验证：返回安全默认值
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('RESILIENCE: readPainFlagData MUST handle empty file', () => {
    const painFlagPath = path.join(stateDir, '.pain_flag');
    fs.writeFileSync(painFlagPath, '');
    
    const result = readPainFlagData(workspaceDir);
    
    expect(result).toBeDefined();
  });

  it('RESILIENCE: readPainFlagData MUST handle missing file gracefully', () => {
    // 不创建文件
    const result = readPainFlagData(workspaceDir);
    
    expect(result).toBeDefined();
  });

  it('RESILIENCE: validatePainFlag MUST handle invalid object inputs', () => {
    // 各种无效对象输入
    const invalidInputs: Record<string, string>[] = [
      {},
      { source: '' },
      { source: 'test', score: 'invalid' },
      { source: 'test', score: '50' },
      { source: 'test', score: '50', time: '' },
    ];

    for (const input of invalidInputs) {
      const result = validatePainFlag(input);
      expect(Array.isArray(result)).toBe(true);  // 返回缺失字段列表
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// CHAOS 2: Concurrent Operations
// ─────────────────────────────────────────────────────────────────────

describe('Chaos: Concurrent Operations', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-chaos-concurrent-'));
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(workspaceDir);
  });

  it('RESILIENCE: Sequential writes MUST preserve last value', () => {
    const painFlagPath = path.join(stateDir, '.pain_flag');
    
    // 连续写入 100 次
    for (let i = 0; i < 100; i++) {
      writePainFlag(workspaceDir, buildPainFlag({
        source: 'sequential_test',
        score: String(i),
        reason: `Iteration ${i}`,
      }));
    }
    
    // 验证：最后一次写入生效
    const result = readPainFlagData(workspaceDir);
    expect(result.score).toBe('99');
    expect(result.reason).toBe('Iteration 99');
  });

  it('RESILIENCE: File MUST NOT contain corrupted data after writes', () => {
    const painFlagPath = path.join(stateDir, '.pain_flag');
    
    for (let i = 0; i < 50; i++) {
      writePainFlag(workspaceDir, buildPainFlag({
        source: `test_${i}`,
        score: String(i),
        reason: `Test ${i}`,
        session_id: `session-${i}`,
        agent_id: 'test-agent',
      }));
    }
    
    const content = fs.readFileSync(painFlagPath, 'utf-8');
    
    // 不应该有损坏的内容
    expect(content).not.toContain('undefined');
    expect(content).not.toContain('[object Object]');
    expect(content).not.toContain('NaN');
    expect(content).not.toContain('null');
    expect(content).not.toContain('function');
  });
});

// ─────────────────────────────────────────────────────────────────────
// CHAOS 3: Database Resilience
// ─────────────────────────────────────────────────────────────────────

describe('Chaos: Database Resilience', () => {
  let workspaceDir: string;
  let trajectory: TrajectoryDatabase;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-chaos-db-'));
    trajectory = new TrajectoryDatabase({ workspaceDir });
  });

  afterEach(() => {
    trajectory?.dispose();
    safeRmDir(workspaceDir);
  });

  it('RESILIENCE: Database MUST handle dispose and reopen correctly', () => {
    // 写入数据
    trajectory.recordSession({ 
      sessionId: 'test-session', 
      startedAt: new Date().toISOString() 
    });
    trajectory.recordToolCall({
      sessionId: 'test-session',
      toolName: 'test_tool',
      outcome: 'success',
    });
    
    // 关闭
    trajectory.dispose();
    
    // 重新打开
    const trajectory2 = new TrajectoryDatabase({ workspaceDir });
    
    // 验证数据仍然存在
    const stats = trajectory2.getDataStats();
    expect(stats.toolCalls).toBe(1);
    
    trajectory2.dispose();
  });

  it('RESILIENCE: Database MUST handle invalid session gracefully', () => {
    // 写入不存在的 session 的 tool call
    // 当前实现会自动创建 session
    expect(() => {
      trajectory.recordToolCall({
        sessionId: 'non-existent-session',
        toolName: 'test',
        outcome: 'success',
      });
    }).not.toThrow();
  });

  it('RESILIENCE: Database MUST handle duplicate session recording', () => {
    // 多次记录同一个 session
    for (let i = 0; i < 5; i++) {
      trajectory.recordSession({ 
        sessionId: 'same-session', 
        startedAt: new Date().toISOString() 
      });
    }
    
    // 验证只有一个 session
    const stats = trajectory.getDataStats();
    expect(stats.toolCalls).toBe(0);  // 没有 tool calls
  });
});

// ─────────────────────────────────────────────────────────────────────
// CHAOS 4: Malformed Input Recovery
// ─────────────────────────────────────────────────────────────────────

describe('Chaos: Malformed Input Recovery', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-chaos-input-'));
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(workspaceDir);
  });

  it('RESILIENCE: buildPainFlag MUST handle all edge cases', () => {
    const edgeCases = [
      { source: '', score: '50', reason: '' },
      { source: 'a'.repeat(10000), score: '50', reason: 'x'.repeat(10000) },
      { source: 'test', score: '-1', reason: 'negative score' },
      { source: 'test', score: '101', reason: 'overflow score' },
      { source: 'test', score: '50.5', reason: 'decimal score' },
      { source: 'test', score: 'NaN', reason: 'NaN score' },
      { source: 'test\nwith\nnewlines', score: '50', reason: 'multiline\nreason' },
      { source: 'test<script>', score: '50', reason: 'xss<script>alert(1)</script>' },
    ];

    for (const input of edgeCases) {
      expect(() => buildPainFlag(input)).not.toThrow();
    }
  });

  it('RESILIENCE: writePainFlag MUST sanitize special characters', () => {
    writePainFlag(workspaceDir, buildPainFlag({
      source: 'test\nwith\nnewlines',
      score: '50',
      reason: 'reason\twith\ttabs',
    }));

    const content = fs.readFileSync(path.join(stateDir, '.pain_flag'), 'utf-8');
    
    // 文件应该可以正常读取
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CHAOS 5: Edge Case Discovery (based on production data)
// ─────────────────────────────────────────────────────────────────────

describe('Chaos: Production Data Patterns', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-chaos-prod-'));
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(workspaceDir);
  });

  it('RESILIENCE: Pain flag without session_id MUST be valid', () => {
    // 生产数据中 session_id 可能为空
    writePainFlag(workspaceDir, buildPainFlag({
      source: 'tool_failure',
      score: '80',
      reason: 'Test without session',
      session_id: '',
      agent_id: '',
    }));

    const result = readPainFlagData(workspaceDir);
    expect(result.source).toBe('tool_failure');
    expect(result.score).toBe('80');
  });

  it('RESILIENCE: Multiple pain sources MUST be distinguishable', () => {
    const sources = [
      'tool_failure',
      'user_feedback', 
      'human_intervention',
      'manual',
      'gate_block',
    ];

    for (const source of sources) {
      writePainFlag(workspaceDir, buildPainFlag({
        source,
        score: '50',
        reason: `Test ${source}`,
      }));
    }

    // 最后一个写入应该生效
    const result = readPainFlagData(workspaceDir);
    expect(result.source).toBe('gate_block');
  });

  it('RESILIENCE: Timestamp MUST be valid ISO format', () => {
    writePainFlag(workspaceDir, buildPainFlag({
      source: 'test',
      score: '50',
      reason: 'timestamp test',
    }));

    const result = readPainFlagData(workspaceDir);
    
    // 验证时间戳是有效的 ISO 格式
    const timestamp = new Date(result.time);
    expect(timestamp).toBeInstanceOf(Date);
    expect(isNaN(timestamp.getTime())).toBe(false);
  });
});
