import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createCodexRuleContextProvider } from '../../host-runtime/src/codex-rule-context-provider.js';
import { createProductionHostRuntime } from '../../host-runtime/src/index.js';
import { decodeCodexInput } from '../src/codec/input-decoder.js';
import { CODEX_TOOL_SEMANTICS } from '../src/tool-semantics.js';

const roots: string[] = [];

function workspace(): { workspaceDir: string; projectDir: string } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-rule-history-live-'));
  roots.push(workspaceDir);
  const projectDir = workspaceDir;
  const stateDir = path.join(workspaceDir, '.state');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL,
      reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT,
      runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL,
      duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL,
      params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL, tool_use_id TEXT
    );
  `);
  db.close();
  return { workspaceDir, projectDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex live RuleContextV2 history path', () => {
  it('decodes native PostToolUse, persists it through the production writer, and reads it at the next PreToolUse', async () => {
    const { workspaceDir, projectDir } = workspace();
    const noncanonicalProjectDir = `${path.join(projectDir, 'unused', '..')}${path.sep}`;
    const common = {
      session_id: 'native-codex-session',
      turn_id: 'native-codex-turn',
      transcript_path: null,
      cwd: noncanonicalProjectDir,
      model: 'gpt-5.6',
      permission_mode: 'default',
    };
    const decodedPost = decodeCodexInput({
      ...common,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `cat ${path.join(projectDir, 'target.txt')}` },
      tool_response: { exitCode: 0 },
      tool_use_id: 'native-read-call',
    });
    // Match pd-hook: project cwd remains decoded in options, while resolved
    // PD workspace owns the trajectory DB and is attached to HostEvent.context.
    const post = { ...decodedPost, context: { ...decodedPost.context, workspaceDir } };
    const runtime = createProductionHostRuntime({ hostKind: 'codex', projectDir: noncanonicalProjectDir, toolSemantics: CODEX_TOOL_SEMANTICS });
    await runtime.dispatch(post);

    const stored = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    const storedProjectDir: unknown = stored.prepare('SELECT project_dir FROM tool_calls WHERE tool_use_id = ?').get('native-read-call');
    stored.close();
    expect(storedProjectDir).toEqual({ project_dir: path.resolve(projectDir) });

    const decodedPre = decodeCodexInput({
      ...common,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo next' },
      tool_use_id: 'native-next-call',
    });
    const pre = { ...decodedPre, context: { ...decodedPre.context, workspaceDir } };
    const context = createCodexRuleContextProvider({
      workspaceDir,
      projectDir: noncanonicalProjectDir,
      enabled: true,
      toolSemantics: CODEX_TOOL_SEMANTICS,
      cutoffAt: new Date(Date.now() + 1_000),
      currentToolUseId: String(pre.context.toolCallId),
    })({
      workspaceDir,
      sessionId: String(pre.context.sessionId),
      targetPath: 'target.txt',
      toolName: String(pre.context.toolName),
      rawPayload: pre.rawPayload,
    }) as {
      history: { status: string; calls: readonly { toolName: string; outcome: string }[] };
      facts: { priorReadOfTarget: string };
    };
    expect(context.history).toMatchObject({ status: 'available', calls: [{ toolName: 'Bash', outcome: 'success' }] });
    // Codex only declares Bash as execute; command text is not trusted as a
    // semantic read signal, so target-specific priorRead remains unknown.
    expect(context.facts.priorReadOfTarget).toBe('unknown');
  });
});
