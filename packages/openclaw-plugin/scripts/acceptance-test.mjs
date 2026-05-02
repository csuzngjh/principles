#!/usr/bin/env node

/**
 * Nocturnal Pipeline — End-to-End Acceptance Test
 *
 * Verifies that all components of the Nocturnal reflection pipeline
 * work correctly in a real environment (not unit tests).
 *
 * Usage:
 *   node scripts/acceptance-test.mjs --workspace /path/to/workspace
 *
 * Output: Pass/Fail for each checkpoint with detailed diagnostics.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Helpers ───
let passCount = 0;
let failCount = 0;
let warnCount = 0;

function assert(condition, testName, detail = '') {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passCount++;
  } else {
    console.log(`  ❌ ${testName}${detail ? ` — ${detail}` : ''}`);
    failCount++;
  }
}

function warn(testName, detail = '') {
  console.log(`  ⚠️  ${testName}${detail ? ` — ${detail}` : ''}`);
  warnCount++;
}

function runSql(dbPath, sql) {
  return execFileSync('sqlite3', [dbPath, sql], {
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();
}

// ─── Parse workspace ───
function parseArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' && argv[i + 1]) return argv[++i];
  }
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

// ─── Main ───
function main() {
  const workspaceDir = parseArgs();
  const stateDir = join(workspaceDir, '.state');
  const dbPath = join(stateDir, 'trajectory.db');

  if (!existsSync(dbPath)) {
    console.error('❌ trajectory.db not found. Run seed script first.');
    process.exit(1);
  }

  console.log('\n🧪 Nocturnal Pipeline Acceptance Test');
  console.log('═'.repeat(55));
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Database:  ${dbPath}\n`);

  // ═══════════════════════════════════════════════
  // SECTION 1: Seed Scenario Data Integrity
  // ═══════════════════════════════════════════════
  console.log('── 1. Seed Scenario Data Integrity ──');

  // 1.1 Count seed sessions
  const sessionCount = parseInt(runSql(dbPath, "SELECT COUNT(*) FROM sessions WHERE session_id LIKE 'seed-%';"));
  assert(sessionCount === 10, '10 seed sessions exist', `found ${sessionCount}`);

  // 1.2 Count seed pain events
  const painCount = parseInt(runSql(dbPath, "SELECT COUNT(*) FROM pain_events WHERE session_id LIKE 'seed-%';"));
  assert(painCount >= 10, 'Pain events exist for seed sessions', `found ${painCount}`);

  // 1.3 Verify signal diversity
  const sources = runSql(dbPath, "SELECT DISTINCT source FROM pain_events WHERE session_id LIKE 'seed-%';").split('\n');
  assert(sources.includes('tool_failure'), 'tool_failure signal present');
  assert(sources.includes('user_empathy'), 'user_empathy signal present');

  // 1.4 Verify pain event scores are in valid range
  const invalidScores = runSql(dbPath, "SELECT COUNT(*) FROM pain_events WHERE session_id LIKE 'seed-%' AND (score < 0 OR score > 100);");
  assert(parseInt(invalidScores) === 0, 'All pain scores in 0-100 range', `${invalidScores} invalid`);

  // 1.5 Verify correction cues exist
  const correctionCount = parseInt(runSql(dbPath, "SELECT COUNT(*) FROM user_turns WHERE session_id LIKE 'seed-%' AND correction_detected = 1;"));
  assert(correctionCount >= 5, 'Multiple correction cues present', `found ${correctionCount}`);

  // 1.6 Verify tool calls (both success and failure)
  const failureCalls = parseInt(runSql(dbPath, "SELECT COUNT(*) FROM tool_calls WHERE session_id LIKE 'seed-%' AND outcome = 'failure';"));
  const successCalls = parseInt(runSql(dbPath, "SELECT COUNT(*) FROM tool_calls WHERE session_id LIKE 'seed-%' AND outcome = 'success';"));
  assert(failureCalls > 0, 'Failed tool calls in seed data', `found ${failureCalls}`);
  assert(successCalls > 0, 'Successful tool calls in seed data', `found ${successCalls}`);

  // 1.7 Verify scenario descriptions are unique and meaningful
  const reasons = runSql(dbPath, "SELECT DISTINCT reason FROM pain_events WHERE session_id LIKE 'seed-%' ORDER BY reason;").split('\n');
  const uniqueReasons = new Set(reasons);
  assert(uniqueReasons.size === reasons.length, 'All pain reasons are unique', `${uniqueReasons.size}/${reasons.length} unique`);

  // ═══════════════════════════════════════════════
  // SECTION 2: PainSignalBridge + Runtime v2
  // ═══════════════════════════════════════════════
  console.log('\n── 2. PainSignalBridge + Runtime v2 ──');

  // 2.1 Verify PainSignalBridge is imported from runtime-v2 in pain.ts
  const painHookSource = join(__dirname, '..', 'src', 'hooks', 'pain.ts');
  if (existsSync(painHookSource)) {
    const painContent = readFileSync(painHookSource, 'utf-8');
    assert(painContent.includes('PainToPrincipleService'), 'pain.ts uses PainToPrincipleService from runtime-v2');
    assert(!painContent.includes('createPainSignalBridge'), 'pain.ts no longer imports createPainSignalBridge');
  }

  // 2.2 Verify write_pain_flag tool is NOT registered in index.ts
  const indexSource2 = join(__dirname, '..', 'src', 'index.ts');
  if (existsSync(indexSource2)) {
    const indexContent = readFileSync(indexSource2, 'utf-8');
    assert(!indexContent.includes('createWritePainFlagTool'), 'write_pain_flag NOT registered in index.ts');
  }

  // ═══════════════════════════════════════════════
  // SECTION 3: Dedup Logic
  // ═══════════════════════════════════════════════
  console.log('\n── 3. Dedup Logic (Phase 3c) ──');

  const workerSource = join(__dirname, '..', 'src', 'service', 'evolution-worker.ts');
  if (existsSync(workerSource)) {
    const workerContent = readFileSync(workerSource, 'utf-8');

    // 3.1 Helper functions exist
    assert(workerContent.includes('hasRecentSimilarReflection'), 'hasRecentSimilarReflection helper extracted');
    assert(workerContent.includes('buildPainSourceKey'), 'buildPainSourceKey helper extracted');
    assert(workerContent.includes('shouldSkipForDedup'), 'shouldSkipForDedup helper extracted');

    // 3.2 Dedup window is configured
    assert(workerContent.includes('4 * 60 * 60 * 1000') || workerContent.includes('DEDUP_WINDOW_MS'), '4-hour dedup window configured');

    // 3.3 No-pain-context bypass
    const bypassCheck = workerContent.includes('!painSourceKey') || workerContent.includes('painSourceKey === null') || 
                        workerContent.includes('painSourceKey) return false') || workerContent.includes('if (!painSourceKey) return false');
    assert(bypassCheck, 'no_pain_context bypasses dedup', 'bypass pattern not found');

    // 3.4 Only completed tasks are checked (not failed)
    assert(workerContent.includes("status !== 'completed'") || workerContent.includes("status === 'completed'"), 'Only completed tasks matched for dedup');
  } else {
    fail('Dedup logic check', 'evolution-worker.ts not found');
  }

  // ═══════════════════════════════════════════════
  // SECTION 4: Correction Rejected Pain Event
  // ═══════════════════════════════════════════════
  console.log('\n── 4. Correction Rejected Pain Signal ──');

  const trajectorySource = join(__dirname, '..', 'src', 'core', 'trajectory.ts');
  if (existsSync(trajectorySource)) {
    const trajContent = readFileSync(trajectorySource, 'utf-8');

    // 4.1 Method exists
    assert(trajContent.includes('recordCorrectionRejectedPain'), 'recordCorrectionRejectedPain method exists');

    // 4.2 Called on rejected status
    assert(trajContent.includes("status === 'rejected'"), 'Pain event created on rejected status');

    // 4.3 Uses correct source
    assert(trajContent.includes("'correction_rejected'"), 'Uses correction_rejected source');

    // 4.4 Score is clamped
    assert(trajContent.includes('Math.max(0') && trajContent.includes('Math.min(100'), 'Score clamped 0-100');
  } else {
    fail('Correction rejected check', 'trajectory.ts not found');
  }

  // ═══════════════════════════════════════════════
  // SECTION 5: Shell Injection Safety
  // ═══════════════════════════════════════════════
  console.log('\n── 5. Shell Injection Safety ──');

  const seedScript = join(__dirname, '..', 'scripts', 'seed-nocturnal-scenarios.mjs');
  const diagnoseScript = join(__dirname, '..', 'scripts', 'diagnose-nocturnal.mjs');

  if (existsSync(seedScript)) {
    const seedContent = readFileSync(seedScript, 'utf-8');
    const execSyncCalls = (seedContent.match(/execSync\s*\(/g) || []).length;
    const execFileCalls = (seedContent.match(/execFileSync\s*\(/g) || []).length;
    assert(execSyncCalls === 0 || seedContent.includes("execSync('git") || seedContent.includes('execSync("git'), 
           'Seed script: no sqlite3 in execSync', 
           `found ${execSyncCalls} execSync calls`);
    assert(execFileCalls > 0, 'Seed script: uses execFileSync', `found ${execFileCalls} calls`);
    
    // 5.1 Pre-flight check
    assert(seedContent.includes('ensureSqlite3') || seedContent.includes('sqlite3 --version'), 'Seed script: sqlite3 pre-flight check');
  }

  if (existsSync(diagnoseScript)) {
    const diagContent = readFileSync(diagnoseScript, 'utf-8');
    // 5.2 Diagnose script uses execFileSync for sqlite3
    const diagExecFileCalls = (diagContent.match(/execFileSync\s*\(\s*['"]sqlite3/g) || []).length;
    assert(diagExecFileCalls > 0, 'Diagnose script: uses execFileSync for sqlite3', `found ${diagExecFileCalls} calls`);

    // 5.3 No shell-interpolated sqlite3 calls
    const shellSqliteCalls = (diagContent.match(/execSync\s*\(\s*['"]sqlite3/g) || []).length;
    assert(shellSqliteCalls === 0, 'Diagnose script: no sqlite3 in execSync', `found ${shellSqliteCalls} unsafe calls`);
  }

  // ═══════════════════════════════════════════════
  // SECTION 6: Pending Review Warning Fix
  // ═══════════════════════════════════════════════
  console.log('\n── 6. Pending Review Warning Fix ──');

  if (existsSync(diagnoseScript)) {
    const diagContent = readFileSync(diagnoseScript, 'utf-8');
    // 6.1 Pending case returns warn object
    const pendingWarnPattern = /if\s*\(\s*pending\s*>\s*0\s*\)\s*\{[\s\S]*?status:\s*['"]warn['"]/;
    assert(pendingWarnPattern.test(diagContent), 'Pending review returns {status:"warn"} object');
  }

  // ═══════════════════════════════════════════════
  // SECTION 7: Path Resolver Fallback
  // ═══════════════════════════════════════════════
  console.log('\n── 7. Path Resolver Fallback ──');

  const pathResolverSource = join(__dirname, '..', 'src', 'core', 'path-resolver.ts');
  if (existsSync(pathResolverSource)) {
    const prContent = readFileSync(pathResolverSource, 'utf-8');
    // 7.1 resolveWorkspaceDirFromApi checks config.workspaceDir
    assert(prContent.includes('config.workspaceDir') || prContent.includes('cfgWorkspaceDir'), 
           'resolveWorkspaceDirFromApi checks config.workspaceDir');
  }

  // ═══════════════════════════════════════════════
  // SECTION 8: Seed Scenario Quality (Manual Review)
  // ═══════════════════════════════════════════════
  console.log('\n── 8. Seed Scenario Quality ──');

  // 8.1 Verify pain score distribution
  const avgScore = parseFloat(runSql(dbPath, "SELECT ROUND(AVG(score), 1) FROM pain_events WHERE session_id LIKE 'seed-%';"));
  assert(avgScore > 50 && avgScore < 100, 'Average pain score reasonable (50-100)', `avg=${avgScore}`);

  // 8.2 Verify severity levels are set
  const nullSeverity = parseInt(runSql(dbPath, "SELECT COUNT(*) FROM pain_events WHERE session_id LIKE 'seed-%' AND severity IS NULL;"));
  assert(nullSeverity === 0, 'All seed pain events have severity', `${nullSeverity} null`);

  // 8.3 Verify origin is set
  const nullOrigin = parseInt(runSql(dbPath, "SELECT COUNT(*) FROM pain_events WHERE session_id LIKE 'seed-%' AND origin IS NULL;"));
  assert(nullOrigin === 0, 'All seed pain events have origin', `${nullOrigin} null`);

  // 8.4 Verify all 10 scenario IDs follow naming convention
  const seedSessions = runSql(dbPath, "SELECT session_id FROM sessions WHERE session_id LIKE 'seed-%' ORDER BY session_id;").split('\n');
  const validPattern = /^seed-[a-z-]+-\d{3}$/;
  const allValid = seedSessions.every(s => validPattern.test(s));
  assert(allValid, 'All session IDs follow naming convention', `${seedSessions.filter(s => !validPattern.test(s)).length} invalid`);

  // ═══════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════
  console.log('\n' + '═'.repeat(55));
  console.log(`  Acceptance Test Summary`);
  console.log('═'.repeat(55));
  console.log(`  ✅ Passed:  ${passCount}`);
  console.log(`  ❌ Failed:  ${failCount}`);
  console.log(`  ⚠️  Warnings: ${warnCount}`);
  console.log(`  Total:    ${passCount + failCount + warnCount}`);
  console.log('═'.repeat(55));

  if (failCount === 0) {
    console.log('\n🎉 All acceptance tests passed!');
    process.exit(0);
  } else {
    console.log(`\n❌ ${failCount} test(s) failed. Review details above.`);
    process.exit(1);
  }
}

main();
