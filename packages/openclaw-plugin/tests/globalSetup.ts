/**
 * Global setup/teardown for vitest.
 *
 * This file handles cleanup of singleton instances that can cause teardown hangs
 * if not properly disposed (e.g., database connections, timers).
 */

import { EventLogService } from '../src/core/event-log.js';
import { disposeAllEvolutionLoggers } from '../src/core/evolution-logger.js';
import { disposeAllEvolutionEngines } from '../src/core/evolution-engine.js';
import { resetCentralDatabase } from '../src/service/central-database.js';
import { WorkspaceContext } from '../src/core/workspace-context.js';
import { TrajectoryRegistry } from '../src/core/trajectory.js';

export default function globalSetup() {
  // Setup: nothing to do

  // Teardown: cleanup all singleton instances
  return function globalTeardown() {
    // Close all EventLog instances (clears timers)
    EventLogService.disposeAll();

    // Close all EvolutionLogger instances
    disposeAllEvolutionLoggers();

    // Close all EvolutionEngine instances
    disposeAllEvolutionEngines();

    // Reset CentralDatabase singleton
    resetCentralDatabase();

    // Clear WorkspaceContext cache (closes TrajectoryDatabase instances)
    WorkspaceContext.clearCache();

    // Clear TrajectoryRegistry (closes remaining TrajectoryDatabase instances)
    TrajectoryRegistry.clear();
  };
}
