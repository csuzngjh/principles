/**
 * pd runtime flow show command — Display workflow funnel definitions from workflows.yaml.
 *
 * Usage:
 *   pd runtime flow show [--workspace <path>] [--json]
 */
import * as path from 'path';
import { WorkflowFunnelLoader } from '@principles/core';

interface FlowShowOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleFlowShow(opts: FlowShowOptions): Promise<void> {
  const workspaceDir = opts.workspace ?? process.cwd();
  const stateDir = path.join(workspaceDir, '.state');

  const loader = new WorkflowFunnelLoader(stateDir);

  if (opts.json) {
    const all = loader.getAllFunnelsWithPolicy();
    console.log(JSON.stringify({ status: 'ok', funnels: [...all.values()] }, null, 2));
    return;
  }

  const all = loader.getAllFunnelsWithPolicy();
  const funnels = [...all.values()];

  if (funnels.length === 0) {
    console.log('Workflows: (no funnels defined)\n');
    return;
  }

  console.log(`Workflows (${funnels.length} funnel${funnels.length !== 1 ? 's' : ''}):\n`);

  for (const funnel of funnels) {
    console.log(`  ${funnel.workflowId}`);
    if (funnel.policy) {
      const p = funnel.policy;
      if (p.timeoutMs) console.log(`    timeoutMs:      ${p.timeoutMs}`);
      if (p.stageOrder) console.log(`    stageOrder:     ${p.stageOrder}`);
      if (p.legacyDisabled !== undefined) console.log(`    legacyDisabled: ${p.legacyDisabled}`);
      if (p.observability?.enabled !== undefined) console.log(`    observability:  ${p.observability.enabled}`);
      if (p.observability?.logLevel) console.log(`    logLevel:       ${p.observability.logLevel}`);
      if (p.observability?.emitEvents?.length) {
        console.log(`    emitEvents:     ${p.observability.emitEvents.join(', ')}`);
      }
    }
    console.log(`    stages (${funnel.stages.length}):`);
    for (const stage of funnel.stages) {
      const parts = [`      - ${stage.name}`];
      if (stage.timeoutMs) parts.push(` timeoutMs=${stage.timeoutMs}`);
      if (stage.successCriteria) parts.push(` successCriteria="${stage.successCriteria}"`);
      if (stage.legacyDisabled) parts.push(` legacyDisabled`);
      console.log(parts.join(''));
    }
    console.log('');
  }
}
