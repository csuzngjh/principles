/**
 * Shared builder for the telemetry production smoke's workspace config
 * (PRI-603/PRI-819). Kept as its own module so tests can parse and validate
 * the EXACT YAML the smoke installs — a regression here must fail tests, not
 * a manual smoke run (PRI-819: an orphan `enabled:` line under
 * correctionObserver produced a duplicate mapping key).
 *
 * The shape must stay parseable by the production loader contract:
 * js-yaml JSON_SCHEMA + @principles/core validatePdConfig.
 */

import path from 'node:path';

export function buildTelemetrySmokeConfigYaml(workspace) {
  return [
    'version: 1',
    'workspace:',
    `  default: ${workspace.split(path.sep).join('/')}`,
    '  environment: production',
    'features:',
    '  anonymous_product_telemetry:',
    '    category: quiet',
    '    enabled: true',
    'runtimeProfiles:',
    '  openclaw.default:',
    '    type: openclaw',
    '    source: default',
    'internalAgents:',
    '  defaultRuntime: openclaw.default',
    '  agents:',
    '    diagnostician:',
    '      enabled: false',
    '    dreamer:',
    '      enabled: false',
    '    scribe:',
    '      enabled: false',
    '    artificer:',
    '      enabled: false',
    '    philosopher:',
    '      enabled: false',
    '    evaluator:',
    '      enabled: false',
    '    rolloutReviewer:',
    '      enabled: false',
    '    correctionObserver:',
    '      enabled: false',
    '    signalCollector:',
    '      enabled: false',
    '',
  ].join('\n');
}
