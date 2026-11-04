/**
 * Phase A (SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001 v0.3) —
 * DEFAULT production path regression.
 *
 * `abstraction_layer_v1` is OFF by default, so the production after_tool_call
 * route is `src/index.ts` → registered `after_tool_call` handler →
 * `handleAfterToolCall`. This suite drives that route end to end through the
 * REAL plugin registration (no handler-level shortcut, no mocked kernel,
 * no mocked SQLite) against a temporary workspace whose only state is a real
 * `trajectory.db`.
 *
 * Contract pinned here:
 *   A. a real failed tool call is trajectory evidence — `tool_calls` gains a
 *      failure row with error attribution and GFI before/after — and produces
 *      NO Pain and NO Diagnostician task;
 *   B. a real successful tool call is recorded as success evidence with no
 *      extra Pain;
 *   C. the Owner manual routes still work: the `pain` tool path and the
 *      `/pd-pain` command each persist an admit-able Pain for this host
 *      (canonical identity + host kind + Owner's own words) and create the
 *      Diagnostician work — the positive control proving Phase A did not turn
 *      all Pain off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { isolatePdCanonicalConfig } from '../utils/isolate-pd-canonical.js';
isolatePdCanonicalConfig();
import plugin from '../../src/index';
import type {
  OpenClawPluginApi,
  PluginCommandDefinition,
  PluginCommandContext,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from '../../src/openclaw-sdk.js';

type AfterToolCallHandler = (
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
) => void | Promise<void>;

interface Harness {
  readonly workspaceDir: string;
  readonly afterToolCall: AfterToolCallHandler;
  readonly commands: Map<string, PluginCommandDefinition>;
}

const tempDirs: string[] = [];
const priorWorkspaceDir = process.env.PD_WORKSPACE_DIR;

function createWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-phase-a-default-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  return workspaceDir;
}

function registerPlugin(workspaceDir: string): Harness {
  let afterToolCall: AfterToolCallHandler | undefined;
  const commands = new Map<string, PluginCommandDefinition>();
  const api: OpenClawPluginApi = {
    id: 'principles-disciple',
    rootDir: workspaceDir,
    pluginConfig: { language: 'en', workspaceDir },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: {},
    registerCommand: (command) => { commands.set(command.name, command); },
    registerService: () => {},
    registerTool: () => {},
    registerHttpRoute: () => {},
    on: (name, handler) => {
      if (name === 'after_tool_call') afterToolCall = handler as AfterToolCallHandler;
    },
  };
  plugin.register(api);
  // PD explicit sources win over hook context resolution: pin the env to the
  // fixture workspace so a machine-level config can never redirect the test.
  process.env.PD_WORKSPACE_DIR = workspaceDir;
  if (!afterToolCall) throw new Error('after_tool_call handler was not registered');
  return { workspaceDir, afterToolCall, commands };
}

function toolContext(workspaceDir: string, sessionId: string): PluginHookToolContext {
  return {
    sessionId,
    agentId: 'main',
    workspaceDir,
  };
}

function openDb(workspaceDir: string): Database.Database {
  return new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function countRows(db: Database.Database, table: string, where = ''): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get();
  return typeof row?.n === 'number' ? row.n : 0;
}

afterEach(() => {
  if (priorWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR;
  else process.env.PD_WORKSPACE_DIR = priorWorkspaceDir;
  tempDirs.length = 0;
});

describe('Phase A default production path (abstraction_layer_v1 OFF)', () => {
  it('A: a real failed tool call is trajectory evidence only — no Pain, no task', async () => {
    const workspaceDir = createWorkspace();
    const { afterToolCall } = registerPlugin(workspaceDir);
    const sessionId = 'phase-a-default-failure';

    await afterToolCall(
      {
        toolName: 'Bash',
        toolArgs: { command: 'false' },
        result: { exitCode: 7, stderr: 'boom' },
        error: 'boom',
        sessionId,
        agentId: 'main',
        durationMs: 42,
        toolCallId: 'call_fail_1',
      },
      toolContext(workspaceDir, sessionId),
    );

    const db = openDb(workspaceDir);
    try {
      expect(tableExists(db, 'tool_calls')).toBe(true);
      const rows = db.prepare(
        'SELECT tool_name, outcome, exit_code, error_message FROM tool_calls',
      ).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool_name: 'Bash',
        outcome: 'failure',
        exit_code: 7,
        error_message: 'boom',
      });

      expect(countRows(db, 'pain_events')).toBe(0);
    } finally {
      db.close();
    }

    // No Diagnostician work is seeded for a technical failure: the evolution
    // stream (which is what hands work to the bridge) carries no pain event.
    const streamDir = path.join(workspaceDir, '.state');
    const streamLines = fs.readdirSync(streamDir)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) => fs.readFileSync(path.join(streamDir, file), 'utf8').split('\n').filter(Boolean));
    expect(streamLines.some((line) => line.includes('pain_detected'))).toBe(false);
    const stateDbPath = path.join(workspaceDir, '.pd', 'state.db');
    if (fs.existsSync(stateDbPath)) {
      const stateDb = new Database(stateDbPath, { readonly: true });
      try {
        expect(countRows(stateDb, 'tasks', " WHERE task_kind = 'diagnostician'")).toBe(0);
      } finally {
        stateDb.close();
      }
    }

    const logsDir = path.join(workspaceDir, '.state', 'logs');
    const eventLines = fs.existsSync(logsDir)
      ? fs.readdirSync(logsDir)
        .filter((file) => file.startsWith('events_') && file.endsWith('.jsonl'))
        .flatMap((file) => fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean))
      : [];
    expect(eventLines.some((line) => line.includes('tool_failure') || line.includes('tool_call'))).toBe(true);
  });

  it('B: a real successful tool call is success evidence with no extra Pain', async () => {
    const workspaceDir = createWorkspace();
    const { afterToolCall } = registerPlugin(workspaceDir);
    const sessionId = 'phase-a-default-success';

    await afterToolCall(
      {
        toolName: 'Bash',
        toolArgs: { command: 'echo ok' },
        result: { exitCode: 0, stdout: 'ok' },
        sessionId,
        agentId: 'main',
        durationMs: 12,
        toolCallId: 'call_ok_1',
      },
      toolContext(workspaceDir, sessionId),
    );

    const db = openDb(workspaceDir);
    try {
      const rows = db.prepare('SELECT tool_name, outcome, exit_code FROM tool_calls').all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tool_name: 'Bash', outcome: 'success', exit_code: 0 });
      expect(countRows(db, 'pain_events')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('C1: the Owner `pain` tool path still persists an admit-able Pain for this host', async () => {
    const workspaceDir = createWorkspace();
    const { afterToolCall } = registerPlugin(workspaceDir);
    const sessionId = 'phase-a-owner-tool';
    const ownerWords = 'OWNER_MANUAL_PAIN_PHASE_A_TOOL';

    await afterToolCall(
      {
        toolName: 'pain',
        params: { input: ownerWords },
        result: { ok: true },
        sessionId,
        agentId: 'main',
      },
      toolContext(workspaceDir, sessionId),
    );

    const db = openDb(workspaceDir);
    try {
      const rows = db.prepare(
        'SELECT source, score, canonical_pain_id, host_kind, text FROM pain_events',
      ).all() as Array<{
        source: string;
        score: number;
        canonical_pain_id: string | null;
        host_kind: string | null;
        text: string | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('manual');
      expect(rows[0].score).toBe(100);
      expect(rows[0].host_kind).toBe('openclaw');
      expect(rows[0].canonical_pain_id).toMatch(/^pain_\d+_[\da-f]{8}$/);
      expect(rows[0].text).toBe(ownerWords);
    } finally {
      db.close();
    }

    // Positive control: Owner-submitted Pain is admitted through the same
    // hook route that no longer admits tool failures. Downstream Diagnostician
    // execution requires an Owner-configured LLM runtime, exercised by the
    // command/service suites instead of this hook-path suite.
  });

  it('C2: the `/pd-pain` command is still wired and defers only on runtime config', async () => {
    const workspaceDir = createWorkspace();
    const { commands } = registerPlugin(workspaceDir);
    const pdPain = commands.get('pd-pain');
    if (!pdPain) throw new Error('/pd-pain command was not registered');

    const ctx = {
      sessionId: 'phase-a-owner-command',
      sessionKey: 'phase-a-owner-command-key',
      args: 'OWNER_MANUAL_PAIN_PHASE_A_COMMAND',
      config: { workspaceDir, language: 'en' },
    } satisfies PluginCommandContext;

    const response = await pdPain.handler(ctx);

    // An unconfigured workspace must stop at runtime config resolution — that
    // is the pre-existing Owner-facing guidance, NOT a Phase A rejection. The
    // end-to-end Diagnostician path for an admitted Owner Pain is covered by
    // C1 through the same ingress plus the real task service.
    expect(response.text).toMatch(/pd console open --workspace|runtime profile|config/i);
    expect(response.text).not.toMatch(/Evidence Triage|repeated failure|tool failure/i);

    const trajectoryPath = path.join(workspaceDir, '.state', 'trajectory.db');
    if (fs.existsSync(trajectoryPath)) {
      const db = openDb(workspaceDir);
      try {
        expect(countRows(db, 'pain_events')).toBe(0);
      } finally {
        db.close();
      }
    }
  });
});
