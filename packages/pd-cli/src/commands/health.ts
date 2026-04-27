/**
 * pd health command implementation.
 *
 * Usage: pd health
 *
 * Queries CentralHealthService.getAllWorkspaceHealth() and displays
 * verbose diagnostic output for all enabled workspaces.
 */

async function loadCentralHealthService(): Promise<{ CentralHealthService: new () => {
  getAllWorkspaceHealth(): {
    generatedAt: string;
    workspaces: {
      workspaceName: string;
      health: {
        activeStage: string;
        gfi: { current: unknown; peakToday: unknown; threshold: unknown; trend: unknown };
        trust: { stage: unknown; stageLabel: unknown; score: unknown };
        evolution: { tier: unknown; points: unknown };
        painFlag: { active: unknown; source?: unknown; score?: unknown };
        principles: { candidate: unknown; probation: unknown; active: unknown; deprecated: unknown };
        queue: { pending: unknown; inProgress: unknown; completed: unknown };
      };
    }[];
  };
} }> {
  const importModule = Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{
    CentralHealthService: new () => {
      getAllWorkspaceHealth(): ReturnType<Awaited<ReturnType<typeof loadCentralHealthService>>['CentralHealthService']['prototype']['getAllWorkspaceHealth']>;
    };
  }>;
  return importModule('../../../openclaw-plugin/src/service/central-health-service.js');
}

export async function handleHealth(): Promise<void> {
  const { CentralHealthService } = await loadCentralHealthService();
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
