import * as fs from 'node:fs';
import * as path from 'node:path';
import { RuntimeStateManager } from '../packages/principles-core/src/runtime-v2/store/runtime-state-manager.js';
import { SqliteHistoryQuery } from '../packages/principles-core/src/runtime-v2/store/history/sqlite-history-query.js';
import { SqliteContextAssembler } from '../packages/principles-core/src/runtime-v2/store/context/sqlite-context-assembler.js';

const WORKSPACE_DIR = 'D:/.openclaw/workspace';
const OUTPUT_DIR = path.resolve('D:/Code/principles/spike/comparison-fixtures');

const PAIN_IDS = {
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

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const stateManager = new RuntimeStateManager({ workspaceDir: WORKSPACE_DIR });
  await stateManager.initialize();
  
  const historyQuery = new SqliteHistoryQuery(stateManager.connection);
  const assembler = new SqliteContextAssembler(
    stateManager.taskStore,
    historyQuery,
    stateManager.runStore
  );

  console.log('Starting export of comparison fixtures...');

  for (const [code, painId] of Object.entries(PAIN_IDS)) {
    const taskId = `diagnosis_${painId}`;
    console.log(`\nProcessing ${code}: ${taskId}`);

    try {
      // Assemble the context payload
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

      // Estimate category and intended axioms based on the task description or previous mapping
      let category = 'Design';
      if (monolithOutput && monolithOutput.rootCauseCategory) {
        category = monolithOutput.rootCauseCategory;
      } else if (monolithOutput && monolithOutput.rootCause && monolithOutput.rootCause.includes(':')) {
        category = monolithOutput.rootCause.split(':')[0].trim();
      }

      // Simple axiom mapping based on descriptions
      let coveredAxioms: string[] = [];
      const reason = contextPayload.diagnosisTarget.reasonSummary || '';
      if (reason.includes('测试') || reason.includes('test')) {
        coveredAxioms.push('T-03'); // Evidence Over Assumption
      }
      if (reason.includes('重构') || reason.includes('refactor') || reason.includes('枚举')) {
        coveredAxioms.push('T-01'); // Survey Before Acting
      }
      if (reason.includes('CLI') || reason.includes('路由')) {
        coveredAxioms.push('T-02'); // Respect Constraints
      }
      if (coveredAxioms.length === 0) {
        coveredAxioms.push('T-03');
      }

      const fixture = {
        id: code,
        painId: painId,
        source: contextPayload.diagnosisTarget.source || 'unknown',
        description: contextPayload.diagnosisTarget.reasonSummary || '',
        coveredAxioms,
        isSynthetic: false,
        contextPayload,
        monolithOutput,
        category,
      };

      const fileName = `${code.toLowerCase()}-${painId}.json`;
      const filePath = path.join(OUTPUT_DIR, fileName);
      fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2), 'utf8');
      console.log(`      Written: ${filePath}`);
    } catch (err: any) {
      console.error(`      Error processing ${taskId}:`, err.message);
    }
  }

  console.log('\n=== Export Done ===');
}

main().catch(console.error);
