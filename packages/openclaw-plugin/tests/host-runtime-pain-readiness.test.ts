import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenClawHostRuntime } from '../src/host-runtime/openclaw-host-runtime.js';

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

describe('OpenClaw shared pain readiness boundary', () => {
  it.each(['missing', 'corrupt', 'malformed', 'wrong-index-predicate'] as const)('does not run host enrichment or continuation when the trajectory database is %s', async (state) => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `pd-openclaw-${state}-`));
    workspaces.push(workspaceDir);
    if (state === 'corrupt') {
      fs.mkdirSync(path.join(workspaceDir, '.state'));
      fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), 'not sqlite');
    } else if (state === 'malformed') {
      fs.mkdirSync(path.join(workspaceDir, '.state'));
      const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
      db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY); CREATE TABLE tool_calls (id INTEGER PRIMARY KEY); CREATE TABLE pain_events (id INTEGER PRIMARY KEY, canonical_pain_id TEXT); CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;');
      db.close();
    } else if (state === 'wrong-index-predicate') {
      fs.mkdirSync(path.join(workspaceDir, '.state'));
      const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
      db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
        CREATE TABLE pain_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE score > 50;`);
      db.close();
    }
    const painEnrichmentProvider = vi.fn(() => ({}));
    const onAfterToolResult = vi.fn();
    const runtime = createOpenClawHostRuntime({
      beforePromptBuild: async () => undefined,
      painEnrichmentProvider,
      onAfterToolResult,
    });

    await expect(runtime.dispatchAfterToolCall(
      { toolName: 'write_file', params: { file_path: 'src/a.ts' }, error: 'denied' },
      { workspaceDir, sessionId: 'session-readiness' },
    )).resolves.toBeUndefined();

    expect(painEnrichmentProvider).not.toHaveBeenCalled();
    expect(onAfterToolResult).not.toHaveBeenCalled();
    expect(fs.readdirSync(workspaceDir)).toEqual(state === 'missing' ? [] : ['.state']);
  });
});
