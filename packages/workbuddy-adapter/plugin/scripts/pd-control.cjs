#!/usr/bin/env node
'use strict';

const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== 'disable') {
    throw new Error('Usage: node pd-control.cjs disable');
  }
  const home = homedir();
  const workspace = path.join(home, '.workbuddy', 'pd-workspace');
  const entry = path.join(home, '.pd', 'bootstrap', 'executor', 'dist', 'installers', 'workbuddy-host-installer.js');
  if (!existsSync(entry)) throw new Error(`official_installer_api_missing: ${entry}`);
  if (!existsSync(path.join(workspace, '.pd', 'config.yaml'))) {
    throw new Error(`workbuddy_governance_config_missing: ${workspace}`);
  }
  const api = await import(pathToFileURL(entry).href);
  if (typeof api.setWorkbuddyGovernanceFlag !== 'function'
    || typeof api.readWorkbuddyGovernanceFlagOverride !== 'function') {
    throw new Error('official_installer_api_unavailable');
  }
  const result = api.setWorkbuddyGovernanceFlag(workspace, false);
  if (!result.ok) {
    process.stdout.write(JSON.stringify({ ...result, host: 'workbuddy', workspace }) + '\n');
    process.exitCode = 1;
    return;
  }
  if (api.readWorkbuddyGovernanceFlagOverride(workspace) !== false) {
    throw new Error('workbuddy_disable_readback_failed');
  }
  process.stdout.write(JSON.stringify({ ok: true, host: 'workbuddy', workspace, enabled: false }) + '\n');
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    host: 'workbuddy',
    reason: error instanceof Error ? error.message : String(error),
    nextAction: 'Use the official installer: npx create-principles-disciple repair-update-chain; if the WorkBuddy workspace is missing, run npx create-principles-disciple --host workbuddy.',
  }) + '\n');
  process.exitCode = 1;
});
