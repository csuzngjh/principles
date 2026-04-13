import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createWritePainFlagTool } from '../../src/tools/write-pain-flag.js';

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

  it('returns clear error when workspace cannot be resolved', async () => {
    const api = createMockApi('') as any;
    const tool = createWritePainFlagTool(api);

    const result = await tool.execute('test-3', { reason: 'Test error' });

    expect(result.content[0].text).toContain('❌');
    expect(result.content[0].text).toContain('workspace');
    expect(api._logs.some((l: any) => l.level === 'error')).toBe(true);
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

  it('provides clear failure feedback with error message', async () => {
    const api = createMockApi(workspaceDir) as any;
    // Simulate workspace resolution failure by removing the config
    (api as any).config = {};

    const tool = createWritePainFlagTool(api);
    const result = await tool.execute('test-7', { reason: 'Should fail' });

    expect(result.content[0].text).toContain('❌');
    expect(result.content[0].text).toContain('workspace');
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
});
