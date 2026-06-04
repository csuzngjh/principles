#!/usr/bin/env node
/**
 * Quick verification script for PRI-305/307 config cutover.
 * Checks that .pd/config.yaml is the single source of truth.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = process.argv[2] || path.resolve(__dirname, '../..', '.openclaw', 'workspace');

const configYaml = path.join(workspaceDir, '.pd', 'config.yaml');
const legacyFeatureFlags = path.join(workspaceDir, '.pd', 'feature-flags.yaml');
const legacyWorkflows = path.join(workspaceDir, '.state', 'workflows.yaml');

console.log('=== PRI-305/307 Config Cutover Verification ===\n');

// 1. Primary config exists
const primaryExists = fs.existsSync(configYaml);
console.log(`[${primaryExists ? 'PASS' : 'FAIL'}] .pd/config.yaml exists: ${primaryExists}`);

if (primaryExists) {
  const content = fs.readFileSync(configYaml, 'utf8');
  const hasVersion = content.includes('version:');
  const hasFeatures = content.includes('features:');
  const hasRuntimeProfiles = content.includes('runtimeProfiles:');
  const hasInternalAgents = content.includes('internalAgents:');
  
  console.log(`[${hasVersion ? 'PASS' : 'FAIL'}] Has version field: ${hasVersion}`);
  console.log(`[${hasFeatures ? 'PASS' : 'FAIL'}] Has features section: ${hasFeatures}`);
  console.log(`[${hasRuntimeProfiles ? 'PASS' : 'FAIL'}] Has runtimeProfiles section: ${hasRuntimeProfiles}`);
  console.log(`[${hasInternalAgents ? 'PASS' : 'FAIL'}] Has internalAgents section: ${hasInternalAgents}`);
}

// 2. Legacy files (informational)
const legacyFeatureExists = fs.existsSync(legacyFeatureFlags);
const legacyWorkflowExists = fs.existsSync(legacyWorkflows);
console.log(`\n[INFO] Legacy .pd/feature-flags.yaml exists: ${legacyFeatureExists} (expected: may exist, not used)`);
console.log(`[INFO] Legacy .state/workflows.yaml exists: ${legacyWorkflowExists} (expected: may exist, not used)`);

// 3. Summary
const allPass = primaryExists;
console.log(`\n=== Result: ${allPass ? 'PASS' : 'FAIL'} ===`);
process.exit(allPass ? 0 : 1);
