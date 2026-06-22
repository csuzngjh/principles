import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const srcDir = path.join(repoRoot, 'src');

function enumerateFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...enumerateFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const sourceFiles = enumerateFiles(srcDir);
const allSource = sourceFiles.map(f => fs.readFileSync(f, 'utf-8')).join('\n');

describe('PRI-448: deleted shadow/deployment/promotion modules are unreachable', () => {
  it('no production source file imports the deleted module paths', () => {
    const deletedModulePaths = [
      'core/shadow-observation-registry',
      'core/local-worker-routing',
      'core/model-deployment-registry',
      'core/promotion-gate',
      'core/model-training-registry',
      'utils/shadow-fingerprint',
    ];

    const violations: string[] = [];
    for (const filePath of sourceFiles) {
      const src = fs.readFileSync(filePath, 'utf-8');
      for (const modulePath of deletedModulePaths) {
        const importPattern = new RegExp(`from ['\"].*${modulePath}['\"]`);
        if (importPattern.test(src)) {
          violations.push(`${path.relative(repoRoot, filePath)} imports ${modulePath}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no deleted symbols remain in production source', () => {
    const deletedSymbols = [
      'recordShadowRouting',
      'completeShadowObservation',
      'completeShadowObservationByTask',
      'queryShadowObservations',
      'computeShadowStats',
      'classifyTask',
      'canRouteToProfile',
      'isAnyLocalRoutingEnabled',
      'listEnabledProfiles',
      'bindCheckpointToWorkerProfile',
      'enableRoutingForProfile',
      'isRoutingEnabledForProfile',
      'rollbackDeployment',
      'getDeployment',
      'listDeployments',
      'getFullDeploymentRegistry',
      'getDeploymentLineage',
      'evaluatePromotionGate',
      'advancePromotion',
      'getPromotionState',
      'rejectCheckpoint',
      'computeRuntimeShadowTaskFingerprint',
      'PD_LOCAL_PROFILES',
      'WorkerProfile',
    ];

    for (const symbol of deletedSymbols) {
      const pattern = new RegExp(`\\b${symbol}\\b`);
      expect(allSource).not.toMatch(pattern);
    }
  });
});
