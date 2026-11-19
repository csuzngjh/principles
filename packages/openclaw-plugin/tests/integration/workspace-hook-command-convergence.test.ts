/**
 * PRI-686: hook-write / command-read workspace convergence — REAL database round-trip.
 *
 * The live 2026-09-05 incident: on OpenClaw 2026.8/9 multi-agent layouts with
 * a custom workspace root, the hook chain resolved the PD canonical root
 * (PRI-259 explicit priority) while the command chain trusted ctx.workspaceDir
 * (= <root>/main). Hooks wrote trajectory.db under the root; /pd-pain read a
 * parallel empty tree under main/ → every candidate gated needs_evidence /
 * empty_trajectory with no error pointing at the cause.
 *
 * This integration test locks BOTH halves together against a real SQLite
 * trajectory DB — stronger than the unit-level convergence test in
 * hook-workspace-resolver.test.ts, which only compares resolver return
 * values without proving the two chains hit the same physical database.
 *
 * Invariants:
 * 1. Hook-side resolution (resolveHookWorkspaceDir) and command-side
 *    resolution (resolveCommandWorkspaceDir / resolvePluginCommandWorkspaceDir)
 *    return the same directory even when the OpenClaw session context points
 *    at a divergent sub-workspace.
 * 2. A trajectory row written through the hook-resolved workspace is
 *    readable through the command-resolved workspace (same DB file).
 * 3. Divergence is warned on the command path, never silent (rc-9).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// PRI-686: register the os mock BEFORE importing src modules so the
// "no PD explicit source" control row cannot fall through to the dev
// machine's real ~/.openclaw/principles-disciple.json.
import { isolatePdCanonicalConfig } from '../utils/isolate-pd-canonical.js';
isolatePdCanonicalConfig();
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveHookWorkspaceDir,
  resolveCommandWorkspaceDir,
  resolvePluginCommandWorkspaceDir,
} from '../../src/utils/workspace-resolver.js';
import { TrajectoryRegistry } from '../../src/core/trajectory.js';

let pdCanonicalRoot: string;
let agentSubWorkspace: string;
let convHome: string;
const originalEnv = { ...process.env };

const logger = {
  debug: () => {},
  info: () => {},
  warn: vi.fn(),
  error: vi.fn(),
};

const api = {
  runtime: {
    agent: {
      resolveAgentWorkspaceDir: vi.fn(),
    },
  },
  config: {},
  logger,
};

beforeEach(() => {
  process.env = { ...originalEnv };
  // The scenario is "NO PD explicit source": a dev machine's inherited
  // PD_WORKSPACE_DIR (or a real ~/.openclaw/principles-disciple.json reached
  // through the HOME-first authority) would win Priority 1 over the ctx
  // fallback this test pins. Both declaration channels are cleared, and HOME
  // moves to its own isolated dir (NOT the fixture workspace root — a
  // declared workspace equal to the home directory is rejected by
  // validateWorkspaceDir).
  delete process.env.PD_WORKSPACE_DIR;
  delete process.env.OPENCLAW_WORKSPACE;
  process.env.HOME = convHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-conv-home-'));
  pdCanonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-conv-root-'));
  // Simulate the OpenClaw 2026.8/9 layout: session context points at the
  // main sub-workspace while PD canonical is pinned to the root.
  agentSubWorkspace = path.join(pdCanonicalRoot, 'main');
  fs.mkdirSync(agentSubWorkspace, { recursive: true });
});

afterEach(() => {
  TrajectoryRegistry.clear();
  process.env = { ...originalEnv };
  fs.rmSync(pdCanonicalRoot, { recursive: true, force: true });
  fs.rmSync(convHome, { recursive: true, force: true });
});

describe('hook-write / command-read workspace convergence (PRI-686, real DB)', () => {
  it('trajectory written via hook-resolved workspace is readable via command-resolved workspace', () => {
    // This scenario pins an Owner DECLARED workspace (Priority 1): the env
    // declaration wins over the live session context, and the divergence is
    // warned, never silent. Set it here — beforeEach clears declaration env
    // so the no-explicit-source sibling can exercise the ctx fallback.
    process.env.PD_WORKSPACE_DIR = pdCanonicalRoot;
    try {
    // ── hook side: resolve exactly as index.ts before_message_write does ──
    const hookWs = resolveHookWorkspaceDir(
      { workspaceDir: agentSubWorkspace, sessionId: 's-conv-1' },
      api as never,
      'before_message_write',
    );
    expect(hookWs.ok).toBe(true);
    if (!hookWs.ok) throw new Error('hook resolution failed');
    expect(hookWs.workspaceDir).toBe(path.resolve(pdCanonicalRoot));

    // Hook path writes a real user turn through the shared registry
    const hookTrajectory = TrajectoryRegistry.get(hookWs.workspaceDir);
    const turnId = hookTrajectory.recordUserTurn({
      sessionId: 's-conv-1',
      turnIndex: 1,
      rawText: 'Owner correction text',
      correctionDetected: true,
    });
    expect(turnId).toBeGreaterThan(0);

    // ── command side: resolve with a DIVERGENT ctx (the incident shape) ──
    const cmdWs = resolveCommandWorkspaceDir(api as never, { workspaceDir: agentSubWorkspace });
    expect(path.resolve(cmdWs)).toBe(path.resolve(pdCanonicalRoot));
    // Divergence warned, never silent (rc-9)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('differs from OpenClaw context'));

    const pluginCmdWs = resolvePluginCommandWorkspaceDir(
      { workspaceDir: agentSubWorkspace, config: {}, sessionId: 's-conv-1' } as never,
      'pain-report',
      { warn: logger.warn },
    );
    expect(path.resolve(pluginCmdWs)).toBe(path.resolve(pdCanonicalRoot));

    // ── read back through the command-resolved workspace: same physical DB ──
    const cmdTrajectory = TrajectoryRegistry.get(cmdWs);
    const turns = cmdTrajectory.listUserTurnsForSession('s-conv-1');
    expect(turns.length).toBe(1);
    expect(turns[0]?.correctionDetected).toBe(true);
    } finally {
      // Restore the no-explicit-source baseline the beforeEach pins.
      delete process.env.PD_WORKSPACE_DIR;
    }
  });

  it('command path with no PD explicit source falls back to ctx.workspaceDir and still round-trips', () => {
    // Control: without PD explicit sources, the command chain uses the
    // session context — hook (explicit-first) and command agree only when
    // ctx matches. This row pins the non-split baseline behavior.
    delete process.env.PD_WORKSPACE_DIR;
    delete process.env.OPENCLAW_WORKSPACE;

    const hookWs = resolveHookWorkspaceDir(
      { workspaceDir: agentSubWorkspace, sessionId: 's-conv-2' },
      api as never,
      'before_message_write',
    );
    expect(hookWs.ok).toBe(true);
    if (!hookWs.ok) throw new Error('hook resolution failed');
    // No explicit sources → hook falls through to OpenClaw context
    expect(hookWs.workspaceDir).toBe(agentSubWorkspace);

    const cmdWs = resolveCommandWorkspaceDir(api as never, { workspaceDir: agentSubWorkspace });
    expect(cmdWs).toBe(agentSubWorkspace);

    const t = TrajectoryRegistry.get(cmdWs);
    t.recordUserTurn({
      sessionId: 's-conv-2',
      turnIndex: 1,
      rawText: 'x',
      correctionDetected: false,
    });
    const turns = t.listUserTurnsForSession('s-conv-2');
    expect(turns.length).toBe(1);
  });
});
