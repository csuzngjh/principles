import { describe, expect, it, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadFeatureFlagFromConfig,
  loadPdConfigForPlugin,
} from '../src/pd-config.js';

/**
 * PRI-763 integration coverage — retired pain admission flag contract.
 *
 * The pain admission flags (painEvidenceAdmission / painEvidenceAdmissionDefault)
 * and their snake_case aliases were retired (PRI-763): admission is unconditional
 * Gate B (TriggerController). A stale snake_case key on an existing config must
 * be diagnosed as unknown and never read back as an enabled capability through
 * the real production loader chain (yaml parse → validatePdConfig →
 * computeEffectivePdConfig → computeFeatureFlagsFromConfig).
 */

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-alias-it-'));

function makeWorkspace(configYaml: string): string {
  const dir = path.join(tempRoot, `ws-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pd', 'config.yaml'), configYaml, 'utf8');
  return dir;
}

function baseYaml(featuresBlock: string): string {
  // Minimal shape mirroring what the installer generates (mvp-config.ts
  // generateConfigYamlContent): version + features + runtimeProfiles +
  // internalAgents + ui. Flag under test is appended to features.
  return `version: 1
features:
${featuresBlock}
runtimeProfiles:
  pd.default:
    type: pi-ai
    provider: ""
    model: ""
    apiKeyEnv: ""
  openclaw.default:
    type: openclaw
    source: default
internalAgents:
  defaultRuntime: pd.default
  agents:
    diagnostician:      { enabled: true,  runtimeProfile: pd.default }
    dreamer:            { enabled: true,  runtimeProfile: pd.default }
    philosopher:        { enabled: false, runtimeProfile: pd.default }
    scribe:             { enabled: true,  runtimeProfile: pd.default }
    artificer:          { enabled: true,  runtimeProfile: pd.default }
    evaluator:          { enabled: false, runtimeProfile: pd.default }
    rolloutReviewer:    { enabled: false, runtimeProfile: pd.default }
    correctionObserver: { enabled: false, runtimeProfile: pd.default }
    empathyObserver:    { enabled: false, runtimeProfile: pd.default }
    signalCollector:    { enabled: false, runtimeProfile: pd.default }
ui:
  diagnostics: { mode: simple }
`;
}

afterAll(() => {
  // Windows: tolerate EPERM on temp cleanup — the assertions above already ran.
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignored */
  }
});

describe('PRI-609 feature flag alias identity — production loader integration', () => {
  it('PRI-763: stale canonical pain key is diagnosed unknown and reads back disabled', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  code_tool_hook:     { category: core,  enabled: true }
  defer_archive:      { category: core,  enabled: true }
  painEvidenceAdmission: { category: quiet, enabled: true }`),
    );

    const loadResult = loadPdConfigForPlugin(dir);
    expect(loadResult.ok).toBe(true);
    expect(
      loadResult.warnings.some(w => w.includes("feature 'painEvidenceAdmission': unknown flag ignored")),
    ).toBe(true);

    // A consumer asking for the retired ID reads disabled — never an effective
    // runtime capability.
    const triage = loadFeatureFlagFromConfig(dir, 'painEvidenceAdmission');
    expect(triage.enabled).toBe(false);
  });

  it('PRI-763: stale snake_case pain key is diagnosed unknown and reads back disabled', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  code_tool_hook:     { category: core,  enabled: true }
  defer_archive:      { category: core,  enabled: true }
  pain_evidence_admission: { category: quiet, enabled: false }`),
    );

    const loadResult = loadPdConfigForPlugin(dir);
    expect(loadResult.ok).toBe(true);
    expect(
      loadResult.warnings.some(w => w.includes("feature 'pain_evidence_admission': unknown flag ignored")),
    ).toBe(true);

    const triage = loadFeatureFlagFromConfig(dir, 'pain_evidence_admission');
    expect(triage.enabled).toBe(false);
  });

  it('unknown flag key is diagnosed and never reads back as an enabled capability', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  totally_unknown_flag: { category: quiet, enabled: true }`),
    );

    const loadResult = loadPdConfigForPlugin(dir);
    expect(loadResult.ok).toBe(true);
    expect(
      loadResult.warnings.some(w => w.includes("feature 'totally_unknown_flag': unknown flag ignored")),
    ).toBe(true);

    // A consumer asking for the unknown ID reads disabled — the key did not
    // become an effective runtime capability.
    const unknown = loadFeatureFlagFromConfig(dir, 'totally_unknown_flag');
    expect(unknown.enabled).toBe(false);
  });

  it('PRI-763: a config without the retired pain keys loads cleanly (no unknown warnings)', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  code_tool_hook:     { category: core,  enabled: true }
  defer_archive:      { category: core,  enabled: true }`),
    );

    const loadResult = loadPdConfigForPlugin(dir);
    expect(loadResult.ok).toBe(true);
    expect(loadResult.warnings.some(w => w.includes('painEvidenceAdmission'))).toBe(false);
    expect(loadResult.warnings.some(w => w.includes('pain_evidence_admission'))).toBe(false);
  });
});
