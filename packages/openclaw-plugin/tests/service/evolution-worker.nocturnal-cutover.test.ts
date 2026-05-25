/**
 * PRI-119: Nocturnal Caller Cutover Tests
 *
 * Validates that production paths no longer initiate Nocturnal business execution
 * after the ADR-0012 cutover to Runtime V2.
 *
 * These tests guard against regression where legacy Nocturnal callers could be
 * accidentally restored.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PLUGIN_SRC = path.resolve(__dirname, '../../src');
const EVOLUTION_WORKER_PATH = path.join(PLUGIN_SRC, 'service', 'evolution-worker.ts');
const INDEX_PATH = path.join(PLUGIN_SRC, 'index.ts');
const PD_REFLECT_PATH = path.join(PLUGIN_SRC, 'commands', 'pd-reflect.ts');

function readFileLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8').split('\n');
}

function findLineContaining(lines: string[], pattern: string | RegExp): number {
  const idx = lines.findIndex(l => typeof pattern === 'string' ? l.includes(pattern) : pattern.test(l));
  return idx + 1; // 1-based
}

describe('PRI-119: Nocturnal caller cutover guards', () => {

  describe('pd-reflect command retirement', () => {
    const content = fs.readFileSync(PD_REFLECT_PATH, 'utf8');

    it('returns structured retirement message with ADR-0012 reference', () => {
      expect(content).toContain('ADR-0012');
      expect(content).toContain('retired');
      expect(content).toContain('Next action');
    });

    it('no longer imports queue-io or evolution-worker', () => {
      expect(content).not.toContain('acquireQueueLock');
      expect(content).not.toContain('atomicWriteFileSync');
    });
  });

  describe('index.ts nocturnal command rejection', () => {
    const content = fs.readFileSync(INDEX_PATH, 'utf8');
    const lines = readFileLines(INDEX_PATH);

    it('no longer imports nocturnal command handlers', () => {
      expect(content).not.toContain("from './commands/nocturnal-review.js'");
      expect(content).not.toContain("from './commands/nocturnal-train.js'");
      expect(content).not.toContain("from './commands/nocturnal-rollout.js'");
    });

    it('marks nocturnal commands as RETIRED in description', () => {
      expect(content).toContain('[RETIRED] Nocturnal review retired per ADR-0012');
      expect(content).toContain('[RETIRED] Nocturnal training retired per ADR-0012');
      expect(content).toContain('[RETIRED] Nocturnal rollout retired per ADR-0012');
    });

    it('pd-reflect description indicates retirement', () => {
      // pd-reflect handler is in pd-reflect.ts, but the registration in index.ts
      // should still work — just delegates to the retired handler
      expect(content).toContain("registerCommandWithAlias('pd-reflect'");
    });
  });

  describe('evolution-worker heartbeat Nocturnal retirement', () => {
    const content = fs.readFileSync(EVOLUTION_WORKER_PATH, 'utf8');

    it('heartbeat runCycle logs nocturnal=retired_per_ADR-0012', () => {
      expect(content).toContain('nocturnal=retired_per_ADR-0012');
    });

    it('no longer loads nocturnal config in heartbeat', () => {
      // loadNocturnalConfigMerged should NOT appear in the heartbeat runCycle
      const runCycleStart = content.indexOf('async function runCycle()');
      const runCycleEnd = content.indexOf('writeWorkerStatus(', runCycleStart);
      const runCycleBody = content.substring(runCycleStart, runCycleEnd);

      // loadNocturnalConfigMerged may still be imported for dead code but
      // should not be called in the active heartbeat path
      expect(runCycleBody).not.toContain('loadNocturnalConfigMerged');
      expect(runCycleBody).not.toContain('checkWorkspaceIdle');
      expect(runCycleBody).not.toContain('checkCooldown');
    });

    it('terminalizes retired sleep_reflection tasks in processEvolutionQueue', () => {
      expect(content).toContain("retiredKinds.includes(task.taskKind) && (task.status === 'pending' || task.status === 'in_progress')");
      expect(content).toContain("task.resolution = 'retired'");
      expect(content).toContain('retired per ADR-0012 / PRI-119');
    });

    it('terminalizes both sleep_reflection and keyword_optimization task kinds', () => {
      expect(content).toContain("retiredKinds = ['sleep_reflection', 'keyword_optimization']");
    });

    it('does not re-export enqueueSleepReflectionTask', () => {
      // The re-export line was removed — the function still exists in queue-io.ts
      // but is no longer exported through evolution-worker
      const exportLines = content.split('\n').filter(l =>
        l.trim().startsWith('export') && l.includes('enqueueSleepReflectionTask')
      );
      expect(exportLines).toHaveLength(0);
    });

    it('NocturnalWorkflowManager not instantiated in active heartbeat sweep', () => {
      const runCycleStart = content.indexOf('async function runCycle()');
      const runCycleEnd = content.indexOf('writeWorkerStatus(', runCycleStart);
      const runCycleBody = content.substring(runCycleStart, runCycleEnd);

      // The sweep section should NOT create new NocturnalWorkflowManager
      const sweepSection = runCycleBody.substring(
        runCycleBody.indexOf('PRI-119: NocturnalWorkflowManager retired'),
        runCycleBody.indexOf('Workflow Watchdog')
      );
      expect(sweepSection).not.toContain('new NocturnalWorkflowManager');
    });
  });

  describe('preserved MVP-Core paths', () => {
    const content = fs.readFileSync(EVOLUTION_WORKER_PATH, 'utf8');

    it('compilation backfill still runs in heartbeat', () => {
      const runCycleStart = content.indexOf('async function runCycle()');
      const runCycleEnd = content.indexOf('writeWorkerStatus(', runCycleStart);
      const runCycleBody = content.substring(runCycleStart, runCycleEnd);
      expect(runCycleBody).toContain('processCompilationBackfill');
    });

    it('workflow watchdog still runs in heartbeat', () => {
      const runCycleStart = content.indexOf('async function runCycle()');
      const runCycleEnd = content.indexOf('writeWorkerStatus(', runCycleStart);
      const runCycleBody = content.substring(runCycleStart, runCycleEnd);
      expect(runCycleBody).toContain('runWorkflowWatchdog');
    });

    it('EvolutionWorkerService.start still exists for non-Nocturnal work', () => {
      expect(content).toContain('EvolutionWorkerService');
      expect(content).toContain('start(ctx:');
    });
  });

  describe('blocked MVP-Core dependencies remain intact', () => {
    it('replay-engine.ts still exists (RuleHost dependency)', () => {
      const replayPath = path.join(PLUGIN_SRC, 'core', 'replay-engine.ts');
      expect(fs.existsSync(replayPath)).toBe(true);
    });

    it('promote-impl.ts still exists (RuleHost dependency)', () => {
      const promotePath = path.join(PLUGIN_SRC, 'commands', 'promote-impl.ts');
      expect(fs.existsSync(promotePath)).toBe(true);
    });

    it('filesystem-lifecycle-datasource still imports nocturnal-artifact-lineage', () => {
      const datasourcePath = path.join(
        PLUGIN_SRC, 'core', 'principle-internalization', 'filesystem-lifecycle-datasource.ts'
      );
      const content = fs.readFileSync(datasourcePath, 'utf8');
      expect(content).toContain('listArtifactLineageRecords');
    });
  });
});
