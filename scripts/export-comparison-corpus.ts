import * as fs from 'node:fs';
import * as path from 'node:path';
import { RuntimeStateManager } from '../packages/principles-core/src/runtime-v2/store/runtime-state-manager.js';
import { SqliteHistoryQuery } from '../packages/principles-core/src/runtime-v2/store/history/sqlite-history-query.js';
import { SqliteContextAssembler } from '../packages/principles-core/src/runtime-v2/store/context/sqlite-context-assembler.js';

// Parse CLI Arguments
const args = process.argv.slice(2);
const workspaceArg = args.find(a => a.startsWith('--workspace='));
const workspaceDir = workspaceArg ? workspaceArg.split('=')[1] : 'D:/.openclaw/workspace';

const outputArg = args.find(a => a.startsWith('--output-dir='));
const outputDir = outputArg ? path.resolve(outputArg.split('=')[1]) : path.resolve('D:/Code/principles/spike/comparison-fixtures');

const painIdFileArg = args.find(a => a.startsWith('--pain-id-file='));
const painIdFile = painIdFileArg ? painIdFileArg.split('=')[1] : null;

// Validate workspace
if (!fs.existsSync(workspaceDir)) {
  console.error(`ERROR: Workspace directory not found: ${workspaceDir}`);
  process.exit(1);
}

let painIds: Record<string, string> = {
  R1: 'manual_1780787633659_8im5rx7t',
  R2: 'manual_1780799247483_e198d6c5',
  R3: 'pain_1780901574214_ee9bf61c',
  R5: 'manual_1780931134915_tiuyvu0g',
  R6: 'manual_1781081305247_1ljln5z9',
  R7: 'manual_1781081347155_07o22nkt',
  R8: 'manual_1781085374008_390dqclz',
  R9: 'manual_1781085229910_wu2k60wq',
  R10: 'manual_1781081025494_a5us15a9',
  R11: 'manual_1781079251251_llyt4bto',
  R12: 'manual_1781079170097_vmk43ld6',
  R13: 'manual_1781079082974_v1lnyqbk',
  R14: 'manual_1781061594600_fodpyr1g',
  R15: 'manual_1781061418032_wlzkhmxs',
};

if (painIdFile) {
  try {
    const raw = fs.readFileSync(painIdFile, 'utf-8');
    painIds = JSON.parse(raw);
  } catch (err: any) {
    console.error(`ERROR: Failed to read pain-id-file ${painIdFile}:`, err.message);
    process.exit(1);
  }
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
  const replacements: Array<{ pattern: RegExp; replacement: string }> = [];

  // Helper to register replacements for both original and hyphenated/underscored variants
  const registerIdReplacement = (realId: string, replacement: string) => {
    if (!realId) return;
    replacements.push({ pattern: new RegExp(realId, 'g'), replacement });

    // If it has underscores, match the version with hyphens, and vice versa
    const withHyphens = realId.replace(/_/g, '-');
    if (withHyphens !== realId) {
      replacements.push({ pattern: new RegExp(withHyphens, 'g'), replacement });
    }
    const withUnderscores = realId.replace(/-/g, '_');
    if (withUnderscores !== realId) {
      replacements.push({ pattern: new RegExp(withUnderscores, 'g'), replacement });
    }
  };

  // 1. Map IDs
  registerIdReplacement(realContextId, `ctx_${codeLower}`);
  registerIdReplacement(realContextHash, `hash_${codeLower}`);
  registerIdReplacement(realTaskId, `task_${codeLower}`);
  registerIdReplacement(realPainId, `pain_${codeLower}`);

  // Map run IDs
  runIds.forEach((runId, idx) => {
    registerIdReplacement(runId, `run_${codeLower}_${idx + 1}`);
  });

  // Re-map generated diagnosis IDs (e.g. diag-manual-timestamp)
  replacements.push({ pattern: /manual[_-]17\d+[_-]\w+/gi, replacement: `pain_${codeLower}` });
  replacements.push({ pattern: /pain[_-]17\d+[_-]\w+/gi, replacement: `pain_${codeLower}` });
  replacements.push({ pattern: /diag[_-]manual[_-]17\d+[_-]\w+/gi, replacement: `diag_${codeLower}` });
  replacements.push({ pattern: /diag[_-]manual[_-]17\d+/gi, replacement: `diag_${codeLower}` });

  // 2. Map UUID Session IDs
  replacements.push({ pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, replacement: `session_${codeLower}` });

  // 3. Map absolute paths and local environments
  replacements.push({ pattern: /[a-zA-Z]:\\(?:\\)?\.openclaw\\(?:\\)?workspace/gi, replacement: '/workspace' });
  replacements.push({ pattern: /[a-zA-Z]:\/\.openclaw\/workspace/gi, replacement: '/workspace' });
  replacements.push({ pattern: /\.openclaw\/workspace/gi, replacement: 'workspace' });

  replacements.push({ pattern: /[a-zA-Z]:\\(?:\\)?Code\\(?:\\)?principles/gi, replacement: '/project' });
  replacements.push({ pattern: /[a-zA-Z]:\/Code\/principles/gi, replacement: '/project' });

  replacements.push({ pattern: /[a-zA-Z]:\\(?:\\)?Users\\(?:\\)?\w+/gi, replacement: '/user-home' });
  replacements.push({ pattern: /[a-zA-Z]:\/Users\/\w+/gi, replacement: '/user-home' });

  replacements.push({ pattern: /[a-zA-Z]:\\(?:\\)?/gi, replacement: '/' });
  replacements.push({ pattern: /[a-zA-Z]:\//gi, replacement: '/' });

  // Redact Administrator username
  replacements.push({ pattern: /Administrator/gi, replacement: 'user' });

  // Remove local session details or sessionId hints
  replacements.push({ pattern: /No authenticated host session provenance available/gi, replacement: 'No host trace available' });
  replacements.push({ pattern: /provenanceReason":\s*"[^"]*"/gi, replacement: 'provenanceReason": "No host trace available"' });

  let payloadStr = JSON.stringify(contextPayload);
  let monolithStr = monolithOutput ? JSON.stringify(monolithOutput) : 'null';

  for (const { pattern, replacement } of replacements) {
    payloadStr = payloadStr.replace(pattern, replacement);
    monolithStr = monolithStr.replace(pattern, replacement);
  }

  // Convert backslashes in windows paths to forward slashes
  payloadStr = payloadStr.replace(/\\\\/g, '/');
  monolithStr = monolithStr.replace(/\\\\/g, '/');

  return {
    contextPayload: JSON.parse(payloadStr),
    monolithOutput: JSON.parse(monolithStr)
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
