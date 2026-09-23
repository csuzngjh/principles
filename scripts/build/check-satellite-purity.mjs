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
// bundle build (dev + production), fed the live esbuild metafile — and thus
// reached from `npm run check-satellite-bundle-deps` and the tail of
// `npm run verify:merge` (OPT-003). Also usable as a CLI over a persisted
// metafile JSON for tests and forensics:
//   node scripts/build/check-satellite-purity.mjs --metafile <file.json>

import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

/** Satellite bundle outputs, by filename suffix (metafile keys are paths). */
export const SATELLITE_OUTPUT_SUFFIXES = [
  'governance-audit.js',
  'rulehost-evidence.js',
];

/**
 * Vendored LLM SDK package path segments (matched at the
 * `node_modules/<pkg>/` boundary only, so source-file names and other
 * vendors' nested dirs never trip it — see matchesForbiddenPackage).
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
 * Matches only at a package-directory boundary directly under node_modules
 * (`…/node_modules/<pkg>/…`), so a source file named like a vendor (e.g.
 * `src/adapters/openai-compat-shim.ts`) can never trip the guard.
 * `@anthropic-ai` is a scope, not a full package name: it intentionally
 * matches every package one level below it (`node_modules/@anthropic-ai/<pkg>/`).
 */
function matchesForbiddenPackage(normInput, pkg) {
  const needle = `node_modules/${pkg.toLowerCase()}`;
  let idx = normInput.indexOf(needle);
  while (idx !== -1) {
    const after = idx + needle.length;
    if (pkg === '@anthropic-ai' ? normInput[after] === '/' : normInput.startsWith('/', after)) {
      return true;
    }
    idx = normInput.indexOf(needle, idx + 1);
  }
  return false;
}

/**
 * @param {unknown} metafile esbuild BuildResult.metafile (validated as unknown, rc-1)
 * @returns {{output: string, input: string, pkg: string}[]} one row per violating input
 * @throws if the metafile is malformed OR an expected satellite output is
 * missing / unreadable — a guard that silently passes on absence is worse
 * than no guard at all (rc-3).
 */
export function collectSatelliteViolations(metafile) {
  if (typeof metafile !== 'object' || metafile === null || !Object.hasOwn(metafile, 'outputs')) {
    throw new Error('[satellite-purity] invalid input: expected an esbuild metafile object with an `outputs` map');
  }
  const outputs = /** @type {Record<string, unknown>} */ (metafile.outputs);
  const outputEntries = Object.entries(outputs);

  const satelliteOutputs = [];
  for (const suffix of SATELLITE_OUTPUT_SUFFIXES) {
    const matched = outputEntries.filter(([outputPath]) => outputPath.endsWith(suffix));
    if (matched.length === 0) {
      throw new Error(
        `[satellite-purity] invalid metafile: expected satellite output '${suffix}' is missing from outputs — ` +
        'the guard must not pass on absence (a build that forgot the satellite, or an entryPoint rename, would slip through).'
      );
    }
    for (const [outputPath, output] of matched) {
      if (typeof output !== 'object' || output === null || typeof output.inputs !== 'object' || output.inputs === null) {
        throw new Error(`[satellite-purity] invalid metafile: satellite output '${outputPath}' has a missing or malformed inputs map`);
      }
      satelliteOutputs.push([outputPath, /** @type {Record<string, unknown>} */ (output.inputs)]);
    }
  }

  const violations = [];
  for (const [outputPath, inputs] of satelliteOutputs) {
    for (const inputPath of Object.keys(inputs)) {
      const norm = normalizePath(inputPath);
      if (!norm.includes('node_modules/')) continue;
      const hit = FORBIDDEN_LLM_PACKAGES.find((pkg) => matchesForbiddenPackage(norm, pkg));
      if (hit) violations.push({ output: outputPath, input: inputPath, pkg: hit });
    }
  }
  return violations;
}

/**
 * Fail loud (rc-3/rc-9): throws with the violating SDK packages, per-package
 * bounded example inputs, and the fix pointer. On success, logs the positive
 * evidence line (OPT-003: `Forbidden dependency count: 0` per satellite) and
 * returns the summary.
 * @param {unknown} metafile
 * @returns {{total: number, perSatellite: Record<string, number>}} zeroed counts on success
 */
export function assertSatellitePurity(metafile) {
  const violations = collectSatelliteViolations(metafile);
  const perSatellite = Object.fromEntries(SATELLITE_OUTPUT_SUFFIXES.map((s) => [s, 0]));
  for (const v of violations) {
    const suffix = SATELLITE_OUTPUT_SUFFIXES.find((s) => v.output.endsWith(s));
    if (suffix) perSatellite[suffix] += 1;
  }
  if (violations.length === 0) {
    const breakdown = Object.entries(perSatellite).map(([s, n]) => `${s}: ${n}`).join(', ');
    console.log(`[satellite-purity] OK: Forbidden dependency count: 0 (${breakdown})`);
    return { total: 0, perSatellite };
  }
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
    // assertSatellitePurity logs the `Forbidden dependency count: 0` evidence
    // line itself on success (OPT-003) and throws with the violation list on failure.
    assertSatellitePurity(metafile);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
