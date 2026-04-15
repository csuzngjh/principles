#!/usr/bin/env node

/**
 * Principle Compiler CLI
 *
 * Compiles eligible principles (those derived from pain events) into
 * auto-generated rules via the PrincipleCompiler pipeline.
 *
 * Usage:
 *   npm run compile-principles
 *   WORKSPACE_DIR=/path/to/workspace npm run compile-principles
 *   node scripts/compile-principles.mjs /path/to/workspace
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve workspace directory: CLI arg > env var > default
const WORKSPACE_DIR = process.argv[2]
  || process.env.WORKSPACE_DIR
  || join(process.env.HOME, '.openclaw', 'workspace-main');

const STATE_DIR = join(WORKSPACE_DIR, '.state');

async function run() {
  console.log('Principle Compiler CLI');
  console.log(`  Workspace: ${WORKSPACE_DIR}`);
  console.log(`  State dir: ${STATE_DIR}`);

  let compilerModule, trajectoryModule;

  try {
    compilerModule = await import('../dist/core/principle-compiler/index.js');
  } catch {
    console.error('PrincipleCompiler module not found in dist/. Build first: node esbuild.config.js');
    process.exit(1);
  }

  try {
    trajectoryModule = await import('../dist/core/trajectory/index.js');
  } catch {
    console.error('TrajectoryDatabase module not found in dist/. Build first: node esbuild.config.js');
    process.exit(1);
  }

  const { PrincipleCompiler } = compilerModule;
  const { TrajectoryDatabase } = trajectoryModule;

  let trajectory;
  try {
    trajectory = new TrajectoryDatabase({ workspaceDir: WORKSPACE_DIR });
  } catch (err) {
    console.error(`Failed to open trajectory database: ${err.message}`);
    process.exit(1);
  }

  try {
    const compiler = new PrincipleCompiler(STATE_DIR, trajectory);

    console.log('\nCompiling eligible principles...');
    const results = compiler.compileAll();

    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`\nResults: ${succeeded.length} succeeded, ${failed.length} failed`);

    for (const r of succeeded) {
      console.log(`  + ${r.principleId} -> rule ${r.ruleId} (impl: ${r.implementationId})`);
    }

    for (const r of failed) {
      console.log(`  x ${r.principleId}: ${r.reason}`);
    }

    if (results.length === 0) {
      console.log('  No eligible principles found for compilation.');
    }
  } finally {
    trajectory.dispose();
  }
}

run().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
