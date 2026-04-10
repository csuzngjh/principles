#!/usr/bin/env node

/**
 * Minimal Rule Bootstrap CLI (Phase 17)
 *
 * Seeds 1-3 stub Rule entities for high-value deterministic principles.
 * Idempotent: re-running skips already-existing rules.
 *
 * Usage:
 *   npm run bootstrap-rules                        # default (3 principles)
 *   BOOTSTRAP_LIMIT=2 npm run bootstrap-rules      # limit to 2 principles
 *   STATE_DIR=/path/to/state npm run bootstrap-rules  # custom state dir
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..');
const STATE_DIR = process.env.STATE_DIR || join(PROJECT_ROOT, '..', '.state');
const LIMIT = parseInt(process.env.BOOTSTRAP_LIMIT || '3', 10);

async function run() {
  let BootstrapModule;
  try {
    BootstrapModule = await import('../dist/core/bootstrap-rules.js');
  } catch {
    console.error('Bootstrap module not found in dist/. Build first: node esbuild.config.js');
    process.exit(1);
  }

  const { bootstrapRules, validateBootstrap, selectPrinciplesForBootstrap } = BootstrapModule;

  console.log('Selecting principles for bootstrap...');
  console.log(`  State dir: ${STATE_DIR}`);
  console.log(`  Limit: ${LIMIT}`);

  try {
    const selectedIds = selectPrinciplesForBootstrap(STATE_DIR, LIMIT);
    console.log(`  Selected ${selectedIds.length} principle(s): ${selectedIds.join(', ')}`);

    console.log('\nRunning bootstrap...');
    const results = bootstrapRules(STATE_DIR, LIMIT);

    for (const r of results) {
      console.log(`  ${r.status === 'created' ? '+' : '='} ${r.principleId} -> ${r.ruleId} (${r.status})`);
    }

    const created = results.filter((r) => r.status === 'created');
    const skipped = results.filter((r) => r.status === 'skipped');
    console.log(`\nDone: ${created.length} created, ${skipped.length} skipped.`);

    if (created.length > 0) {
      console.log('\nValidating...');
      const valid = validateBootstrap(STATE_DIR, selectedIds);
      console.log(`  Validation: ${valid ? 'PASS' : 'FAIL'}`);
    }
  } catch (err) {
    console.error(`\nBootstrap failed: ${err.message}`);
    process.exit(1);
  }
}

run();
