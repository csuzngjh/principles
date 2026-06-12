import * as fs from 'node:fs';
import * as path from 'node:path';
import { RuntimeStateManager } from '../packages/principles-core/src/runtime-v2/store/runtime-state-manager.js';
import { SqliteHistoryQuery } from '../packages/principles-core/src/runtime-v2/store/history/sqlite-history-query.js';
import { SqliteContextAssembler } from '../packages/principles-core/src/runtime-v2/store/context/sqlite-context-assembler.js';

// Parse CLI Arguments
const args = process.argv.slice(2);
const workspaceArg = args.find(a => a.startsWith('--workspace='));
const outputArg = args.find(a => a.startsWith('--output-dir='));
const painIdFileArg = args.find(a => a.startsWith('--pain-id-file='));

if (!workspaceArg || !painIdFileArg) {
  console.error('ERROR: Missing required arguments.');
  console.error('Usage: npx tsx scripts/export-comparison-corpus.ts --workspace=<path-to-workspace> --pain-id-file=<path-to-pain-id-json-file> [--output-dir=<output-path>]');
  console.error('');
  console.error('Note: To run locally with checked-in pain IDs and default workspace:');
  console.error('  npx tsx scripts/export-comparison-corpus.ts --workspace=D:/.openclaw/workspace --pain-id-file=spike/pain-ids.json');
  process.exit(1);
}

const workspaceDir = workspaceArg.split('=')[1];
const painIdFile = painIdFileArg.split('=')[1];
const outputDir = outputArg ? path.resolve(outputArg.split('=')[1]) : path.resolve('spike/comparison-fixtures');

// Validate workspace
if (!fs.existsSync(workspaceDir)) {
  console.error(`ERROR: Workspace directory not found: ${workspaceDir}`);
  process.exit(1);
}

let painIds: Record<string, string> = {};

try {
  const raw = fs.readFileSync(painIdFile, 'utf-8');
  painIds = JSON.parse(raw);
} catch (err: any) {
  console.error(`ERROR: Failed to read pain-id-file ${painIdFile}:`, err.message);
  process.exit(1);
}

// Map of categories to manually ensure 4 root cause categories are covered in fixtures
const CATEGORIES: Record<string, string> = {
  R1: 'Design',
  R2: 'Design',
  R3: 'Tooling',
  R5: 'Design',
  R6: 'Design',
  R7: 'People',
  R8: 'Assumption',
  R9: 'Design',
  R10: 'Design',
  R11: 'Design',
  R12: 'Design',
  R13: 'Design',
  R14: 'Tooling',
  R15: 'Tooling',
};

/**
 * Anonymize and sanitize a single string value.
 */
function sanitizeString(
  val: string,
  realPainId: string,
  realTaskId: string,
  realContextId: string,
  realContextHash: string,
  runIds: string[],
  codeLower: string
): string {
  let result = val;

  // 1. Map IDs
  const registerIdReplacement = (realId: string, replacement: string) => {
    if (!realId) return;
    result = result.replace(new RegExp(realId, 'g'), replacement);

    // Also match the version with hyphens, and vice versa
    const withHyphens = realId.replace(/_/g, '-');
    if (withHyphens !== realId) {
      result = result.replace(new RegExp(withHyphens, 'g'), replacement);
    }
    const withUnderscores = realId.replace(/-/g, '_');
    if (withUnderscores !== realId) {
      result = result.replace(new RegExp(withUnderscores, 'g'), replacement);
    }
  };

  registerIdReplacement(realContextId, `ctx_${codeLower}`);
  registerIdReplacement(realContextHash, `hash_${codeLower}`);
  registerIdReplacement(realTaskId, `task_${codeLower}`);
  registerIdReplacement(realPainId, `pain_${codeLower}`);

  // Map run IDs
  runIds.forEach((runId, idx) => {
    registerIdReplacement(runId, `run_${codeLower}_${idx + 1}`);
  });

  // Re-map generated diagnosis IDs (e.g. diag-manual-timestamp)
  result = result.replace(/manual[_-]17\d+[_-]\w+/gi, `pain_${codeLower}`);
  result = result.replace(/pain[_-]17\d+[_-]\w+/gi, `pain_${codeLower}`);
  result = result.replace(/diag[_-]manual[_-]17\d+[_-]\w+/gi, `diag_${codeLower}`);
  result = result.replace(/diag[_-]manual[_-]17\d+/gi, `diag_${codeLower}`);

  // 2. Map UUID Session IDs
  result = result.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, `session_${codeLower}`);

  // 3. Map absolute paths and local environments ONLY in strings that look like Windows paths
  const hasPathPattern = /[a-zA-Z]:[\\/]/i.test(result) || /openclaw/i.test(result) || /principles/i.test(result) || /Administrator/i.test(result);

  if (hasPathPattern) {
    // Replace Windows path backslashes with forward slashes specifically inside drive-letter paths
    result = result.replace(/([a-zA-Z]:(?:\\[\\/]?|[\/])[a-zA-Z0-9_\.\-\\\/@]+)/gi, (match) => {
      return match.replace(/\\+/g, '/');
    });

    // Anonymize absolute paths
    result = result.replace(/[a-zA-Z]:\/\.openclaw\/workspace/gi, '/workspace');
    result = result.replace(/[a-zA-Z]:\/Code\/principles/gi, '/project');
    result = result.replace(/\.openclaw\/workspace/gi, 'workspace');

    // Fallbacks for other absolute directories
    result = result.replace(/[a-zA-Z]:\/Users\/\w+/gi, '/user-home');
    result = result.replace(/[a-zA-Z]:\//gi, '/');

    // Redact Administrator username
    result = result.replace(/Administrator/gi, 'user');
  }

  // Remove local session details or sessionId hints
  result = result.replace(/No authenticated host session provenance available/gi, 'No host trace available');
  result = result.replace(/provenanceReason":\s*"[^"]*"/gi, 'provenanceReason": "No host trace available"');

  return result;
}

/**
 * Recursively sanitize value (handles strings, arrays, objects).
 */
function sanitizeValue(
  val: any,
  realPainId: string,
  realTaskId: string,
  realContextId: string,
  realContextHash: string,
  runIds: string[],
  codeLower: string
): any {
  if (typeof val === 'string') {
    return sanitizeString(val, realPainId, realTaskId, realContextId, realContextHash, runIds, codeLower);
  }
  if (Array.isArray(val)) {
    return val.map(v => sanitizeValue(v, realPainId, realTaskId, realContextId, realContextHash, runIds, codeLower));
  }
  if (val !== null && typeof val === 'object') {
    const res: any = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = sanitizeValue(v, realPainId, realTaskId, realContextId, realContextHash, runIds, codeLower);
    }
    return res;
  }
  return val;
}

/**
 * Anonymize and sanitize the JSON payload to avoid leaking absolute local machine paths or real session/user info.
 */
function sanitizePayload(
  fixtureCode: string,
  realPainId: string,
  realTaskId: string,
  realContextId: string,
  realContextHash: string,
  runIds: string[],
  contextPayload: any,
  monolithOutput: any
): { contextPayload: any; monolithOutput: any } {
  const codeLower = fixtureCode.toLowerCase();

  const sanitizedContext = sanitizeValue(
    contextPayload,
    realPainId,
    realTaskId,
    realContextId,
    realContextHash,
    runIds,
    codeLower
  );

  const sanitizedMonolith = monolithOutput ? sanitizeValue(
    monolithOutput,
    realPainId,
    realTaskId,
    realContextId,
    realContextHash,
    runIds,
    codeLower
  ) : null;

  return {
    contextPayload: sanitizedContext,
    monolithOutput: sanitizedMonolith,
  };
}

async function main() {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  const historyQuery = new SqliteHistoryQuery(stateManager.connection);
  const assembler = new SqliteContextAssembler(
    stateManager.taskStore,
    historyQuery,
    stateManager.runStore
  );

  console.log(`Starting export of comparison fixtures from ${workspaceDir}...`);
  console.log(`Output directory: ${outputDir}`);

  for (const [code, painId] of Object.entries(painIds)) {
    const taskId = `diagnosis_${painId}`;
    console.log(`\nProcessing ${code}: ${taskId}`);

    try {
      // Assemble raw context payload
      const contextPayload = await assembler.assemble(taskId);

      // Get monolith output from the succeeded run
      const runs = await stateManager.runStore.listRunsByTask(taskId);
      const succeededRun = runs.find(r => r.executionStatus === 'succeeded');

      let monolithOutput = null;
      if (succeededRun && succeededRun.outputPayload) {
        try {
          monolithOutput = JSON.parse(succeededRun.outputPayload);
        } catch {
          console.warn(`      Failed to parse outputPayload for run ${succeededRun.runId}`);
        }
      }

      // Collect run IDs to sanitize them
      const runIds = runs.map(r => r.runId);

      // Sanitize both payloads
      const sanitized = sanitizePayload(
        code,
        painId,
        taskId,
        contextPayload.contextId || '',
        contextPayload.contextHash || '',
        runIds,
        contextPayload,
        monolithOutput
      );

      // Set manually balanced category
      const category = CATEGORIES[code] || 'Design';

      // Map expected axioms based on descriptions/categories
      let coveredAxioms: string[] = [];
      const reason = sanitized.contextPayload.diagnosisTarget.reasonSummary || '';
      if (reason.includes('测试') || reason.includes('test')) {
        coveredAxioms.push('T-03');
      }
      if (reason.includes('重构') || reason.includes('refactor') || reason.includes('枚举')) {
        coveredAxioms.push('T-01');
      }
      if (reason.includes('CLI') || reason.includes('路由')) {
        coveredAxioms.push('T-02');
      }
      if (coveredAxioms.length === 0) {
        coveredAxioms.push('T-03');
      }

      const fixture = {
        id: code,
        painId: `pain_${code.toLowerCase()}`,
        source: sanitized.contextPayload.diagnosisTarget.source || 'unknown',
        description: sanitized.contextPayload.diagnosisTarget.reasonSummary || '',
        coveredAxioms,
        isSynthetic: false,
        contextPayload: {
          ...sanitized.contextPayload,
          workspaceDir: '/workspace', // Force stable normalized path
        },
        monolithOutput: sanitized.monolithOutput,
        category,
      };

      const fileContent = JSON.stringify(fixture, null, 2);

      // ── Sanitization Guard (Reject unsanitized fixtures by default) ──
      const forbiddenChecks = [
        { pattern: /[a-zA-Z]:[\\/]\.openclaw/i, name: 'Absolute openclaw path' },
        { pattern: /[a-zA-Z]:[\\/]Code[\\/]principles/i, name: 'Absolute project path' },
        { pattern: /Administrator/i, name: 'Administrator username' },
        { pattern: new RegExp(painId, 'i'), name: `Real Pain ID (${painId})` },
        { pattern: new RegExp(taskId, 'i'), name: `Real Task ID (${taskId})` }
      ];

      for (const check of forbiddenChecks) {
        if (check.pattern.test(fileContent)) {
          console.error(`ERROR: Sanitization guard triggered for ${code}! Found ${check.name} in content.`);
          process.exit(1);
        }
      }

      const fileName = `${code.toLowerCase()}.json`;
      const filePath = path.join(outputDir, fileName);
      fs.writeFileSync(filePath, fileContent, 'utf8');
      console.log(`      Written sanitized: ${filePath}`);
    } catch (err: any) {
      console.error(`      Error processing ${taskId}:`, err.message);
      process.exit(1);
    }
  }

  console.log('\n=== Sanitized Export Done ===');
}

main().catch(console.error);
