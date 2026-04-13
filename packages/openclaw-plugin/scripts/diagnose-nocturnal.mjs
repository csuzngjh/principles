#!/usr/bin/env node

/**
 * Nocturnal Pipeline Diagnostic Script
 * ======================================
 * Checks every link in the Nocturnal reflection chain:
 *   Heartbeat → Idle Detection → Queue → Snapshot → Workflow → Trinity → Arbiter → Persistence
 *
 * Usage:
 *   node scripts/diagnose-nocturnal.mjs [--workspace /path/to/workspace]
 *
 * Output: Structured report with pass/fail for each checkpoint.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_DIR = join(__dirname, '..');

// ─── Argument parsing ───
function parseArgs() {
  let workspaceDir = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) {
      workspaceDir = argv[++i];
    }
  }
  // Auto-detect workspace from current git working directory
  if (!workspaceDir) {
    try {
      const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
      workspaceDir = gitRoot;
    } catch {
      workspaceDir = process.cwd();
    }
  }
  return { workspaceDir };
}

// ─── Report helpers ───
const results = [];
let checksPassed = 0;
let checksFailed = 0;
let checksWarned = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result && result.status === 'warn') {
      checksWarned++;
      results.push({ name, status: 'warn', detail: result.detail || '' });
    } else {
      checksPassed++;
      results.push({ name, status: 'pass', detail: typeof result === 'string' ? result : '' });
    }
  } catch (err) {
    checksFailed++;
    results.push({ name, status: 'fail', detail: err.message || String(err) });
  }
}

function printReport() {
  console.log('\n' + '='.repeat(60));
  console.log('  NOCTURNAL PIPELINE DIAGNOSTIC REPORT');
  console.log('  ' + new Date().toISOString());
  console.log('='.repeat(60));

  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'warn' ? '⚠️ ' : '❌';
    console.log(`\n${icon} ${r.name}`);
    if (r.detail) {
      console.log(`   ${r.detail}`);
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log(`  Summary: ${checksPassed} passed, ${checksWarned} warnings, ${checksFailed} failed`);
  console.log('-'.repeat(60) + '\n');

  if (checksFailed > 0) {
    process.exitCode = 1;
  }
}

// ─── Main ───
function main() {
  const { workspaceDir } = parseArgs();
  const stateDir = join(workspaceDir, '.state');

  console.log(`\n🔍 Diagnosing Nocturnal pipeline for workspace: ${workspaceDir}`);

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 1: State directory structure
  // ─────────────────────────────────────────────────────────
  check('1. State directory structure', () => {
    // All state dirs are inside .state/
    const required = ['sessions', 'logs', 'nocturnal', 'nocturnal/samples'];
    const missing = [];
    for (const rel of required) {
      if (!existsSync(join(stateDir, rel))) missing.push(rel);
    }
    if (missing.length > 0) throw new Error(`Missing directories: ${missing.join(', ')}`);
    return 'All required directories present';
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 2: Session tracker persistence
  // ─────────────────────────────────────────────────────────
  check('2. Session tracker persistence', () => {
    const sessionsDir = join(stateDir, 'sessions');
    if (!existsSync(sessionsDir)) throw new Error('sessions/ directory missing');
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      return { status: 'warn', detail: 'No session files found — idle check will report idle immediately' };
    }
    // Verify at least one session file is valid JSON
    let validSessions = 0;
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
        if (data.sessionId && data.lastActivityAt) validSessions++;
      } catch { /* corrupted, skip */ }
    }
    if (validSessions === 0) {
      return { status: 'warn', detail: `${files.length} session file(s) found but none are valid JSON — idle check will likely report idle immediately` };
    }
    return `${files.length} session files, ${validSessions} valid with sessionId+lastActivityAt`;
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 3: Idle detection logic
  // ─────────────────────────────────────────────────────────
  check('3. Idle detection (checkWorkspaceIdle)', () => {
    // Functions are minified — check for unique string markers instead.
    const bundlePath = join(PLUGIN_DIR, 'dist', 'bundle.js');
    const content = readFileSync(bundlePath, 'utf-8');

    // Stable markers: log messages, object fields, event strings that survive minification.
    const markers = [
      { name: 'Workspace not idle', reason: 'preflight idle check log message' },
      { name: 'trigger', reason: 'system session detection (checks trigger field)' },
      { name: 'abandonedSessionIds', reason: 'IdleCheckResult field (preserved in object literal)' },
      { name: 'trajectoryGuardrailConfirmsIdle', reason: 'IdleCheckResult field' },
    ];
    const missing = markers.filter(m => !content.includes(m.name));
    if (missing.length > 0) {
      throw new Error(`Idle detection markers missing: ${missing.map(m => m.name).join(', ')}`);
    }

    // Check PR #256 fix: legacy session temporal guard
    // The fix adds `lastActivityAt` comparison before treating sessions as system sessions.
    // In minified code this appears as a comparison involving `lastActivityAt`.
    if (!content.includes('lastActivityAt')) {
      return { status: 'warn', detail: 'lastActivityAt reference not found — temporal guard for legacy sessions may be missing' };
    }
    return 'Idle detection functions present (verified via stable string markers)';
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 4: Evolution queue
  // ─────────────────────────────────────────────────────────
  check('4. Evolution queue', () => {
    const queuePath = join(stateDir, 'evolution_queue.json');
    if (!existsSync(queuePath)) {
      return { status: 'warn', detail: 'No evolution queue — idle check has not yet enqueued a task' };
    }
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8'));
    const sleepTasks = queue.filter(t => t.taskKind === 'sleep_reflection');
    const pending = sleepTasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
    const completed = sleepTasks.filter(t => t.status === 'completed');
    const failed = sleepTasks.filter(t => t.status === 'failed');

    if (pending.length > 0) return `${pending.length} pending sleep_reflection task(s) awaiting processing`;
    if (completed.length > 0) return `${completed.length} completed, ${failed.length} failed (total ${sleepTasks.length} tasks)`;
    return { status: 'warn', detail: `Queue exists with ${queue.length} items but no sleep_reflection tasks` };
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 5: Nocturnal samples (artifacts)
  // ─────────────────────────────────────────────────────────
  check('5. Nocturnal artifact persistence', () => {
    const samplesDir = join(stateDir, 'nocturnal', 'samples');
    if (!existsSync(samplesDir)) {
      return { status: 'warn', detail: 'No samples directory — no reflections have been persisted yet' };
    }
    const files = readdirSync(samplesDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return { status: 'warn', detail: 'samples/ directory exists but is empty' };

    // Validate most recent artifact
    const sorted = files
      .map(f => ({ name: f, mtime: statSync(join(samplesDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const latest = sorted[0].name;
    const artifact = JSON.parse(readFileSync(join(samplesDir, latest), 'utf-8'));
    const hasRequired = artifact.artifactId && artifact.badDecision && artifact.betterDecision && artifact.rationale;
    if (!hasRequired) {
      return { status: 'warn', detail: `Latest artifact ${latest} is missing required fields` };
    }
    return `${files.length} artifact(s), latest: ${latest} (${artifact.principleId || 'unknown principle'})`;
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 6: Workflow store
  // ─────────────────────────────────────────────────────────
  check('6. Nocturnal workflow store', () => {
    const workflowsPath = join(stateDir, 'nocturnal', 'workflows.json');
    if (!existsSync(workflowsPath)) {
      return { status: 'warn', detail: 'No workflows.json — no nocturnal workflows have been started' };
    }
    const workflows = JSON.parse(readFileSync(workflowsPath, 'utf-8'));
    if (!Array.isArray(workflows) || workflows.length === 0) {
      return { status: 'warn', detail: 'workflows.json is empty — no workflows recorded' };
    }
    const active = workflows.filter(w => w.state === 'active');
    const completed = workflows.filter(w => w.state === 'completed');
    const errored = workflows.filter(w => w.state === 'terminal_error');
    const expired = workflows.filter(w => w.state === 'expired');

    if (active.length > 0) {
      return { status: 'warn', detail: `${active.length} workflow(s) still active — may be in progress or stuck. IDs: ${active.map(w => w.workflow_id).join(', ')}` };
    }
    return `${workflows.length} total: ${completed.length} completed, ${errored.length} errored, ${expired.length} expired`;
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 7: Nocturnal runtime state (cooldown/quota)
  // ─────────────────────────────────────────────────────────
  check('7. Nocturnal runtime state (cooldown/quota)', () => {
    const runtimePath = join(stateDir, 'nocturnal-runtime.json');
    if (!existsSync(runtimePath)) {
      return 'No runtime state — no cooldown or quota restrictions';
    }
    const state = JSON.parse(readFileSync(runtimePath, 'utf-8'));
    const issues = [];

    if (state.globalCooldownUntil) {
      const cooldownEnd = new Date(state.globalCooldownUntil).getTime();
      if (cooldownEnd > Date.now()) {
        const remainingMin = Math.round((cooldownEnd - Date.now()) / 60000);
        issues.push(`global cooldown active (${remainingMin}min remaining)`);
      }
    }

    if (state.recentRunTimestamps) {
      const windowStart = Date.now() - 24 * 60 * 60 * 1000;
      const recentRuns = state.recentRunTimestamps
        .map(ts => new Date(ts).getTime())
        .filter(ts => ts > windowStart);
      if (recentRuns.length >= 3) {
        issues.push(`quota exhausted (${recentRuns.length}/3 runs used in 24h)`);
      }
    }

    if (issues.length > 0) {
      return { status: 'warn', detail: issues.join('; ') };
    }
    return 'No active cooldown or quota restrictions';
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 8: Bundle health
  // ─────────────────────────────────────────────────────────
  check('8. Plugin bundle health', () => {
    const bundlePath = join(PLUGIN_DIR, 'dist', 'bundle.js');
    if (!existsSync(bundlePath)) throw new Error('dist/bundle.js missing — run build first');

    const content = readFileSync(bundlePath, 'utf-8');

    // Use a mix of exported symbols and stable string markers.
    // Class names and exported symbols survive minification; internal function names don't.
    const markers = [
      'EvolutionWorkerService',       // exported class
      'checkPainFlag',                 // exported function
      'processEvolutionQueue',         // function reference
      'NocturnalWorkflowManager',      // exported class
      'executeNocturnalReflectionAsync', // used in log messages
      'nocturnal_started',             // event type string
      'nocturnal_completed',           // event type string
      'nocturnal_failed',              // event type string
      'nocturnal_expired',             // event type string
    ];
    const missing = markers.filter(m => !content.includes(m));
    if (missing.length > 0) throw new Error(`Missing critical symbols in bundle: ${missing.join(', ')}`);

    return `Bundle OK (${Math.round(content.length / 1024)}KB), all ${markers.length} critical markers present`;
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 9: Git state — uncommitted changes that could break pipeline
  // ─────────────────────────────────────────────────────────
  check('9. Git state (uncommitted changes)', () => {
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf-8', timeout: 5000, cwd: PLUGIN_DIR }).trim();
      if (!status) return 'Working tree clean';
      const changedFiles = status.split('\n').length;
      return { status: 'warn', detail: `${changedFiles} uncommitted change(s) in plugin directory` };
    } catch {
      return { status: 'warn', detail: 'Could not check git status' };
    }
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 10: Pain flag state
  // ─────────────────────────────────────────────────────────
  check('10. Pain flag state', () => {
    const painFlagPath = join(stateDir, '.pain_flag');
    if (!existsSync(painFlagPath)) {
      return 'No active pain flag';
    }
    const content = readFileSync(painFlagPath, 'utf-8');

    // Self-healing: fix [object Object] corruption caused by bash heredoc/toString
    if (content.includes('[object Object]')) {
      // Try to extract and parse JSON object from anywhere in the content
      // The corruption might be at any position, not just the beginning
      try {
        // Attempt 1: Extract JSON object using regex (handles {...} anywhere)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const json = JSON.parse(jsonMatch[0]);
          // If we got a valid object, rewrite it properly as KV format
          const kv = Object.entries(json)
            .map(([k, v]) => `${k}: ${v === undefined ? '' : v}`)
            .join('\n');
          writeFileSync(painFlagPath, kv, 'utf-8');
          return `Pain flag was corrupted ([object Object]), auto-repaired from JSON backup`;
        }
        // Attempt 2: Try parsing the whole content after removing common prefixes
        const cleaned = content.replace(/^(active:\s*|source:\s*)/, '').trim();
        if (cleaned.startsWith('{')) {
          const json = JSON.parse(cleaned);
          const kv = Object.entries(json)
            .map(([k, v]) => `${k}: ${v === undefined ? '' : v}`)
            .join('\n');
          writeFileSync(painFlagPath, kv, 'utf-8');
          return `Pain flag was corrupted ([object Object]), auto-repaired from JSON backup`;
        }
        throw new Error('No valid JSON found');
      } catch {
        // If not JSON, delete the corrupted file to unblock the system
        try {
          rmSync(painFlagPath);
          return `Pain flag was corrupted ([object Object]), deleted invalid file to unblock system`;
        } catch {
          return { status: 'warn', detail: 'Pain flag corrupted ([object Object]), could not auto-repair' };
        }
      }
    }

    const lines = content.split('\n');
    const fields = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        fields[line.substring(0, colonIdx).trim()] = line.substring(colonIdx + 1).trim();
      }
    }
    // Accept either the legacy contract (fields.score + fields.reason)
    // or the current contract (active.source.score)
    const legacy = fields.score && fields.reason;
    const current = fields.active && fields.source && fields.score;
    if (!legacy && !current) {
      return { status: 'warn', detail: 'Pain flag exists but is missing required fields (need score + reason, or active.source.score)' };
    }
    return `Pain flag active (score: ${fields.score}, source: ${fields.source || fields.active?.source || 'unknown'}, session: ${fields.session_id || 'none'})`;
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 11: Trajectory data
  // ─────────────────────────────────────────────────────────
  check('11. Trajectory data availability', () => {
    const trajectoryPath = join(stateDir, 'trajectory.json');
    const trajectoryDir = join(stateDir, 'trajectory');
    const trajectoryDb = join(stateDir, 'trajectory.db');
    if (!existsSync(trajectoryPath) && !existsSync(trajectoryDir) && !existsSync(trajectoryDb)) {
      return { status: 'warn', detail: 'No trajectory data — snapshot extraction will use pain context fallback or fail' };
    }
    if (existsSync(trajectoryDb)) {
      const stat = statSync(trajectoryDb);
      return `Trajectory SQLite database present (${Math.round(stat.size / 1024)}KB)`;
    }
    // Check trajectory content
    if (existsSync(trajectoryPath)) {
      try {
        const data = JSON.parse(readFileSync(trajectoryPath, 'utf-8'));
        const entryCount = Array.isArray(data) ? data.length : Object.keys(data).length;
        return `${entryCount} trajectory entries available`;
      } catch {
        return { status: 'warn', detail: 'trajectory.json exists but is corrupted' };
      }
    }
    if (existsSync(trajectoryDir)) {
      const files = readdirSync(trajectoryDir).filter(f => f.endsWith('.json'));
      return `${files.length} trajectory file(s) available`;
    }
    return { status: 'warn', detail: 'Trajectory storage not found in expected locations' };
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 12: Principle training state
  // ─────────────────────────────────────────────────────────
  check('12. Principle training state', () => {
    // Check multiple possible locations
    const candidates = [
      join(stateDir, 'nocturnal', 'training_store.json'),
      join(stateDir, 'principle_training_state.json'),
    ];
    let trainingPath = null;
    for (const c of candidates) {
      if (existsSync(c)) { trainingPath = c; break; }
    }
    if (!trainingPath) {
      return { status: 'warn', detail: 'No training_store.json or principle_training_state.json — NocturnalTargetSelector may not find evaluable principles' };
    }
    try {
      const store = JSON.parse(readFileSync(trainingPath, 'utf-8'));
      const principles = Object.keys(store.principles || store);
      if (principles.length === 0) {
        return { status: 'warn', detail: 'Training store exists but has no principles' };
      }
      const evaluable = principles.filter(p => {
        const pr = store.principles ? store.principles[p] : store[p];
        return pr && pr.evaluability !== 'manual_only';
      });
      return `${principles.length} principle(s) in training store, ${evaluable.length} evaluable`;
    } catch {
      return { status: 'warn', detail: 'Training store exists but is corrupted' };
    }
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 13: Correction samples (Phase 2b/3b)
  // ─────────────────────────────────────────────────────────
  check('13. Correction samples availability', () => {
    // Read from trajectory.db using sqlite3 CLI
    try {
      const dbPath = join(stateDir, 'trajectory.db');
      if (!existsSync(dbPath)) {
        return { status: 'warn', detail: 'trajectory.db not found' };
      }
      const result = execSync(`sqlite3 '${dbPath}' "SELECT review_status, COUNT(*), AVG(quality_score) FROM correction_samples GROUP BY review_status;" 2>/dev/null || echo 'QUERY_FAILED'`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!result || result === 'QUERY_FAILED') {
        return { status: 'warn', detail: 'Could not query correction samples' };
      }
      const pendingMatch = result.match(/pending\|(\d+)/);
      const approvedMatch = result.match(/approved\|(\d+)/);
      const rejectedMatch = result.match(/rejected\|(\d+)/);
      const pending = pendingMatch ? parseInt(pendingMatch[1]) : 0;
      const approved = approvedMatch ? parseInt(approvedMatch[1]) : 0;
      const rejected = rejectedMatch ? parseInt(rejectedMatch[1]) : 0;
      if (pending > 0) return `${pending} pending review, ${approved} approved, ${rejected} rejected`;
      if (approved === 0 && rejected === 0) return { status: 'warn', detail: 'No correction samples exist — no user corrections detected yet' };
      return `${approved} approved, ${rejected} rejected, ${pending} pending`;
    } catch {
      return { status: 'warn', detail: 'Could not query trajectory.db' };
    }
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 14: Signal diversity (Phase 3b)
  // ─────────────────────────────────────────────────────────
  check('14. Pain signal diversity', () => {
    try {
      const dbPath = join(stateDir, 'trajectory.db');
      if (!existsSync(dbPath)) {
        return { status: 'warn', detail: 'trajectory.db not found' };
      }
      const result = execSync(`sqlite3 '${dbPath}' "SELECT source, COUNT(*), ROUND(AVG(score),1) FROM pain_events GROUP BY source ORDER BY COUNT(*) DESC;" 2>/dev/null || echo 'QUERY_FAILED'`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!result || result === 'QUERY_FAILED') {
        return { status: 'warn', detail: 'Could not query pain events' };
      }
      const sources = result.split('\n').filter(Boolean);
      if (sources.length < 2) {
        return { status: 'warn', detail: `Only ${sources.length} pain signal source(s) — low diversity. Expected: tool_failure, user_empathy, correction_rejected, gate_blocked` };
      }
      const summary = sources.map(s => {
        const parts = s.split('|');
        return `${parts[0]} (${parts[1]}, avg ${parts[2]})`;
      }).join(', ');
      return `${sources.length} sources: ${summary}`;
    } catch {
      return { status: 'warn', detail: 'Could not query trajectory.db' };
    }
  });

  // ─────────────────────────────────────────────────────────
  // CHECKPOINT 15: Artifact quality (Phase 3)
  // ─────────────────────────────────────────────────────────
  check('15. Nocturnal artifact quality', () => {
    const samplesDir = join(stateDir, 'nocturnal', 'samples');
    if (!existsSync(samplesDir)) {
      return { status: 'warn', detail: 'No samples directory' };
    }
    const files = readdirSync(samplesDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return { status: 'warn', detail: 'No artifacts produced yet' };

    // Check uniqueness of badDecision across recent artifacts
    const recentFiles = files
      .map(f => ({ name: f, mtime: statSync(join(samplesDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);

    const decisions = new Set();
    for (const f of recentFiles) {
      try {
        const artifact = JSON.parse(readFileSync(join(samplesDir, f.name), 'utf-8'));
        if (artifact.badDecision) decisions.add(artifact.badDecision);
      } catch { /* skip */ }
    }

    if (decisions.size < recentFiles.length) {
      return { status: 'warn', detail: `${recentFiles.length - decisions.size} duplicate decision(s) in last ${recentFiles.length} artifacts — stub reflector may not be content-aware` };
    }
    return `${files.length} total, last ${recentFiles.length} all unique decisions`;
  });

  printReport();
}

main();
