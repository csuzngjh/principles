/**
 * PD-SPEC-001 — public leak scanner (fail-closed, re-runnable).
 *
 * Scans every tracked text file changed by this PR for:
 *  - verbatim sensitive originals harvested from the FULL-fidelity dataset
 *    (Owner pain text, evidence notes, corrections — the .tmp full copies);
 *  - real session ids / relatable identifiers;
 *  - absolute paths INSIDE data files (dataset/inventory must contain none;
 *    docs may reference environment paths as configuration description, which
 *    this scanner reports as INFO, not FAIL);
 *  - redaction-placeholder integrity (every sensitive-key value in the committed
 *    dataset/inventory is «redacted…», anon-…, null, a structural enum, or a
 *    safe error class).
 *
 * Usage: node experiment/prompt-v2/scripts/scan-public-leaks.mjs
 * Exit 1 on any FAIL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactForPublication, assertNoVerbatimLeak, placeholder } from './redact-for-publication.mjs';

const worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const repoRoot = path.resolve(worktree);

const DENY_KEYS = new Set(['text', 'reason', 'reasonSummary', 'note', 'root_cause', 'content_json', 'succeededRunOutputPayload', 'routerPersistedInput', 'title', 'description', 'abstracted_principle', 'trigger_pattern', 'action', 'textPreview', 'evidence_json', 'provenanceReason', 'explanation', 'thesis', 'statement', 'badDecision', 'betterDecision', 'rationale', 'ambiguityNotes', 'summary', 'antiPatterns', 'applicability', 'risks', 'scope', 'evidence', 'strategicPerspective', 'nextAction', 'warnings']);
const ANON_KEYS = new Set(['sessionId', 'session_id', 'sessionIdHint']);

function harvestSensitive(value, key = null, sink) {
  if (Array.isArray(value)) { for (const v of value) harvestSensitive(v, key, sink); return; }
  if (value !== null && typeof value === 'object') { for (const [k, v] of Object.entries(value)) harvestSensitive(v, k, sink); return; }
  if (typeof value !== 'string' || value.length < 20) return;
  if (/^(agent_turn|conversationWindow|run_|pi-art|diag_|dreamer-|philosopher-|scribe-|anon-)/.test(value) && value.length < 90) return;
  if (value.length < 64 && /^[A-Za-z][A-Za-z0-9_.:-]{5,60}$/.test(value) && !/[一-鿿]/.test(value)) return;
  const sensitiveKey = key !== null && (DENY_KEYS.has(key) || ANON_KEYS.has(key) || key === 'last_error' || key === 'lastError');
  if (!sensitiveKey) return;
  const t = value.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { harvestSensitive(JSON.parse(value), null, sink); return; } catch { /* fall through */ }
  }
  sink.add(value);
}

const findings = [];
const info = [];
const add = (level, file, what) => findings.push({ level, file, what });

// 1. Harvest sensitive originals from the LOCAL full copies.
const fullDir = path.join(repoRoot, '.tmp/prompt-v2-inventory');
const fullDataset = JSON.parse(fs.readFileSync(path.join(fullDir, 'pain-dataset.full.json'), 'utf8'));
const fullInventory = JSON.parse(fs.readFileSync(path.join(fullDir, 'pain-inventory.full.json'), 'utf8'));
const sink = new Set();
harvestSensitive(fullDataset, null, sink);
harvestSensitive(fullInventory, null, sink);
// Prompt-example constants (schema-prompt-adapter.ts) are public source-code
// literals; a production output COPYING them (S09 root_cause = "People: Example
// root cause" — live evidence of the V1 example-inducement defect) collides
// with source code by construction and is not Owner content.
for (const exampleLiteral of [
  'People: Example root cause', 'Design: Example root cause', 'Assumption: Example root cause', 'Tooling: Example root cause',
  'Example diagnosis summary', 'Example principle violation rationale', 'Example evidence note',
  'Example principle recommendation', 'Example abstracted principle text under 200 chars',
  'Abstracted principle text (max 200 chars)', 'Example root cause',
]) sink.delete(exampleLiteral);
const sessions = new Set();
const collectSessions = (v) => {
  if (Array.isArray(v)) { for (const x of v) collectSessions(x); return; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { if (ANON_KEYS.has(k) && typeof x === 'string' && x.length > 3) sessions.add(x); collectSessions(x); } return; }
};
collectSessions(fullDataset); collectSessions(fullInventory);

// 2. PR-changed tracked text files.
const diffFiles = execFileSync('git', ['diff', '--name-only', 'origin/main..HEAD'], { encoding: 'utf8', cwd: repoRoot })
  .split('\n').filter(Boolean)
  .filter((f) => /\.(json|md|txt|csv|mjs|ts|ya?ml)$/.test(f));

const DATA_FILES = new Set(['experiment/prompt-v2/dataset/pain-dataset.json', 'experiment/prompt-v2/dataset/pain-inventory.json']);
const ABS_PATH_RE = /(D:\\\\|C:\\\\Users|[A-Za-z]:\\\\\.openclaw|D:\/\.openclaw|C:\/Users\/Administrator)/;

for (const f of diffFiles) {
  const abs = path.join(repoRoot, f);
  if (!fs.existsSync(abs)) continue;
  const content = fs.readFileSync(abs, 'utf8');
  // 2a. verbatim originals (≥20 chars) must not survive anywhere
  for (const o of sink) {
    if (content.includes(o)) add('FAIL', f, `verbatim original survives (${o.length} chars, head ${JSON.stringify(o.slice(0, 24))})`);
  }
  // 2b. real session ids must not survive
  for (const sid of sessions) {
    if (content.includes(sid)) add('FAIL', f, `real session id survives: ${sid.slice(0, 8)}…`);
  }
  // 2c. absolute paths inside DATA files are always a leak; in docs/scripts INFO
  if (DATA_FILES.has(f) && ABS_PATH_RE.test(content)) add('FAIL', f, 'absolute production path inside data file');
  else if (ABS_PATH_RE.test(content) && /\.(json)$/.test(f)) info.push({ file: f, what: 'absolute path in non-data JSON — reviewed manually' });
}

// 3. Placeholder integrity of the committed data files.
for (const f of DATA_FILES) {
  const committed = JSON.parse(fs.readFileSync(path.join(repoRoot, f), 'utf8'));
  try {
    const redacted = redactForPublication(f.endsWith('pain-dataset.json') ? fullDataset : fullInventory);
    assertNoVerbatimLeak(f.endsWith('pain-dataset.json') ? fullDataset : fullInventory, redacted);
    const committedStr = JSON.stringify(committed);
    const regenStr = JSON.stringify(redacted);
    if (committedStr !== regenStr) add('FAIL', f, 'committed file does NOT equal a fresh redactForPublication() regeneration — regeneration would re-leak or has drifted');
  } catch (e) {
    add('FAIL', f, `redaction regeneration failed: ${String(e.message).slice(0, 120)}`);
  }
}

const fails = findings.filter((x) => x.level === 'FAIL');
console.log(JSON.stringify({ scannedFiles: diffFiles.length, originalsChecked: sink.size, sessionsChecked: sessions.size, failures: fails, info, ok: fails.length === 0 }, null, 1));
process.exit(fails.length === 0 ? 0 : 1);
