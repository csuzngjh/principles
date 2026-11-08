/**
 * Child process for the presence-event durability regression (PRI-1152 B1).
 *
 * Loads the REAL EventLog (bundled from src by the parent test), records the
 * events for its mode and then does nothing else: no flush(), no dispose(), no
 * process.exit(). The process ends when the event loop drains, exactly like a
 * one-shot `openclaw agent exec` turn. All inputs arrive on stdin.
 */

import { pathToFileURL } from 'node:url';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const { bundlePath, stateDir, mode } = JSON.parse(input);
const { EventLog } = await import(pathToFileURL(bundlePath).href);
const eventLog = new EventLog(stateDir);

const presence = {
  runId: 'run-natural-exit',
  sessionId: 'session-natural-exit',
  boundary: 'post_assembly_system_prompt_via_llm_input',
  binding: 'unique',
  liveSnapshots: 1,
  assemblySeqCandidates: [0],
  checked: true,
  results: [],
};

if (mode === 'presence') {
  eventLog.recordPromptPresenceObserved(presence);
} else if (mode === 'buffered-control') {
  eventLog.recordToolCall('session-natural-exit', { toolName: 'read_file' });
} else if (mode === 'mixed') {
  eventLog.recordToolCall('session-natural-exit', { toolName: 'read_file' });
  eventLog.recordPromptPresenceObserved(presence);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
