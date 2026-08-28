import { describe, expect, it, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadFeatureFlagFromConfig,
  loadPdConfigForPlugin,
} from '../src/pd-config.js';

/**
 * PRI-609 integration coverage — the real production consumer path.
 *
 * Production consumers (openclaw-plugin pain.ts / llm.ts / gate-block-helper.ts)
 * read the canonical camelCase IDs via `loadFeatureFlagFromConfig`. These tests
 * write a REAL `.pd/config.yaml` to disk and drive the REAL loader chain
 * (yaml parse → validatePdConfig → computeEffectivePdConfig →
 * computeFeatureFlagsFromConfig), asserting that a snake_case alias config key
 * controls the canonical flag the consumer reads.
 *
 * The alias-disable scenario is the negative control for the pre-fix defect:
 * before PRI-609, `pain_evidence_admission: {enabled: false}` left
 * `painEvidenceAdmission` at its default-on value — a silently dead kill
 * switch. This test fails against that state.
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
  it('snake_case alias disable reaches the canonical flag the production consumer reads (kill-switch fix)', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  code_tool_hook:     { category: core,  enabled: true }
  defer_archive:      { category: core,  enabled: true }
  pain_evidence_admission: { category: quiet, enabled: false }`),
    );

    // The exact call production consumers make (pain.ts:503 reads
    // 'painEvidenceAdmission' through this function).
    const triage = loadFeatureFlagFromConfig(dir, 'painEvidenceAdmission');
    expect(triage.enabled).toBe(false);

    // The alias key itself must not exist as an independent capability.
    const loadResult = loadPdConfigForPlugin(dir);
    expect(loadResult.ok).toBe(true);
    expect(loadResult.warnings.some(w => w.includes('pain_evidence_admission'))).toBe(false);
  });

  it('snake_case alias disable also reaches painEvidenceAdmissionDefault', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  code_tool_hook:     { category: core,  enabled: true }
  defer_archive:      { category: core,  enabled: true }
  pain_evidence_admission_default: { category: quiet, enabled: false }`),
    );

    const killSwitch = loadFeatureFlagFromConfig(dir, 'painEvidenceAdmissionDefault');
    expect(killSwitch.enabled).toBe(false);
  });

  it('canonical + alias with different values is a non-silent conflict; canonical wins', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  painEvidenceAdmission:      { category: quiet, enabled: true }
  pain_evidence_admission:    { category: quiet, enabled: false }`),
    );

    const loadResult = loadPdConfigForPlugin(dir);
    expect(loadResult.ok).toBe(true);
    expect(
      loadResult.warnings.some(w => w.includes("feature 'painEvidenceAdmission': conflicting values")),
    ).toBe(true);

    const triage = loadFeatureFlagFromConfig(dir, 'painEvidenceAdmission');
    expect(triage.enabled).toBe(true);
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

  it('existing valid config without pain flags keeps registry defaults (compatibility)', () => {
    const dir = makeWorkspace(
      baseYaml(`  prompt:             { category: core,  enabled: true }
  code_tool_hook:     { category: core,  enabled: true }
  defer_archive:      { category: core,  enabled: true }`),
    );

    const triage = loadFeatureFlagFromConfig(dir, 'painEvidenceAdmission');
    expect(triage.enabled).toBe(true);
    const killSwitch = loadFeatureFlagFromConfig(dir, 'painEvidenceAdmissionDefault');
    expect(killSwitch.enabled).toBe(true);
  });
});
