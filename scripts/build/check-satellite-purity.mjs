// OPT-002 guard: satellite bundles must not contain the LLM SDK graph.
//
// governance-audit.js and rulehost-evidence.js are small read-side artifacts;
// they never call an LLM at runtime. Before OPT-002 they each carried ~2.7 MB
// of pi-ai / pi-agent-core / undici / @google/genai / anthropic / openai
// pulled in transitively through VALUE imports of the
// `@principles/core/runtime-v2` barrel. This guard turns reintroducing that
// propagation (e.g. a future `import { X } from '@principles/core/runtime-v2'`
// on a satellite path) from an engineering-discipline problem into a build
// failure.
//
// Wired into packages/openclaw-plugin/esbuild.config.js on every official
// bundle build (dev + production), fed the live esbuild metafile. Also usable
// as a CLI over a persisted metafile JSON for tests and forensics:
//   node scripts/build/check-satellite-purity.mjs --metafile <file.json>

import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

/** Satellite bundle outputs, by filename suffix (metafile keys are paths). */
export const SATELLITE_OUTPUT_SUFFIXES = [
  'governance-audit.js',
  'rulehost-evidence.js',
];

/**
 * Vendored LLM SDK package path segments (rc: matched as /<pkg>/ path
 * segments under node_modules only, so source-file names never trip it).
 * bundle.js is excluded from the check: the main package legitimately owns
 * the LLM runtime (host adapters) — see OPT-002.
 */
export const FORBIDDEN_LLM_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@anthropic-ai',
  'openai',
  '@google/genai',
  'undici',
];

const EXAMPLE_INPUTS_PER_PACKAGE = 3;

function normalizePath(p) {
  return p.replaceAll('\\', '/').toLowerCase();
}

/**
 * @param {unknown} metafile esbuild BuildResult.metafile (validated as unknown, rc-1)
 * @returns {{output: string, input: string, pkg: string}[]} one row per violating input
 */
export function collectSatelliteViolations(metafile) {
  if (typeof metafile !== 'object' || metafile === null || !Object.hasOwn(metafile, 'outputs')) {
    throw new Error('[satellite-purity] invalid input: expected an esbuild metafile object with an `outputs` map');
  }
  const outputs = /** @type {Record<string, unknown>} */ (metafile.outputs);
  const violations = [];
  for (const [outputPath, output] of Object.entries(outputs)) {
    const isSatellite = SATELLITE_OUTPUT_SUFFIXES.some((suffix) => outputPath.endsWith(suffix));
    if (!isSatellite) continue;
    const inputs = (typeof output === 'object' && output !== null && typeof output.inputs === 'object' && output.inputs !== null)
      ? Object.keys(/** @type {Record<string, unknown>} */ (output.inputs))
      : [];
    for (const inputPath of inputs) {
      const norm = normalizePath(inputPath);
      if (!norm.includes('node_modules/')) continue;
      const hit = FORBIDDEN_LLM_PACKAGES.find((pkg) => norm.includes(`/${pkg.toLowerCase()}/`));
      if (hit) violations.push({ output: outputPath, input: inputPath, pkg: hit });
    }
  }
  return violations;
}

/**
 * Fail loud (rc-3/rc-9): throws with the violating SDK packages, per-package
 * bounded example inputs, and the fix pointer. Returns silently when clean.
 * @param {unknown} metafile
 */
export function assertSatellitePurity(metafile) {
  const violations = collectSatelliteViolations(metafile);
  if (violations.length === 0) return;
  const lines = [
    `[satellite-purity] FAIL: LLM SDK dependencies found inside satellite bundles (${violations.length} inputs).`,
    'Satellites (governance-audit / rulehost-evidence) must not reach the LLM graph.',
    'Root cause pattern: a VALUE import of the @principles/core/runtime-v2 barrel on a',
    'satellite path re-pulls the whole transitive graph — import the specific leaf',
    'subpath instead (e.g. @principles/core/runtime-v2/trajectory-schema). See OPT-002.',
  ];
  for (const pkg of FORBIDDEN_LLM_PACKAGES) {
    const hits = violations.filter((v) => v.pkg === pkg);
    if (hits.length === 0) continue;
    lines.push(`  - ${pkg}: ${hits.length} inputs in [${[...new Set(hits.map((h) => h.output))].join(', ')}]`);
    for (const h of hits.slice(0, EXAMPLE_INPUTS_PER_PACKAGE)) {
      lines.push(`      e.g. ${h.input}`);
    }
  }
  throw new Error(lines.join('\n'));
}

// CLI mode: `node check-satellite-purity.mjs --metafile <file.json>`.
// Flag-triggered rather than entry-module detection — portable on Windows.
if (argv.includes('--metafile')) {
  runCli();
}

function runCli() {
  const idx = argv.indexOf('--metafile');
  const metafilePath = idx !== -1 ? argv[idx + 1] : undefined;
  if (!metafilePath || metafilePath.startsWith('-')) {
    console.error('Usage: node scripts/build/check-satellite-purity.mjs --metafile <esbuild-metafile.json>');
    process.exit(2);
  }
  try {
    const metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
    assertSatellitePurity(metafile);
    console.log('[satellite-purity] OK: no LLM SDK dependencies in satellite bundles.');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
