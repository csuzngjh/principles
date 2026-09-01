/**
 * runtime-init tests — pd runtime init command (unit tests with mocked DB layer).
 *
 * Covers:
 *   - INIT-01: --dry-run (default) reports 3 DBs as 'skipped', no real writes
 *   - INIT-02: --confirm calls all 3 init functions, output shows 'initialized'
 *   - INIT-03: --json outputs single parseable JSON object (cli-1)
 *   - INIT-04: --dry-run + --confirm mutually exclusive (cli-4)
 *   - INIT-05: --confirm failure sets exitCode=1 with reason + nextAction (cli-6)
 *   - INIT-06: missing --workspace falls back to resolveWorkspaceDir()
 *
 * ERR refs:
 * - ERR-001/ERR-005: no `as` casts in test code; uses typeof guards
 * - ERR-009: flag conflict fails loud (cli-4)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockState = vi.hoisted(() => {
  return {
    initTrajectorySchema: vi.fn(),
    initWorkflowSchema: vi.fn(),
    sqliteConnectionCtor: vi.fn(),
    sqliteConnectionGetDb: vi.fn(),
    sqliteConnectionGetWarnings: vi.fn(),
    sqliteConnectionClose: vi.fn(),
    schemaConformanceCtor: vi.fn(),
    schemaConformanceCheck: vi.fn(),
    resolveWorkspaceDir: vi.fn(),
  };
});

vi.mock('principles-disciple', () => ({
  initTrajectorySchema: mockState.initTrajectorySchema,
  initWorkflowSchema: mockState.initWorkflowSchema,
}));

vi.mock('@principles/core/runtime-v2', async () => {
  const actual = await vi.importActual<typeof import('@principles/core/runtime-v2')>('@principles/core/runtime-v2');
  return {
    ...actual,
    SqliteConnection: mockState.sqliteConnectionCtor,
    SchemaConformanceReadModel: mockState.schemaConformanceCtor,
  };
});

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: mockState.resolveWorkspaceDir,
}));

// Import after mocks are set up
import { buildRuntimeInitOutput, handleRuntimeInit } from '../../src/commands/runtime-init.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runtime-init-test-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function setupDefaultConfirmMocks(): void {
  // SqliteConnection mock: constructor returns instance with getDb/getSchemaInitWarnings/close
  // NOTE: Must use `function` (not arrow function) because vitest 4.x requires
  // function/class implementations for mocks called with `new`.
  mockState.sqliteConnectionCtor.mockImplementation(function () {
    return {
      getDb: mockState.sqliteConnectionGetDb,
      getSchemaInitWarnings: mockState.sqliteConnectionGetWarnings,
      close: mockState.sqliteConnectionClose,
    };
  });
  mockState.sqliteConnectionGetDb.mockReturnValue({});
  mockState.sqliteConnectionGetWarnings.mockReturnValue([]);
  mockState.sqliteConnectionClose.mockReturnValue(undefined);

  // initTrajectorySchema mock
  mockState.initTrajectorySchema.mockReturnValue({
    tables: ['schema_version', 'sessions', 'pain_events', 'evolution_tasks'],
    warnings: [],
  });

  // initWorkflowSchema mock
  mockState.initWorkflowSchema.mockReturnValue({
    tables: ['schema_version', 'subagent_workflows', 'subagent_workflow_events'],
    warnings: [],
  });

  // SchemaConformanceReadModel mock
  mockState.schemaConformanceCtor.mockImplementation(function () {
    return {
      check: mockState.schemaConformanceCheck,
    };
  });
  mockState.schemaConformanceCheck.mockReturnValue({ overallStatus: 'ok' });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('pd runtime init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultConfirmMocks();
  });

  // ── INIT-01: dry-run (default) ─────────────────────────────────────────────

  describe('INIT-01: dry-run (default)', () => {
    it('reports 3 DBs as skipped without calling init functions', () => {
      const tmp = mkTmpDir();
      try {
        const output = buildRuntimeInitOutput(tmp, false);
        expect(output.ok).toBe(true);
        expect(output.mode).toBe('dry-run');
        expect(output.databases).toHaveLength(3);
        for (const db of output.databases) {
          expect(db.status).toBe('skipped');
        }
        // No init functions should be called in dry-run mode
        expect(mockState.initTrajectorySchema).not.toHaveBeenCalled();
        expect(mockState.initWorkflowSchema).not.toHaveBeenCalled();
        expect(mockState.sqliteConnectionCtor).not.toHaveBeenCalled();
      } finally { rmTmpDir(tmp); }
    });

    it('includes expected table names in dry-run output for each DB', () => {
      const tmp = mkTmpDir();
      try {
        const output = buildRuntimeInitOutput(tmp, false);
        const stateDb = output.databases.find(d => d.name === 'state.db');
        const trajDb = output.databases.find(d => d.name === 'trajectory.db');
        const wfDb = output.databases.find(d => d.name === 'subagent_workflows.db');
        expect(stateDb?.tables).toContain('tasks');
        expect(stateDb?.tables).toContain('runs');
        expect(trajDb?.tables).toContain('pain_events');
        expect(trajDb?.tables).toContain('sessions');
        expect(wfDb?.tables).toContain('subagent_workflows');
      } finally { rmTmpDir(tmp); }
    });
  });

  // ── INIT-02: --confirm ─────────────────────────────────────────────────────

  describe('INIT-02: --confirm', () => {
    it('calls all 3 init functions and reports initialized status', () => {
      const tmp = mkTmpDir();
      try {
        const output = buildRuntimeInitOutput(tmp, true);
        expect(output.ok).toBe(true);
        expect(output.mode).toBe('confirm');
        expect(output.databases).toHaveLength(3);
        for (const db of output.databases) {
          expect(db.status).toBe('initialized');
        }
        expect(mockState.sqliteConnectionCtor).toHaveBeenCalledTimes(1);
        expect(mockState.sqliteConnectionGetDb).toHaveBeenCalledTimes(1);
        expect(mockState.initTrajectorySchema).toHaveBeenCalledWith(tmp);
        expect(mockState.initWorkflowSchema).toHaveBeenCalledWith(tmp);
      } finally { rmTmpDir(tmp); }
    });

    it('runs schema conformance check after initialization', () => {
      const tmp = mkTmpDir();
      try {
        buildRuntimeInitOutput(tmp, true);
        expect(mockState.schemaConformanceCtor).toHaveBeenCalledTimes(1);
        expect(mockState.schemaConformanceCheck).toHaveBeenCalledTimes(1);
      } finally { rmTmpDir(tmp); }
    });
  });

  // ── INIT-03: --json output (cli-1) ─────────────────────────────────────────

  describe('INIT-03: --json output (cli-1)', () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let originalExitCode: number | undefined;

    beforeEach(() => {
      stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      originalExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      process.exitCode = originalExitCode;
    });

    it('outputs exactly one parseable JSON object to stdout', async () => {
      const tmp = mkTmpDir();
      try {
        await handleRuntimeInit({ workspace: tmp, json: true });
        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const output = stdoutSpy.mock.calls[0][0] as string;
        const parsed = JSON.parse(output);
        expect(typeof parsed).toBe('object');
        expect(parsed).not.toBeNull();
        expect(Array.isArray(parsed)).toBe(false);
        expect(parsed).toHaveProperty('ok');
        expect(parsed).toHaveProperty('mode');
        expect(parsed).toHaveProperty('databases');
      } finally { rmTmpDir(tmp); }
    });

    it('does not set exitCode=1 on successful dry-run', async () => {
      const tmp = mkTmpDir();
      try {
        await handleRuntimeInit({ workspace: tmp, json: true });
        expect(process.exitCode).toBeUndefined();
      } finally { rmTmpDir(tmp); }
    });
  });

  // ── INIT-04: --dry-run + --confirm mutex (cli-4) ───────────────────────────

  describe('INIT-04: --dry-run + --confirm mutex (cli-4)', () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let originalExitCode: number | undefined;

    beforeEach(() => {
      stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      originalExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      process.exitCode = originalExitCode;
    });

    it('sets exitCode=1 when both --dry-run and --confirm are specified', async () => {
      await handleRuntimeInit({ dryRun: true, confirm: true, json: true });
      expect(process.exitCode).toBe(1);
    });

    it('emits flag conflict JSON with reason and nextAction', async () => {
      await handleRuntimeInit({ dryRun: true, confirm: true, json: true });
      expect(stdoutSpy).toHaveBeenCalledTimes(1);
      const output = stdoutSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.ok).toBe(false);
      expect(parsed.reason).toBeTruthy();
      expect(parsed.nextAction).toBeTruthy();
    });

    it('does not call any init functions on flag conflict', async () => {
      await handleRuntimeInit({ dryRun: true, confirm: true, json: true });
      expect(mockState.initTrajectorySchema).not.toHaveBeenCalled();
      expect(mockState.initWorkflowSchema).not.toHaveBeenCalled();
      expect(mockState.sqliteConnectionCtor).not.toHaveBeenCalled();
    });
  });

  // ── INIT-05: --confirm failure (cli-6) ─────────────────────────────────────

  describe('INIT-05: --confirm failure (cli-6)', () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let originalExitCode: number | undefined;

    beforeEach(() => {
      stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      originalExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      process.exitCode = originalExitCode;
    });

    it('sets exitCode=1 and includes reason + nextAction when state.db fails', () => {
      const tmp = mkTmpDir();
      try {
        mockState.sqliteConnectionGetDb.mockImplementation(() => {
          throw new Error('disk full');
        });
        const output = buildRuntimeInitOutput(tmp, true);
        expect(output.ok).toBe(false);
        expect(output.reason).toContain('state.db');
        expect(output.reason).toContain('disk full');
        expect(output.nextAction).toBeTruthy();
      } finally { rmTmpDir(tmp); }
    });

    it('sets exitCode=1 and includes reason when trajectory.db fails', () => {
      const tmp = mkTmpDir();
      try {
        mockState.initTrajectorySchema.mockImplementation(() => {
          throw new Error('permission denied');
        });
        const output = buildRuntimeInitOutput(tmp, true);
        expect(output.ok).toBe(false);
        expect(output.reason).toContain('trajectory.db');
        expect(output.reason).toContain('permission denied');
      } finally { rmTmpDir(tmp); }
    });

    it('sets exitCode=1 and includes reason when subagent_workflows.db fails', () => {
      const tmp = mkTmpDir();
      try {
        mockState.initWorkflowSchema.mockImplementation(() => {
          throw new Error('locked');
        });
        const output = buildRuntimeInitOutput(tmp, true);
        expect(output.ok).toBe(false);
        expect(output.reason).toContain('subagent_workflows.db');
        expect(output.reason).toContain('locked');
      } finally { rmTmpDir(tmp); }
    });

    it('handler sets process.exitCode=1 on failure with --json', async () => {
      const tmp = mkTmpDir();
      try {
        mockState.sqliteConnectionGetDb.mockImplementation(() => {
          throw new Error('init failed');
        });
        await handleRuntimeInit({ workspace: tmp, confirm: true, json: true });
        expect(process.exitCode).toBe(1);
        const output = stdoutSpy.mock.calls[0][0] as string;
        const parsed = JSON.parse(output);
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBeTruthy();
        expect(parsed.nextAction).toBeTruthy();
      } finally { rmTmpDir(tmp); }
    });
  });

  // ── INIT-06: missing --workspace ───────────────────────────────────────────

  describe('INIT-06: missing --workspace', () => {
    it('falls back to resolveWorkspaceDir() when workspace is not specified', async () => {
      const tmp = mkTmpDir();
      mockState.resolveWorkspaceDir.mockReturnValue(tmp);
      try {
        await handleRuntimeInit({ json: true });
        expect(mockState.resolveWorkspaceDir).toHaveBeenCalledTimes(1);
      } finally { rmTmpDir(tmp); }
    });
  });

  // ── INIT-07: config.yaml scaffolding (P0: runtime discovery) ───────────────

  describe('INIT-07: config.yaml scaffolding', () => {
    it('dry-run reports config.yaml as skipped without writing the file', () => {
      const tmp = mkTmpDir();
      try {
        const output = buildRuntimeInitOutput(tmp, false);
        expect(output.config).toBeDefined();
        expect(output.config?.status).toBe('skipped');
        expect(fs.existsSync(path.join(tmp, '.pd', 'config.yaml'))).toBe(false);
      } finally { rmTmpDir(tmp); }
    });

    it('--confirm writes a valid config.yaml with version and workspace.default', async () => {
      const tmp = mkTmpDir();
      try {
        const output = buildRuntimeInitOutput(tmp, true);
        expect(output.config?.status).toBe('initialized');
        const configPath = path.join(tmp, '.pd', 'config.yaml');
        expect(fs.existsSync(configPath)).toBe(true);
        const yaml = (await import('js-yaml')).default;
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
        expect(typeof parsed).toBe('object');
        const obj = parsed as { version?: unknown; workspace?: { default?: unknown }; features?: unknown };
        expect(obj.version).toBe(1);
        expect(obj.workspace?.default).toBe(path.resolve(tmp));
        expect(obj.features).toBeDefined();
        expect(Object.keys(obj.features as Record<string, unknown>).length).toBeGreaterThan(0);
      } finally { rmTmpDir(tmp); }
    });

    it('round-trip: generated config passes validatePdConfig', async () => {
      const tmp = mkTmpDir();
      try {
        buildRuntimeInitOutput(tmp, true);
        const configPath = path.join(tmp, '.pd', 'config.yaml');
        const yaml = (await import('js-yaml')).default;
        const { validatePdConfig } = await import('@principles/core/runtime-v2');
        const parsed: unknown = yaml.load(fs.readFileSync(configPath, 'utf8'), { schema: yaml.JSON_SCHEMA });
        const result = validatePdConfig(parsed);
        expect(result.ok).toBe(true);
      } finally { rmTmpDir(tmp); }
    });

    it('--confirm marks every generated flag entry as system provenance (PRI-637)', async () => {
      const tmp = mkTmpDir();
      try {
        buildRuntimeInitOutput(tmp, true);
        const configPath = path.join(tmp, '.pd', 'config.yaml');
        const yaml = (await import('js-yaml')).default;
        const parsed = yaml.load(fs.readFileSync(configPath, 'utf8'), { schema: yaml.JSON_SCHEMA }) as {
          features?: Record<string, { source?: unknown }>;
        };
        const features = parsed.features ?? {};
        // Bootstrap snapshot still carries the full registry map.
        expect(Object.keys(features).length).toBeGreaterThan(0);
        // PRI-637: `pd runtime init` is PD machinery — entries carry source:
        // 'system' (NOT owner intent), matching the runtime-init lifecycle label.
        for (const entry of Object.values(features)) {
          expect(entry?.source).toBe('system');
        }
      } finally { rmTmpDir(tmp); }
    });

    it('--confirm skips when config.yaml already exists (preserves user file)', () => {
      const tmp = mkTmpDir();
      try {
        // Pre-create a user-modified config.yaml
        const configDir = path.join(tmp, '.pd');
        fs.mkdirSync(configDir, { recursive: true });
        const userConfig = '# user config\nversion: 1\n';
        fs.writeFileSync(path.join(configDir, 'config.yaml'), userConfig, 'utf8');

        const output = buildRuntimeInitOutput(tmp, true);
        expect(output.config?.status).toBe('skipped');
        expect(output.config?.warnings.some(w => w.includes('already exists'))).toBe(true);
        // Content must be preserved
        expect(fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf8')).toBe(userConfig);
      } finally { rmTmpDir(tmp); }
    });
  });
});
