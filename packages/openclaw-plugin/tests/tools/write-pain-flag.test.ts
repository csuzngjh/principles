import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWritePainFlagTool } from '../../src/tools/write-pain-flag.js';

// ─── Mock state shared between isolated tests ────────────────────────────────
type MockFn = (...args: unknown[]) => unknown;
let mockRecordPainEventFn: MockFn | undefined;
let mockRecordPainEventThrows = false;

function makeTrajectoryMock() {
  const fn = vi.fn((...args: unknown[]) => {
    if (mockRecordPainEventThrows) throw new Error('trajectory DB write error');
    return mockRecordPainEventFn ? mockRecordPainEventFn(...args) : 1;
  });
  return { recordPainEvent: fn };
}

vi.mock('../../src/core/trajectory.js', () => ({
  TrajectoryRegistry: {
    get: vi.fn(() => makeTrajectoryMock()),
  },
}));

function safeRmDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Create a mock OpenClawPluginApi for testing
 */
function createMockApi(workspaceDir: string) {
  const logs: { level: string; message: string }[] = [];
  return {
    config: { workspaceDir },
    logger: {
      info: (m: string) => logs.push({ level: 'info', message: m }),
      warn: (m: string) => logs.push({ level: 'warn', message: m }),
      error: (m: string) => logs.push({ level: 'error', message: m }),
      debug: (m: string) => logs.push({ level: 'debug', message: m }),
    },
    runtime: { subagent: null, agent: null },
    _logs: logs,
  };
}

describe('write_pain_flag tool', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-tool-'));
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(workspaceDir);
  });

  // ─────────────────────────────────────────────────────────
  // Contract: Tool interface matches OpenClaw AgentTool spec
  // ─────────────────────────────────────────────────────────
  it('matches the AgentTool interface (name, description, parameters, execute)', () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    expect(tool.name).toBe('write_pain_flag');
    expect(tool.description).toBeDefined();
    expect(tool.description).toContain('pain signal');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('has clear, unambiguous description in English', () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    expect(tool.description).not.toBe('');
    expect(tool.description).toContain('pain signal');
    expect(tool.description).toContain('INSTEAD');
    expect(tool.description).toContain('.pain_flag');
  });

  // ─────────────────────────────────────────────────────────
  // Contract: Pain flag format (KV, not JSON, not [object Object])
  // ─────────────────────────────────────────────────────────
  it('writes pain flag in correct KV format, never [object Object]', async () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    const result = await tool.execute('test-1', {
      reason: 'Agent forgot to read file before editing',
      score: 85,
      source: 'manual',
    });

    // Verify tool returns success
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('85');
    expect(result.content[0].text).toContain('manual');

    // Verify file exists and is NOT [object Object]
    const painFlagPath = path.join(stateDir, '.pain_flag');
    expect(fs.existsSync(painFlagPath)).toBe(true);
    const content = fs.readFileSync(painFlagPath, 'utf-8');
    expect(content).not.toContain('[object Object]');
    expect(content).not.toContain('{');
    expect(content).not.toContain('undefined');

    // Verify KV format — each line is "key: value"
    const lines = content.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      expect(line).toMatch(/^[a-z_]+: .+$/);
    }

    // Verify required fields
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      fields[line.substring(0, colonIdx).trim()] = line.substring(colonIdx + 1).trim();
    }
    expect(fields.source).toBe('manual');
    expect(fields.score).toBe('85');
    expect(fields.reason).toBe('Agent forgot to read file before editing');
    expect(fields.time).toBeDefined();
    expect(fields.pain_event_id).toBeDefined();
    expect(fields.pain_event_id).toMatch(/^\d+$/);
  });

  // ─────────────────────────────────────────────────────────
  // Contract: Required field validation
  // ─────────────────────────────────────────────────────────
  it('returns clear error when reason is missing', async () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    const result = await tool.execute('test-2', {});

    expect(result.content[0].text).toContain('❌');
    expect(result.content[0].text).toContain('reason');
    expect(api._logs.some((l: any) => l.level === 'warn')).toBe(true);
  });

  it('falls back to PathResolver when config.workspaceDir is not set', async () => {
    // Even without explicit workspaceDir, the tool should succeed
    // by falling back to PathResolver (which finds default workspace)
    const logs: { level: string; message: string }[] = [];
    const api = {
      config: {},
      logger: {
        info: (m: string) => logs.push({ level: 'info', message: m }),
        warn: (m: string) => logs.push({ level: 'warn', message: m }),
        error: (m: string) => logs.push({ level: 'error', message: m }),
        debug: (m: string) => logs.push({ level: 'debug', message: m }),
      },
      runtime: { subagent: null, agent: null },
      _logs: logs,
    } as any;

    const tool = createWritePainFlagTool(api);
    const result = await tool.execute('test-3', { reason: 'Test fallback' });

    // Should succeed via PathResolver fallback
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('Test fallback');
  });

  // ─────────────────────────────────────────────────────────
  // Atomic write: temp file + rename
  // ─────────────────────────────────────────────────────────
  it('writes atomically (no partial writes on crash)', async () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    // First write
    await tool.execute('test-4a', { reason: 'First pain signal', score: 50 });
    const painFlagPath = path.join(stateDir, '.pain_flag');
    const content1 = fs.readFileSync(painFlagPath, 'utf-8');
    expect(content1).toContain('First pain signal');

    // Verify no temp files left
    const files = fs.readdirSync(stateDir);
    const tempFiles = files.filter(f => f.startsWith('.pain_flag.tmp'));
    expect(tempFiles.length).toBe(0);

    // Second write (overwrites)
    await tool.execute('test-4b', { reason: 'Second pain signal', score: 70 });
    const content2 = fs.readFileSync(painFlagPath, 'utf-8');
    expect(content2).toContain('Second pain signal');
    expect(content2).not.toContain('First pain signal');

    // Verify no temp files left
    const files2 = fs.readdirSync(stateDir);
    const tempFiles2 = files2.filter(f => f.startsWith('.pain_flag.tmp'));
    expect(tempFiles2.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────
  // Score clamping (0-100)
  // ─────────────────────────────────────────────────────────
  it('clamps score to 0-100 range', async () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    // Score too high
    const result1 = await tool.execute('test-5a', { reason: 'Test', score: 200 });
    expect(result1.content[0].text).toContain('100');

    // Score too low
    const result2 = await tool.execute('test-5b', { reason: 'Test', score: -50 });
    expect(result2.content[0].text).toContain('0');

    // Score at boundaries
    const result3 = await tool.execute('test-5c', { reason: 'Test', score: 0 });
    expect(result3.content[0].text).toContain('0');

    const result4 = await tool.execute('test-5d', { reason: 'Test', score: 100 });
    expect(result4.content[0].text).toContain('100');
  });

  // ─────────────────────────────────────────────────────────
  // Agent feedback: clear success/failure messages
  // ─────────────────────────────────────────────────────────
  it('provides clear success feedback with all details', async () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    const result = await tool.execute('test-6', {
      reason: 'Test error for feedback',
      score: 75,
      source: 'tool_failure',
      is_risky: true,
    });

    const text = result.content[0].text;
    expect(text).toContain('✅');
    expect(text).toContain('Test error for feedback');
    expect(text).toContain('75');
    expect(text).toContain('tool_failure');
    expect(text).toContain('Yes'); // is_risky
    expect(text).toContain('heartbeat');
  });

  it('handles missing state directory by creating it automatically', async () => {
    const api = createMockApi(workspaceDir) as any;
    // Remove .state directory to test auto-creation
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

    const tool = createWritePainFlagTool(api);
    const result = await tool.execute('test-auto', { reason: 'Auto-create state dir' });

    expect(result.content[0].text).toContain('✅');
    const painFlagPath = path.join(stateDir, '.pain_flag');
    expect(fs.existsSync(painFlagPath)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────
  // Default values
  // ─────────────────────────────────────────────────────────
  it('uses correct defaults for optional parameters', async () => {
    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    const result = await tool.execute('test-8', {
      reason: 'Test defaults',
    });

    const text = result.content[0].text;
    expect(text).toContain('80'); // default score
    expect(text).toContain('manual'); // default source
    expect(text).toContain('No'); // default is_risky
  });

  // ─────────────────────────────────────────────────────────
  // Graceful degradation: trajectory write failure still writes flag
  // ─────────────────────────────────────────────────────────
  it('writes pain flag even when recordPainEvent throws', async () => {
    // Configure the module-level mock to throw
    mockRecordPainEventThrows = true;

    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    const result = await tool.execute('test-degradation', {
      reason: 'Pain signal with failing trajectory',
      score: 60,
      source: 'user_empathy',
    });

    // Should still succeed (graceful degradation)
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('60');

    // Flag file should still exist
    const painFlagPath = path.join(stateDir, '.pain_flag');
    expect(fs.existsSync(painFlagPath)).toBe(true);
    const content = fs.readFileSync(painFlagPath, 'utf-8');
    expect(content).toContain('Pain signal with failing trajectory');

    // pain_event_id should NOT be present since trajectory failed
    expect(content).not.toContain('pain_event_id:');

    // Should have logged a warning
    expect(api._logs.some((l: any) => l.level === 'warn')).toBe(true);

    // Reset for next test
    mockRecordPainEventThrows = false;
  });

  // ─────────────────────────────────────────────────────────
  // recordPainEvent called with correct arguments
  // ─────────────────────────────────────────────────────────
  it('calls recordPainEvent with correct arguments from tool params', async () => {
    // Set up the spy result via the module-level mock factory
    mockRecordPainEventFn = vi.fn(() => 42);

    const api = createMockApi(workspaceDir) as any;
    const tool = createWritePainFlagTool(api);

    await tool.execute('test-spy', {
      reason: 'Spy test reason',
      score: 55,
      source: 'tool_failure',
      session_id: 'session-spy-001',
      is_risky: true,
    });

    // Access the spy through the TrajectoryRegistry.get mock
    const { TrajectoryRegistry } = await import('../../src/core/trajectory.js');
    const mockGet = TrajectoryRegistry.get as ReturnType<typeof vi.fn>;
    const mockTraj = mockGet.mock.results.at(-1)!.value as { recordPainEvent: ReturnType<typeof vi.fn> };

    expect(mockTraj.recordPainEvent).toHaveBeenCalledOnce();
    expect(mockTraj.recordPainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-spy-001',
        source: 'tool_failure',
        score: 55,
        reason: 'Spy test reason',
        severity: null,
        origin: 'manual',
        confidence: null,
      })
    );

    // Also verify pain_event_id: 42 appears in the flag file
    const painFlagPath = path.join(stateDir, '.pain_flag');
    const content = fs.readFileSync(painFlagPath, 'utf-8');
    expect(content).toContain('pain_event_id: 42');

    // Reset for next test
    mockRecordPainEventFn = undefined;
  });
});
