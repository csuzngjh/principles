// PRI-819 regression: the telemetry production smoke's generated
// .pd/config.yaml once carried a duplicate `enabled:` mapping key (an orphan
// line left behind when empathyObserver was retired). This test parses the
// EXACT YAML the smoke installs with the production loader's own parser and
// validates it with the real @principles/core config validator, so a config
// regression fails here instead of a manual smoke run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { validatePdConfig } from '@principles/core/runtime-v2';
import { buildTelemetrySmokeConfigYaml } from '../lib/telemetry-smoke-config.mjs';

describe('telemetry production smoke config', () => {
  it('builds YAML that the production loader path parses without duplicate keys', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-smoke-cfg-'));
    const raw = buildTelemetrySmokeConfigYaml(workspace);

    // Same call shape as the production loader (host-runtime pd-config.ts):
    // js-yaml throws "duplicated mapping key" by default, so a successful
    // parse IS the duplicate-key guard.
    const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
    expect(parsed).toBeTruthy();

    const agents = (parsed as { internalAgents?: { agents?: Record<string, unknown> } }).internalAgents?.agents ?? {};
    expect(Object.keys(agents).sort()).toEqual(
      ['artificer', 'correctionObserver', 'diagnostician', 'dreamer', 'evaluator', 'philosopher', 'rolloutReviewer', 'scribe', 'signalCollector'].sort(),
    );
    for (const entry of Object.values(agents)) {
      expect((entry as { enabled?: unknown }).enabled).toBe(false);
    }
  });

  it('passes the real @principles/core validatePdConfig contract', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-tel-smoke-cfg-'));
    const raw = buildTelemetrySmokeConfigYaml(workspace);
    const parsed: unknown = yaml.load(raw, { schema: yaml.JSON_SCHEMA });

    const result = validatePdConfig(parsed);
    expect(result.ok).toBe(true);
  });
});
