import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TrajectoryDatabase } from '../../src/core/trajectory.js';
import { ControlUiQueryService } from '../../src/service/control-ui-query-service.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

describe('ControlUiQueryService', () => {
  let workspaceDir: string | null = null;

  afterEach(() => {
    WorkspaceContext.clearCache();
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it('returns null for unknown thinking models', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-query-service-'));
    const trajectory = new TrajectoryDatabase({ workspaceDir });
    trajectory.dispose();

    const service = new ControlUiQueryService(workspaceDir);
    expect(service.getThinkingModelDetail('UNKNOWN')).toBeNull();
    service.dispose();
  });

  it('labels overview responses as trajectory analytics rather than runtime control state', () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-query-service-overview-'));
    const trajectory = new TrajectoryDatabase({ workspaceDir });
    trajectory.dispose();

    const service = new ControlUiQueryService(workspaceDir);
    const overview = service.getOverview();

    expect(overview.dataSource).toBe('trajectory_db_analytics');
    expect(overview.runtimeControlPlaneSource).toBe('pd_evolution_status');
    service.dispose();
  });
});
