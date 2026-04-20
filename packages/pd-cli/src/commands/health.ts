/**
 * pd health command implementation.
 *
 * Usage: pd health
 *
 * Queries CentralHealthService.getAllWorkspaceHealth() and displays
 * verbose diagnostic output for all enabled workspaces.
 */

import { CentralHealthService } from '../../../openclaw-plugin/src/service/central-health-service.js';

interface HealthOptions {}

export async function handleHealth(_opts: HealthOptions): Promise<void> {
  const service = new CentralHealthService();
  const result = service.getAllWorkspaceHealth();

  if (result.workspaces.length === 0) {
    console.log('No workspaces found.');
    return;
  }

  console.log(`generatedAt: ${result.generatedAt}`);
  console.log(`workspaceCount: ${result.workspaces.length}`);
  console.log('');

  for (const ws of result.workspaces) {
    console.log(`[${ws.workspaceName}]`);
    const h = ws.health;
    console.log(`activeStage: ${h.activeStage}`);
    console.log(`gfi.current: ${h.gfi.current}`);
    console.log(`gfi.peakToday: ${h.gfi.peakToday}`);
    console.log(`gfi.threshold: ${h.gfi.threshold}`);
    console.log(`gfi.trend: ${JSON.stringify(h.gfi.trend)}`);
    console.log(`trust.stage: ${h.trust.stage}`);
    console.log(`trust.stageLabel: ${h.trust.stageLabel}`);
    console.log(`trust.score: ${h.trust.score}`);
    console.log(`evolution.tier: ${h.evolution.tier}`);
    console.log(`evolution.points: ${h.evolution.points}`);
    console.log(`painFlag.active: ${h.painFlag.active}`);
    console.log(`painFlag.source: ${h.painFlag.source ?? 'null'}`);
    console.log(`painFlag.score: ${h.painFlag.score ?? 'null'}`);
    console.log(`principles.candidate: ${h.principles.candidate}`);
    console.log(`principles.probation: ${h.principles.probation}`);
    console.log(`principles.active: ${h.principles.active}`);
    console.log(`principles.deprecated: ${h.principles.deprecated}`);
    console.log(`queue.pending: ${h.queue.pending}`);
    console.log(`queue.inProgress: ${h.queue.inProgress}`);
    console.log(`queue.completed: ${h.queue.completed}`);
    console.log('');
  }
}
