/**
 * Migration Registry — Auto-imports all migrations.
 *
 * Add new migration files to this directory and import them here.
 * Migrations are automatically sorted by ID.
 */

import { migration as m001Trajectory } from './001-init-trajectory.js';
import { migration as m001Central } from './002-init-central.js';
import { migration as m001Workflow } from './003-init-workflow.js';
import { migration as m002ThinkingGfi } from './004-add-thinking-and-gfi.js';

import type { Migration } from '../migration-runner.js';

/**
 * All migrations, sorted by database type then ID.
 */
export const ALL_MIGRATIONS: Migration[] = [
  // trajectory.db
  m001Trajectory,
  m002ThinkingGfi,
  // central.db
  m001Central,
  // workflow.db
  m001Workflow,
].sort((a, b) => {
  if (a.db !== b.db) return a.db.localeCompare(b.db);
  return a.id.localeCompare(b.id);
});

export { m001Trajectory, m001Central, m001Workflow, m002ThinkingGfi };
