#!/usr/bin/env node
/**
 * Evidence-derived preflight/rehearsal reporting (PD Release G3-R3 H1).
 *
 * The rehearsal summary used to be a fixed sentence claiming that every leg
 * "packed real artifacts". That is only true when the registry state is
 * ABSENT for every leg; a cohort that only bumps SOME packages makes the
 * remaining legs resolve PRESENT_MATCH / PRESENT_PRIOR, which SKIP the
 * candidate pack entirely. A summary is evidence, so it is derived from
 * per-leg facts, never from "the job succeeded".
 *
 * Two modes:
 *   leg      classify ONE finished leg from its own evidence and write the
 *            result to GITHUB_OUTPUT (`leg_status`, `leg_reason`,
 *            `leg_pack_attempted`). PACKED requires ALL of:
 *              - the candidate tarball exists and is non-empty;
 *              - the action's declared SHA-512 is a well-formed 128-hex value;
 *              - re-hashing the file NOW reproduces that declared value;
 *              - the tarball's package.json name/version/gitHead match this
 *                leg's exact package/version/cohort identity.
 *            Any missing piece is UNKNOWN — never a packaging claim.
 *   summary  aggregate the workflow's `steps` context into the rehearsal
 *            summary. A failed leg is FAILED, a leg that never ran is
 *            UNKNOWN, and only a leg whose own evidence says PACKED counts
 *            as packed.
 *
 * The module exports the pure decision functions so tests exercise the real
 * classification instead of a copy of it.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const LEG_STATUS = {
  PACKED: 'PACKED',
  SKIPPED_PRESENT: 'SKIPPED_PRESENT',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
};

const SHA512_HEX = /^[a-f0-9]{128}$/;
const PRESENT_STATUSES = new Set(['PRESENT_MATCH', 'PRESENT_PRIOR']);

/**
 * Decide one leg's status from observed facts (no I/O).
 *
 * @param {{
 *   registryStatus?: string,
 *   candidateExists?: boolean,
 *   declaredSha512Hex?: string,
 *   recomputedSha512Hex?: string,
 *   manifest?: { name?: string, version?: string, gitHead?: string } | null,
 *   expectedName?: string,
 *   expectedVersion?: string,
 *   cohort?: string,
 * }} evidence
 * @returns {{ status: string, packAttempted: boolean, reason: string }}
 */
export function classifyLeg(evidence) {
  const registryStatus = typeof evidence.registryStatus === 'string' ? evidence.registryStatus : '';

  if (PRESENT_STATUSES.has(registryStatus)) {
    return {
      status: LEG_STATUS.SKIPPED_PRESENT,
      packAttempted: false,
      reason: `registry already has the exact version (${registryStatus}); candidate pack skipped`,
    };
  }

  if (registryStatus !== 'ABSENT') {
    return {
      status: LEG_STATUS.UNKNOWN,
      packAttempted: false,
      reason: `registry state ${registryStatus || '(unavailable)'} — candidate packing not exercised`,
    };
  }

  if (!evidence.candidateExists) {
    return { status: LEG_STATUS.UNKNOWN, packAttempted: true, reason: 'candidate tarball is missing' };
  }

  const declared = typeof evidence.declaredSha512Hex === 'string' ? evidence.declaredSha512Hex : '';
  if (!SHA512_HEX.test(declared)) {
    return { status: LEG_STATUS.UNKNOWN, packAttempted: true, reason: 'candidate SHA-512 output is missing or malformed' };
  }

  const recomputed = typeof evidence.recomputedSha512Hex === 'string' ? evidence.recomputedSha512Hex : '';
  if (!SHA512_HEX.test(recomputed) || recomputed !== declared) {
    return {
      status: LEG_STATUS.UNKNOWN,
      packAttempted: true,
      reason: 'candidate SHA-512 does not match the file on disk',
    };
  }

  const manifest = evidence.manifest && typeof evidence.manifest === 'object' ? evidence.manifest : null;
  if (!manifest) {
    return { status: LEG_STATUS.UNKNOWN, packAttempted: true, reason: 'candidate package.json is unreadable' };
  }
  if (typeof manifest.name !== 'string' || manifest.name !== evidence.expectedName) {
    return { status: LEG_STATUS.UNKNOWN, packAttempted: true, reason: 'candidate package name does not match this leg' };
  }
  if (typeof manifest.version !== 'string' || manifest.version !== evidence.expectedVersion) {
    return { status: LEG_STATUS.UNKNOWN, packAttempted: true, reason: 'candidate package version does not match this leg' };
  }
  if (typeof manifest.gitHead !== 'string' || manifest.gitHead !== evidence.cohort) {
    return { status: LEG_STATUS.UNKNOWN, packAttempted: true, reason: 'candidate gitHead does not match the cohort' };
  }

  return {
    status: LEG_STATUS.PACKED,
    packAttempted: true,
    reason: `candidate verified (file + SHA-512 + ${manifest.name}@${manifest.version} + cohort gitHead)`,
  };
}

/**
 * Aggregate the workflow `steps` context into the rehearsal summary model.
 * Only `leg<N>` steps are considered — the count is derived, never hardcoded.
 *
 * @param {Record<string, unknown>} stepsContext
 * @param {string} controlPlaneResult
 */
export function summarizeSteps(stepsContext, controlPlaneResult) {
  const steps = stepsContext && typeof stepsContext === 'object' ? stepsContext : {};
  const legs = Object.entries(steps)
    .filter(([id]) => /^leg\d+$/.test(id))
    .sort((a, b) => Number(a[0].slice('leg'.length)) - Number(b[0].slice('leg'.length)))
    .map(([id, raw]) => {
      const step = raw && typeof raw === 'object' ? raw : {};
      const outputs = step.outputs && typeof step.outputs === 'object' ? step.outputs : {};
      const outcome = typeof step.outcome === 'string' ? step.outcome : '';
      const declared = typeof outputs.leg_status === 'string' ? outputs.leg_status : '';

      let status;
      if (outcome === 'failure') {
        // A failed leg is FAILED even if a partial output claims otherwise.
        status = LEG_STATUS.FAILED;
      } else if (outcome !== 'success') {
        // skipped / cancelled / no outcome: the leg never produced evidence.
        status = LEG_STATUS.UNKNOWN;
      } else if (declared === LEG_STATUS.PACKED || declared === LEG_STATUS.SKIPPED_PRESENT) {
        status = declared;
      } else {
        status = LEG_STATUS.UNKNOWN;
      }

      const packAttempted =
        status !== LEG_STATUS.SKIPPED_PRESENT &&
        status !== LEG_STATUS.FAILED &&
        outputs.leg_pack_attempted === 'true';

      return {
        id,
        packageName: typeof outputs.npm_name === 'string' ? outputs.npm_name : '',
        version: typeof outputs.package_version === 'string' ? outputs.package_version : '',
        status,
        reason: typeof outputs.leg_reason === 'string' ? outputs.leg_reason : '',
        sha512: typeof outputs.candidate_sha512_hex === 'string' ? outputs.candidate_sha512_hex : '',
        packAttempted,
      };
    });

  const packed = legs.filter((leg) => leg.status === LEG_STATUS.PACKED).length;
  const skipped = legs.filter((leg) => leg.status === LEG_STATUS.SKIPPED_PRESENT).length;
  const failed = legs.filter((leg) => leg.status === LEG_STATUS.FAILED).length;
  const unknown = legs.filter((leg) => leg.status === LEG_STATUS.UNKNOWN).length;
  const attempted = legs.filter((leg) => leg.packAttempted).length;

  let candidatePath;
  if (attempted === 0) {
    candidatePath = 'NOT VERIFIED IN THIS RUN';
  } else if (packed === 0) {
    candidatePath = 'ATTEMPTED BUT NOT VERIFIED IN THIS RUN';
  } else if (packed === legs.length && failed === 0 && unknown === 0) {
    // Every leg of THIS run was packed and verified — the only state in which
    // the candidate path was exercised end-to-end.
    candidatePath = 'VERIFIED IN THIS RUN';
  } else {
    // Some legs resolved an existing version (no candidate) or were not
    // verified, so only part of the train's candidate path is proven.
    candidatePath = 'PARTIALLY VERIFIED IN THIS RUN';
  }

  let controlPlane;
  if (controlPlaneResult === 'success') controlPlane = 'PASS';
  else if (controlPlaneResult === 'skipped' || controlPlaneResult === 'cancelled') controlPlane = 'NOT RUN';
  else controlPlane = 'FAIL';

  return {
    controlPlane,
    legs,
    packed,
    skipped,
    failed,
    unknown,
    attempted,
    exercised: attempted > 0,
    candidatePath,
  };
}

/** Render the summary markdown (pure). */
export function renderSummary(summary) {
  const lines = [
    '## Preflight rehearsal summary',
    '',
    `Preflight control plane: ${summary.controlPlane}`,
    `Release legs: ${summary.legs.length}`,
    `Candidates packed: ${summary.packed}`,
    `Skipped existing versions: ${summary.skipped}`,
    `Failed or unknown legs: ${summary.failed + summary.unknown}`,
    `Candidate packaging exercised: ${summary.exercised ? 'YES' : 'NO'}`,
    `Candidate path: ${summary.candidatePath}`,
    '',
  ];

  if (summary.legs.length > 0) {
    lines.push('| Leg | Package | Version | Status | Evidence |', '|-----|---------|---------|--------|----------|');
    for (const leg of summary.legs) {
      const evidence = leg.sha512 ? `sha512 ${leg.sha512.slice(0, 16)}…` : leg.reason || '—';
      lines.push(
        `| ${leg.id} | \`${leg.packageName || 'unknown'}\` | ${leg.version || '—'} | \`${leg.status}\` | ${evidence} |`,
      );
    }
    lines.push('');
  }

  lines.push('No npm upload, tag, or GitHub Release happened in this workflow.');
  return lines.join('\n') + '\n';
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function emitLegOutput(result, githubOutputPath) {
  const lines = [
    `leg_status=${result.status}`,
    `leg_reason=${result.reason.replace(/\r?\n/g, ' ')}`,
    `leg_pack_attempted=${result.packAttempted ? 'true' : 'false'}`,
  ];
  console.log(lines.join('\n'));
  if (githubOutputPath) appendFileSync(githubOutputPath, lines.join('\n') + '\n');
}

function hashFile(path) {
  const hash = createHash('sha512');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function readPackedManifest(tarballPath) {
  // GNU tar is already a hard requirement of prepare-npm-candidate.mjs, and
  // this runs on the same ubuntu runner; a non-quiet failure means "cannot
  // read", which classifyLeg reports as UNKNOWN rather than throwing.
  try {
    const raw = execFileSync('tar', ['-xzOf', tarballPath, 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function main() {
  const mode = process.argv[2];
  const githubOutputPath = argValue('--github-output');

  if (mode === 'leg') {
    const tarball = argValue('--tarball') || '';
    const candidateExists = tarball !== '' && existsSync(tarball) && statSync(tarball).size > 0;
    const result = classifyLeg({
      registryStatus: argValue('--registry-status'),
      candidateExists,
      declaredSha512Hex: argValue('--sha512-hex'),
      recomputedSha512Hex: candidateExists ? hashFile(tarball) : '',
      manifest: candidateExists ? readPackedManifest(tarball) : null,
      expectedName: argValue('--package-name'),
      expectedVersion: argValue('--package-version'),
      cohort: argValue('--cohort'),
    });
    emitLegOutput(result, githubOutputPath);
    return;
  }

  if (mode === 'summary') {
    const raw = argValue('--steps-json');
    let stepsContext;
    try {
      stepsContext = JSON.parse(raw ?? '{}');
    } catch (error) {
      throw new Error('--steps-json is not valid JSON: ' + error.message);
    }
    const summary = summarizeSteps(stepsContext, argValue('--control-plane') ?? '');
    process.stdout.write(renderSummary(summary));
    return;
  }

  console.error('usage: preflight-summary.mjs leg|summary [--flags] — see the module header');
  process.exit(2);
}

// Only run the CLI when invoked directly; importing the module in tests must
// never read process.argv.
const invokedDirectly = process.argv[1] && /preflight-summary\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main();
