#!/usr/bin/env node
// PRI-685 Evidence Foundation — experiment manifest initializer.
//
// Creates experiment-manifest.json for a lab run (SPEC §6). PD-side facts
// (commit, package versions) are captured from THIS repository automatically —
// the deployed lab should run it from the same checkout that was deployed.
// Host/model/flags are experiment-environment knowledge and stay operator-filled
// (audit §3.5): no environment guessing, transcription errors are what this
// tool exists to prevent.
//
// Usage:
//   node scripts/dev/pipeline-evolution/init-experiment.mjs \
//     --out <lab-dir>/experiment-manifest.json \
//     --experiment PRI653-R3-S001 --scenario S001 \
//     [--host openclaw] [--host-version 2026.9.1] \
//     [--model-provider bai] [--model-name glm-5.3-flash] [--thinking off] \
//     [--fixture-hash <sha256>] [--session <sid>]... [--started-at <ISO>]
//
// After the run: fill finishedAt / painIds / behaviorObservation by hand
// (sessionIds accumulate via --session during the run or afterwards).

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newManifestTemplate } from './lib/experiment-manifest.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fail(msg) {
  console.error(`[init-experiment] FAIL: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    out: null,
    experiment: null,
    scenario: null,
    scenarioVersion: '1',
    host: 'openclaw',
    hostVersion: null,
    modelProvider: null,
    modelName: null,
    thinking: null,
    fixtureHash: null,
    sessions: [],
    startedAt: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--out':
      case '--experiment':
      case '--scenario':
      case '--scenario-version':
      case '--host':
      case '--host-version':
      case '--model-provider':
      case '--model-name':
      case '--thinking':
      case '--fixture-hash':
      case '--started-at': {
        if (!next) fail(`missing value for ${a}`);
        const key = {
          '--out': 'out',
          '--experiment': 'experiment',
          '--scenario': 'scenario',
          '--scenario-version': 'scenarioVersion',
          '--host': 'host',
          '--host-version': 'hostVersion',
          '--model-provider': 'modelProvider',
          '--model-name': 'modelName',
          '--thinking': 'thinking',
          '--fixture-hash': 'fixtureHash',
          '--started-at': 'startedAt',
        }[a];
        opts[key] = next;
        i += 1;
        break;
      }
      case '--session': {
        if (!next) fail('missing value for --session');
        opts.sessions.push(next);
        i += 1;
        break;
      }
      default:
        fail(`unknown argument: ${a}`);
    }
  }
  if (!opts.out) fail('--out <file> is required');
  if (!opts.experiment) fail('--experiment <id> is required (e.g. PRI653-R3-S001)');
  if (!opts.scenario) fail('--scenario <id> is required (e.g. S001)');
  return opts;
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`cannot resolve PD commit in ${repoRoot} (git rev-parse HEAD failed: ${err.message})`);
  }
}

function pkgVersion(pkgPath) {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, pkgPath), 'utf8')).version ?? null;
  } catch {
    return null; // optional convenience field — absence is recorded as null, not guessed
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outFile = resolve(opts.out); // one canonical path for all uses

  let manifest;
  try {
    manifest = newManifestTemplate({
      experimentId: opts.experiment,
      scenarioId: opts.scenario,
      scenarioVersion: opts.scenarioVersion,
      pdCommit: gitSha(),
      pdCoreVersion: pkgVersion('packages/principles-core/package.json'),
      pdPluginVersion: pkgVersion('packages/openclaw-plugin/package.json'),
      pdCliVersion: pkgVersion('packages/pd-cli/package.json'),
      host: opts.host,
      hostVersion: opts.hostVersion,
      model: { provider: opts.modelProvider, name: opts.modelName, thinking: opts.thinking, timeoutMs: null },
      fixtureHash: opts.fixtureHash,
      sessionIds: opts.sessions,
      startedAt: opts.startedAt ?? undefined,
    });
  } catch (err) {
    fail(err.message);
  }

  mkdirSync(dirname(outFile), { recursive: true });
  // 'wx' = create-or-fail atomically — closes the check-then-write window.
  try {
    writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') fail(`${outFile} already exists — edit it instead of re-initializing`);
    throw err;
  }
  console.log(`[ok] manifest written to ${outFile}`);
  console.log('     next: fill hostVersion / model / featureFlags by hand, add --session ids during the run,');
  console.log('           set finishedAt + painIds afterwards, then collect with:');
  console.log(`           node scripts/dev/pipeline-evolution/collect-evidence.mjs --workspace <ws> --experiment ${outFile} --package <evidence-package-dir>`);
}

main();
