/**
 * PRI-957 review P1 — the write side of the workspace chain.
 *
 * `pd pain record` resolves its target through the same global
 * `resolveWorkspaceDir` chain as the read commands, so the new cwd step does not
 * only decide which library a query hits: it decides which library a write
 * mutates. That is the intended governance decision (standing in a workspace
 * means operating on it), and this file pins both halves of it against the REAL
 * resolution function:
 *
 *   1. an inferred cwd workspace becomes the write target of PainToPrincipleService
 *      and of the ledger adapter's state dir;
 *   2. the inferred target is announced on stderr by the resolution stage, so the
 *      operator is never left guessing which library was written
 *      (rc-9-no-silent-fallback);
 *   3. an explicit -w keeps its precedence and stays quiet;
 *   4. a config that exists but cannot be parsed is UNKNOWN, not undeclared: with no
 *      override the write is refused outright, and an explicit -w still wins
 *      (PRI-957 review round 3 P1 — pain-record's own config-load failure only
 *      warns and uses defaults, so resolution is the only gate that can stop it).
 *
 * The service is mocked exactly as in pain-record.test.ts — this is a wiring
 * test (cli-7), not a service contract test. It proves which target the write is
 * aimed at and that no service is constructed when resolution refuses; it does not
 * prove a full Pain record commits end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { discoveryRef, serviceCalls } = vi.hoisted(() => ({
  discoveryRef: {
    current: null as import('../../src/services/pd-config-loader.js').WorkspaceDiscoveryResult | null,
  },
  serviceCalls: [] as { ctor: Record<string, unknown>; recordPain: unknown }[],
}));

vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({
    ok: true,
    effective: { config: {}, source: 'defaults', warnings: [] },
    source: 'defaults',
    configPath: '/mocked/.pd/config.yaml',
    warnings: [],
    legacyFilesDetected: [],
  }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue({ flags: {}, enabledChannels: [], warnings: [] }),
  discoverWorkspaceDefault: vi.fn(() => discoveryRef.current),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    // Keep the fixture helpers (mkdtempSync/realpathSync/rmSync) usable while the
    // production path still sees "no such file", as in pain-record.test.ts.
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
  };
});

vi.mock('../../src/commands/build-trajectory-evidence.js', () => ({
  acquireCodexToolFailureEvidenceFromDb: vi.fn().mockReturnValue({
    status: 'unavailable',
    reasonCode: 'empty_trajectory',
    detail: 'codex_tool_calls_empty',
    binding: 'unverified',
  }),
  acquireTrajectoryEvidenceFromDb: vi.fn().mockReturnValue({
    status: 'available',
    entries: [{ sourceRef: 'owner_message:2026-01-01T10:00:00Z', note: 'Owner correction' }],
  }),
}));

vi.mock('@principles/core/runtime-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/core/runtime-v2')>();
  return {
    ...actual,
    PainToPrincipleService: vi.fn().mockImplementation(function (options: Record<string, unknown>) {
      serviceCalls.push({ ctor: options, recordPain: null });
      return {
        recordPain: vi.fn(async (input: unknown) => {
          serviceCalls[serviceCalls.length - 1].recordPain = input;
          return {
            status: 'succeeded',
            painId: 'manual_123_abc',
            taskId: 'diagnosis_manual_123_abc',
            runId: 'run-001',
            artifactId: 'art-001',
            candidateIds: ['c1'],
            ledgerEntryIds: ['l1'],
            observabilityWarnings: [],
            latencyMs: 1,
          };
        }),
      };
    }),
    PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function (options: Record<string, unknown>) {
      return { ctor: options };
    }),
    computeEffectivePdConfig: vi.fn().mockReturnValue({}),
    resolveRuntimeConfig: vi.fn().mockReturnValue({
      runtimeKind: 'pi-ai',
      provider: 'test-provider',
      model: 'test-model',
      apiKeyEnv: 'TEST_KEY',
      timeoutMs: 300000,
      agentId: 'main',
    }),
    isRuntimeConfigError: vi.fn().mockReturnValue(false),
    isBuiltinPiAiProvider: vi.fn().mockReturnValue(true),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
    isFeatureEnabled: vi.fn().mockReturnValue(false),
  };
});

import { handlePainRecord } from '../../src/commands/pain-record.js';

const ORIGINAL_ENV = process.env.PD_WORKSPACE_DIR;

let workRoot: string;
let stderrLines: string[] = [];

beforeEach(() => {
  workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-957-write-')));
  serviceCalls.length = 0;
  discoveryRef.current = null;
  delete process.env.PD_WORKSPACE_DIR;
  stderrLines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrLines.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ENV !== undefined) {
    process.env.PD_WORKSPACE_DIR = ORIGINAL_ENV;
  }
  fs.rmSync(workRoot, { recursive: true, force: true });
});

function stderrText(): string {
  return stderrLines.join('');
}

describe('pd pain record — write target follows the workspace resolution chain (PRI-957 P1)', () => {
  it('writes into the workspace inferred from the current directory and says so', async () => {
    const inferred = path.join(workRoot, 'codex-ws');
    discoveryRef.current = {
      kind: 'resolved',
      workspaceDefault: inferred,
      configPath: path.join(inferred, '.pd', 'config.yaml'),
      source: 'cwd',
      declared: false,
    };

    await handlePainRecord({ reason: 'owner reported pain' });

    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0].ctor.workspaceDir).toBe(inferred);
    expect(serviceCalls[0].ctor.stateDir).toBe(`${inferred}/.state`);
    expect(stderrText()).toContain(`using workspace "${inferred}"`);
    expect(stderrText()).toContain('no workspace.default declared');
  });

  it('does not announce a target the operator declared, or one an override chose', async () => {
    const declared = path.join(workRoot, 'declared-ws');
    discoveryRef.current = {
      kind: 'resolved',
      workspaceDefault: declared,
      configPath: path.join(workRoot, 'somewhere', '.pd', 'config.yaml'),
      source: 'cwd',
      declared: true,
    };
    await handlePainRecord({ reason: 'declared default', workspace: declared });

    expect(serviceCalls[0].ctor.workspaceDir).toBe(declared);
    expect(stderrText()).not.toContain('using workspace');
  });

  it('writes into the -w target when one is given even if cwd discovery points elsewhere', async () => {
    const explicit = path.join(workRoot, 'explicit-ws');
    discoveryRef.current = {
      kind: 'resolved',
      workspaceDefault: path.join(workRoot, 'standing-here'),
      configPath: path.join(workRoot, 'standing-here', '.pd', 'config.yaml'),
      source: 'cwd',
      declared: false,
    };

    await handlePainRecord({ reason: 'explicit target', workspace: explicit });

    expect(serviceCalls[0].ctor.workspaceDir).toBe(explicit);
    expect(stderrText()).not.toContain('using workspace');
  });

  it('refuses to write anywhere when no workspace can be resolved (cli-5)', async () => {
    discoveryRef.current = null;

    await expect(handlePainRecord({ reason: 'no workspace' })).rejects.toThrow(/No workspace directory configured/);
    expect(serviceCalls).toHaveLength(0);
  });

  // PRI-957 review round 3 P1 — the case the review found missing. A config that
  // EXISTS but cannot be parsed leaves workspace.default unknown; before this fix the
  // chain fell through to "the directory you are standing in" and pain-record wrote
  // there (its own config-load failure only prints a warning and uses defaults).
  it('refuses to write when the standing config exists but cannot be parsed (cli-5)', async () => {
    const standing = path.join(workRoot, 'broken-ws');
    discoveryRef.current = {
      kind: 'unparseable',
      configPath: path.join(standing, '.pd', 'config.yaml'),
      source: 'cwd',
      reason: 'bad indentation at line 2',
    };

    await expect(handlePainRecord({ reason: 'broken config' })).rejects.toThrow(
      /Cannot resolve a workspace directory/,
    );
    expect(serviceCalls).toHaveLength(0);
  });

  // An explicit override is the operator stating the target themselves, so it keeps
  // precedence even when the standing config is unreadable — and says which target won.
  it('still writes into an explicit -w target when the standing config cannot be parsed', async () => {
    const explicit = path.join(workRoot, 'explicit-ws');
    discoveryRef.current = {
      kind: 'unparseable',
      configPath: path.join(workRoot, 'broken-ws', '.pd', 'config.yaml'),
      source: 'cwd',
      reason: 'bad indentation at line 2',
    };

    await handlePainRecord({ reason: 'broken config, explicit target', workspace: explicit });

    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0].ctor.workspaceDir).toBe(explicit);
    expect(stderrText()).toContain(`using workspace "${explicit}" from --workspace`);
    expect(stderrText()).toContain('could not be parsed');
  });
});
