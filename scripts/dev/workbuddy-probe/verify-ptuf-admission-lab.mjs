// ONE-OFF verification (not committed): the REAL PostToolUseFailure payload
// shape through the REAL built dist entry points — adapter decoder + production
// host runtime dispatch — to capture the authoritative normalization result
// (metadata: outcome/painScore/admitted/trigger*) and the resulting
// trajectory.db rows, then the bare-pain admission sweep outcome.
// Usage: node scripts/dev/workbuddy-probe/verify-ptuf-admission-lab.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const distImport = (pkg, file) => import(pathToFileURL(path.join(REPO, `packages/${pkg}/dist/${file}`)).href);
const core = await distImport('principles-core', 'runtime-v2/index.js');
const hostRuntime = await distImport('host-runtime', 'index.js');
const adapter = await distImport('workbuddy-adapter', 'index.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ptuf-verify-home-'));
const governance = path.join(home, '.workbuddy', 'pd-workspace');
fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
const config = core.getDefaultPdConfig();
config.features['host.workbuddy'].enabled = true;
fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), JSON.stringify(config));
fs.mkdirSync(path.join(governance, '.state'), { recursive: true });
const traj = new Database(path.join(governance, '.state', 'trajectory.db'));
traj.exec(`
  CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
  CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
`);
traj.close();

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ptuf-verify-proj-'));
const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'packages/workbuddy-adapter/tests/fixtures/host-contract/events/post-tool-use-failure-write-notread.json'), 'utf8'));
const payload = { ...fixture.payload, cwd: project };
const event = adapter.decodeWorkbuddyInput(payload);
console.log('decoded:', { kind: event.kind, source: event.source, toolName: event.context.toolName, toolCallId: event.context.toolCallId });

// Same dispatch shape as pd-hook.ts (no live rules on a fresh workspace).
const stateDir = path.join(governance, '.state');
const events = {
  recordToolCall(sessionId, data) {
    core.appendEventLogLine(stateDir, {
      ts: new Date().toISOString(),
      type: 'tool_call',
      category: data.error || (data.exitCode !== undefined && data.exitCode !== 0) ? 'failure' : 'success',
      sessionId,
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? core.redactTelemetryString(v) : v])),
    });
  },
};
const runtime = hostRuntime.createProductionHostRuntime({
  hostKind: 'workbuddy',
  toolSemantics: adapter.WORKBUDDY_TOOL_SEMANTICS,
  events,
  painEnrichmentProvider: (hostEvent) => {
    if (hostEvent.kind !== 'after_tool_call') return {};
    const output = hostEvent.context.toolOutput;
    const detail = typeof output === 'object' && output !== null && !Array.isArray(output)
      ? Object.hasOwn(output, 'tool_error_code') ? `tool_error_code=${String(output.tool_error_code)}`
      : Object.hasOwn(output, 'exitCode') ? `exitCode=${String(output.exitCode)}` : 'failure'
      : 'failure';
    return { evidence: [{ sourceRef: `workbuddy-pd-hook-event-log:${hostEvent.context.sessionId}`, note: `${hostEvent.context.toolName ?? 'unknown-tool'} failed (${detail}); raw payload in the durable workbuddy hook event log for this session` }] };
  },
});
const result = await runtime.dispatch(
  // Production wiring step (pd-hook.ts): the decoded cwd is the PROJECT dir;
  // the entry rewrites context.workspaceDir to the resolved governance
  // workspace BEFORE dispatch.
  { ...event, context: { ...event.context, workspaceDir: governance } },
);
console.log('metadata:', JSON.stringify(result.metadata, null, 2));

const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
console.log('tool_calls:', db.prepare('SELECT tool_name, outcome, exit_code, error_message FROM tool_calls').all());
console.log('pain_events:', db.prepare('SELECT session_id, source, score, reason, host_kind FROM pain_events').all());
db.close();
const logs = fs.readdirSync(path.join(stateDir, 'logs')).flatMap((f) => fs.readFileSync(path.join(stateDir, 'logs', f), 'utf8').split('\n').filter(Boolean));
console.log('event log lines:', logs.map((l) => JSON.stringify(JSON.parse(l))));

const sweep = await hostRuntime.admitBareHostPains({ workspaceDir: governance, hostKind: 'workbuddy' });
console.log('admitBareHostPains:', JSON.stringify(sweep, null, 2));

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(project, { recursive: true, force: true });
