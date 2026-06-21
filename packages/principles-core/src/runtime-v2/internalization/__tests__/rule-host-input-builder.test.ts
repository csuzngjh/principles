/**
 * PRI-439 Phase 3: Unified production input — pure normalizePath + action builder
 *
 * Golden Trace and OpenClaw Gate must produce the SAME `normalizedPath` for
 * 6 path types. This file tests the pure extraction + normalization logic
 * that both paths must share.
 *
 * 6 path types:
 *   1. Absolute POSIX  (/project/src/index.ts, /project)
 *   2. Absolute Windows (D:\project\src\index.ts, D:\project)
 *   3. Relative bare    (src/index.ts, /project)
 *   4. Relative ./      (./src/index.ts, /project)
 *   5. Relative ../     (../src/index.ts, /project) — escapes project
 *   6. Empty/null       (null / '' / undefined, /project)
 */
import { describe, it, expect } from 'vitest';

// ── normalizePathPure: 6 path types ──────────────────────────────────────────

describe('PRI-439 Phase 3: normalizePathPure — 6 path types', () => {
  async function getModule() {
    return import('../rule-host-input-builder.js');
  }

  // ── Type 1: Absolute POSIX ───────────────────────────────────────────────

  it('type 1: absolute POSIX path relativizes to project dir', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('/project/src/index.ts', '/project')).toBe('src/index.ts');
  });

  it('type 1: absolute POSIX path outside project returns original', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('/etc/passwd', '/project')).toBe('/etc/passwd');
  });

  // ── Type 2: Absolute Windows ─────────────────────────────────────────────

  it('type 2: absolute Windows path relativizes to Windows project dir', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('D:\\project\\src\\index.ts', 'D:\\project')).toBe('src/index.ts');
  });

  it('type 2: absolute Windows path with forward slashes also works', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('D:/project/src/index.ts', 'D:/project')).toBe('src/index.ts');
  });

  // ── Type 3: Relative bare ────────────────────────────────────────────────

  it('type 3: relative bare path stays as-is when within project', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('src/index.ts', '/project')).toBe('src/index.ts');
  });

  // ── Type 4: Relative ./ ──────────────────────────────────────────────────

  it('type 4: relative ./ path normalizes to bare relative', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('./src/index.ts', '/project')).toBe('src/index.ts');
  });

  // ── Type 5: Relative ../ (escapes project) ───────────────────────────────

  it('type 5: relative ../ that escapes project returns original', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('../src/index.ts', '/project')).toBe('../src/index.ts');
  });

  it('type 5: relative ../../ that escapes project returns original', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('../../src/index.ts', '/project')).toBe('../../src/index.ts');
  });

  // ── Type 6: Empty/null ───────────────────────────────────────────────────

  it('type 6: null returns empty string', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure(null, '/project')).toBe('');
  });

  it('type 6: undefined returns empty string', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure(undefined, '/project')).toBe('');
  });

  it('type 6: empty string returns empty string', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('', '/project')).toBe('');
  });

  // ── Cross-platform determinism ───────────────────────────────────────────

  it('produces same result for / and \\ separators', async () => {
    const { normalizePathPure } = await getModule();
    const posixResult = normalizePathPure('/project/src/index.ts', '/project');
    const windowsResult = normalizePathPure('D:\\project\\src\\index.ts', 'D:\\project');
    expect(posixResult).toBe('src/index.ts');
    expect(windowsResult).toBe('src/index.ts');
    expect(posixResult).toBe(windowsResult);
  });

  // ── Synthetic paths (production gate uses these for pathless write tools) ─

  it('passes through synthetic <tool:...> paths unchanged', async () => {
    const { normalizePathPure } = await getModule();
    expect(normalizePathPure('<tool:apply_patch>', '/project')).toBe('<tool:apply_patch>');
  });
});

// ── extractFilePathFromParams ────────────────────────────────────────────────

describe('PRI-439 Phase 3: extractFilePathFromParams', () => {
  async function getModule() {
    return import('../rule-host-input-builder.js');
  }

  it('extracts file_path from params', async () => {
    const { extractFilePathFromParams } = await getModule();
    expect(extractFilePathFromParams({ file_path: '/src/index.ts' })).toBe('/src/index.ts');
  });

  it('falls back to path if no file_path', async () => {
    const { extractFilePathFromParams } = await getModule();
    expect(extractFilePathFromParams({ path: '/src/index.ts' })).toBe('/src/index.ts');
  });

  it('falls back to file if no path', async () => {
    const { extractFilePathFromParams } = await getModule();
    expect(extractFilePathFromParams({ file: '/src/index.ts' })).toBe('/src/index.ts');
  });

  it('falls back to target if no file', async () => {
    const { extractFilePathFromParams } = await getModule();
    expect(extractFilePathFromParams({ target: '/src/index.ts' })).toBe('/src/index.ts');
  });

  it('returns null when no path-like param exists', async () => {
    const { extractFilePathFromParams } = await getModule();
    expect(extractFilePathFromParams({ command: 'echo hello' })).toBeNull();
  });

  it('returns null for empty params', async () => {
    const { extractFilePathFromParams } = await getModule();
    expect(extractFilePathFromParams({})).toBeNull();
  });

  it('returns synthetic <tool:...> for pathless write tools', async () => {
    const { extractFilePathFromParams } = await getModule();
    expect(extractFilePathFromParams({}, { isWriteTool: true, toolName: 'apply_patch' })).toBe('<tool:apply_patch>');
  });

  it('extracts file path from bash command mutation regex', async () => {
    const { extractFilePathFromParams } = await getModule();
    const result = extractFilePathFromParams(
      { command: 'rm -rf /tmp/foo' },
      { isBashTool: true },
    );
    expect(result).toBe('/tmp/foo');
  });

  it('returns full bash command when no mutation target found', async () => {
    const { extractFilePathFromParams } = await getModule();
    const result = extractFilePathFromParams(
      { command: 'echo hello' },
      { isBashTool: true },
    );
    expect(result).toBe('echo hello');
  });
});

// ── buildRuleHostAction: unified action snapshot ─────────────────────────────

describe('PRI-439 Phase 3: buildRuleHostAction — unified action snapshot', () => {
  async function getModule() {
    return import('../rule-host-input-builder.js');
  }

  it('produces action with toolName, normalizedPath, paramsSummary', async () => {
    const { buildRuleHostAction } = await getModule();
    const action = buildRuleHostAction('write', { file_path: '/project/src/index.ts' }, '/project');
    expect(action.toolName).toBe('write');
    expect(action.normalizedPath).toBe('src/index.ts');
    expect(action.paramsSummary).toEqual({ file_path: '/project/src/index.ts' });
  });

  it('produces empty normalizedPath for null path', async () => {
    const { buildRuleHostAction } = await getModule();
    const action = buildRuleHostAction('write', {}, '/project');
    expect(action.normalizedPath).toBe('');
  });

  it('produces synthetic path for pathless write tool', async () => {
    const { buildRuleHostAction } = await getModule();
    const action = buildRuleHostAction('apply_patch', {}, '/project', { isWriteTool: true });
    expect(action.normalizedPath).toBe('<tool:apply_patch>');
  });

  it('produces same normalizedPath as direct normalizePathPure call', async () => {
    const { buildRuleHostAction, normalizePathPure } = await getModule();
    const action = buildRuleHostAction('edit', { file_path: '/project/src/test.ts' }, '/project');
    const direct = normalizePathPure('/project/src/test.ts', '/project');
    expect(action.normalizedPath).toBe(direct);
  });
});

// ── Golden Trace replay uses normalizePathPure (integration) ──────────────────

describe('PRI-439 Phase 3: Golden Trace replay produces non-null normalizedPath', () => {
  it('createSyntheticRuleHostInput with projectDir produces normalized path from params', async () => {
    const { createSyntheticRuleHostInput } = await import('../../golden-trace.js');
    const input = createSyntheticRuleHostInput(
      { toolName: 'write', params: { file_path: '/project/src/secrets.env' } },
      {},
      { projectDir: '/project' },
    );
    expect(input.action.normalizedPath).toBe('src/secrets.env');
    expect(input.action.normalizedPath).not.toBeNull();
  });

  it('createSyntheticRuleHostInput without projectDir falls back to null (backwards compat)', async () => {
    const { createSyntheticRuleHostInput } = await import('../../golden-trace.js');
    const input = createSyntheticRuleHostInput(
      { toolName: 'write', params: { file_path: '/project/src/secrets.env' } },
    );
    // Without projectDir, normalizedPath is null (backwards compat with existing callers)
    expect(input.action.normalizedPath).toBeNull();
  });

  it('explicit normalizedPath override takes precedence over projectDir extraction', async () => {
    const { createSyntheticRuleHostInput } = await import('../../golden-trace.js');
    const input = createSyntheticRuleHostInput(
      { toolName: 'write', params: { file_path: '/project/src/secrets.env' } },
      { normalizedPath: 'custom/path.ts' },
      { projectDir: '/project' },
    );
    expect(input.action.normalizedPath).toBe('custom/path.ts');
  });
});
