#!/usr/bin/env node
/**
 * Ambiguous npm-publish outcome resolver (PRI-886).
 *
 * `npm publish` can exit non-zero AFTER the upload actually reached the
 * registry (response lost, registry timeout on the final ack, network
 * reset). npm versions are immutable — blindly re-running publish can
 * never fix that, and aborting the train forces a version re-cut. The
 * correct decision is to RE-VERIFY the registry's exact state and let
 * the facts decide:
 *
 *   PRESENT_MATCH (gitHead == cohort)  → exit 0  upload actually landed;
 *                                        the train continues (the next
 *                                        leg's exact-check will also see
 *                                        PRESENT_MATCH and skip)
 *   ABSENT                             → exit 1  the upload really failed
 *   PRESENT_CONFLICT / UNVERIFIED      → exit 1  integrity conflict —
 *                                        never assume foreign publishes
 *                                        belong to this release
 *   REGISTRY_ERROR                     → exit 1  undecidable, fail loud
 *
 * Usage:
 *   node verify-publish-outcome.mjs <package> <exact-version> \
 *        --expect-git-head <cohort-sha> [--json]
 */
import { classifyPresence, fetchExactManifest } from './lib/registry-client.mjs';
import { classifyRegistryError } from './deps-preflight.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const asJson = process.argv.includes('--json');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const npmName = positional[0];
const exactVersion = positional[1];
const expectGitHead = argValue('--expect-git-head');

if (!npmName || !exactVersion || !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(exactVersion) || !/^[a-f0-9]{40}$/.test(expectGitHead ?? '')) {
  console.error('usage: verify-publish-outcome.mjs <package> <exact-version> --expect-git-head <sha> [--json]');
  process.exit(2);
}

let manifest;
try {
  manifest = await fetchExactManifest(npmName, exactVersion);
} catch (err) {
  const classified = classifyRegistryError(err);
  const payload = { status: 'REGISTRY_ERROR', class: classified.kind, detail: classified.detail };
  if (asJson) console.log(JSON.stringify(payload));
  console.error(`::error::cannot decide the publish outcome for ${npmName}@${exactVersion}: ${classified.kind} (${classified.detail}). Failing loud — retry the train, do not re-publish blind.`);
  process.exit(1);
}

const status = classifyPresence(manifest, { expectGitHead });
const payload = { status, package: npmName, version: exactVersion, gitHead: manifest?.gitHead ?? null };

if (status === 'PRESENT_MATCH') {
  if (asJson) console.log(JSON.stringify(payload));
  console.error(
    `::warning::npm publish reported failure, but the registry proves ${npmName}@${exactVersion} is published from the cohort commit — treating as published and continuing.`,
  );
  process.exit(0);
}

if (asJson) console.log(JSON.stringify(payload));
if (status === 'ABSENT') {
  console.error(`::error::npm publish failed AND the registry still shows ${npmName}@${exactVersion} absent — the upload did not land. Retry the train.`);
} else {
  console.error(
    `::error::registry shows ${npmName}@${exactVersion} present with status ${status} (gitHead=${manifest?.gitHead ?? 'none'}) — an integrity conflict. Refusing to continue (SPEC §17/§19).`,
  );
}
process.exit(1);
