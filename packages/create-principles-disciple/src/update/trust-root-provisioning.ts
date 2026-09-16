/**
 * Install-side trust root provisioning (PRI-732).
 *
 * The ReleaseManager verifies signed release metadata through tuf-js, which
 * REQUIRES a pinned trust anchor (`root.json`) in the installation's trust
 * directory before any refresh. Before PRI-732 no production component ever
 * wrote that anchor — only test fixtures did — so every real install failed
 * at `metadata_refresh_failed` and degraded to the legacy updater
 * (see legacy-migration.ts: "The bootstrap and trust root may only be
 * written by an official installer transaction").
 *
 * This module is the install-transaction side of that boundary:
 *
 *   pinned root carried by the installer payload (trust/root.json)
 *         ↓ strict validation (real TUF Root envelope, ed25519 keys,
 *           role thresholds, self-signature, unexpired)
 *         ↓ atomic write
 *   the installation's trust/root.json
 *
 * There is deliberately NO environment override: the payload asset is the
 * single supply path, so tests/CI control the anchor by building (or copying)
 * a payload with the trust root they want pinned — the same production
 * mechanism, not a second entry point.
 *
 * Persistence semantics (frozen Owner decision, 2026-09-15):
 *   - absent anchor      → validate + persist (the ONLY production writer);
 *   - identical anchor   → no-op (idempotent re-install);
 *   - different anchor   → the EXISTING anchor is KEPT and the difference is
 *     reported loudly. Replacing a trust anchor is key rotation — separate
 *     governance work — never a silent side effect of re-running an installer.
 *   - invalid candidate  → throws; the caller's install transaction must
 *     fail loud rather than pin a broken anchor.
 *
 * The pinned root and the served repository root do not have to be
 * byte-identical: tuf-js verifies the chain against the pinned root's keys,
 * so a long-lived pinned root (same key, version 1) keeps verifying
 * publications whose per-release root bytes carry shorter expiries
 * (verified against tuf-js 3.1.0 during the PRI-732 reality audit).
 */

import { createPublicKey } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Metadata, MetadataKind, type Key, type Root } from '@tufjs/models';
import { resolvePdHomePaths } from './install-layout.js';

/**
 * Where the installer payload carries the pinned root, relative to the payload
 * root. Forward slashes are accepted by path.resolve on every supported
 * platform.
 */
export const PAYLOAD_TRUST_ROOT_RELATIVE = 'trust/root.json';

/** The pinned anchor filename inside the installation's trust directory. */
export const TRUST_ROOT_FILENAME = 'root.json';

const ROOT_ROLES = ['root', 'timestamp', 'snapshot', 'targets'] as const;

export type TrustRootValidationReason =
  | 'trust_root_not_json'
  | 'trust_root_envelope_invalid'
  | 'trust_root_path_escape'
  | 'trust_root_role_missing'
  | 'trust_root_role_threshold_invalid'
  | 'trust_root_key_missing'
  | 'trust_root_key_type_invalid'
  | 'trust_root_key_material_invalid'
  | 'trust_root_expired'
  | 'trust_root_unsigned';

export class TrustRootValidationError extends Error {
  readonly reason: TrustRootValidationReason;
  readonly nextAction: string;

  constructor(reason: TrustRootValidationReason, message: string, nextAction: string) {
    super(message);
    this.name = 'TrustRootValidationError';
    this.reason = reason;
    this.nextAction = nextAction;
  }
}

export interface ValidatedTrustRoot {
  /** The exact bytes that were validated — callers persist THESE bytes, never re-serialized ones. */
  readonly bytes: Buffer;
  readonly keyIds: readonly string[];
  readonly version: number;
  readonly expires: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REBUILD_NEXT_ACTION = 'Do not install this package. The bundled trust root is corrupt; re-build the installer payload.';

/**
 * Strict validation of a pinned trust root (rc-1/rc-2/rc-3: untrusted bytes
 * are treated as `unknown` and every required property fails loud). Uses the
 * real TUF models parser — no second TUF implementation.
 */
export function validateTrustRoot(raw: unknown): ValidatedTrustRoot {
  // The input is file bytes (Buffer) or text (string) — anything else is a
  // caller defect, not data to guess a parse for (rc-3).
  if (!Buffer.isBuffer(raw) && typeof raw !== 'string') {
    throw new TrustRootValidationError(
      'trust_root_not_json',
      'The pinned trust root must be provided as bytes or text.',
      REBUILD_NEXT_ACTION,
    );
  }
  const rawText = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new TrustRootValidationError(
      'trust_root_not_json',
      `The pinned trust root is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      REBUILD_NEXT_ACTION,
    );
  }
  if (!isRecord(parsed)) {
    throw new TrustRootValidationError(
      'trust_root_not_json',
      'The pinned trust root must be a JSON object (TUF metadata envelope).',
      REBUILD_NEXT_ACTION,
    );
  }

  let metadata: Metadata<Root>;
  try {
    // Post-isRecord narrowing: the typed TUF parser wants its JSONObject
    // shape; the runtime parse below is what actually validates it (rc-2 —
    // the assertion carries no trust, fromJSON throws on garbage).
    const envelope = parsed as Parameters<typeof Metadata.fromJSON>[1];
    metadata = Metadata.fromJSON(MetadataKind.Root, envelope);
  } catch (error) {
    throw new TrustRootValidationError(
      'trust_root_envelope_invalid',
      `The pinned trust root is not a valid TUF metadata envelope: ${error instanceof Error ? error.message : String(error)}`,
      REBUILD_NEXT_ACTION,
    );
  }

  const root = metadata.signed;
  for (const role of ROOT_ROLES) {
    const roleData = root.roles[role];
    if (roleData === undefined) {
      throw new TrustRootValidationError(
        'trust_root_role_missing',
        `The pinned trust root is missing the "${role}" role.`,
        REBUILD_NEXT_ACTION,
      );
    }
    if (!Number.isSafeInteger(roleData.threshold) || roleData.threshold < 1) {
      throw new TrustRootValidationError(
        'trust_root_role_threshold_invalid',
        `The "${role}" role must declare a threshold >= 1 (got ${String(roleData.threshold)}).`,
        REBUILD_NEXT_ACTION,
      );
    }
    if (roleData.keyIDs.length === 0) {
      throw new TrustRootValidationError(
        'trust_root_key_missing',
        `The "${role}" role declares no key IDs.`,
        REBUILD_NEXT_ACTION,
      );
    }
  }

  const keyIds = new Set<string>();
  for (const role of ROOT_ROLES) {
    const roleData = root.roles[role];
    if (roleData === undefined) continue; // the role loop above already refused this
    for (const keyId of roleData.keyIDs) {
      keyIds.add(keyId);
      const key: Key | undefined = root.keys[keyId];
      if (key === undefined) {
        throw new TrustRootValidationError(
          'trust_root_key_missing',
          `The pinned trust root references key ${keyId} (role "${role}") but does not carry its material.`,
          REBUILD_NEXT_ACTION,
        );
      }
      if (key.keyType !== 'ed25519' || key.scheme !== 'ed25519') {
        throw new TrustRootValidationError(
          'trust_root_key_type_invalid',
          `Key ${keyId} must be an ed25519 key with the ed25519 scheme (got ${key.keyType}/${key.scheme}) — the release trust material is ed25519-only.`,
          'Do not install this package. Regenerate the release trust root with the official ed25519 ceremony.',
        );
      }
      const publicPem = key.keyVal.public;
      if (typeof publicPem !== 'string' || publicPem.length === 0) {
        throw new TrustRootValidationError(
          'trust_root_key_material_invalid',
          `Key ${keyId} carries no public key material.`,
          REBUILD_NEXT_ACTION,
        );
      }
      try {
        createPublicKey(publicPem);
      } catch {
        throw new TrustRootValidationError(
          'trust_root_key_material_invalid',
          `Key ${keyId} public material is not a parseable PEM public key.`,
          REBUILD_NEXT_ACTION,
        );
      }
    }
  }

  const expiresMs = Date.parse(root.expires);
  if (Number.isNaN(expiresMs)) {
    throw new TrustRootValidationError(
      'trust_root_expired',
      `The pinned trust root carries an unparseable expiry: ${String(root.expires)}`,
      REBUILD_NEXT_ACTION,
    );
  }
  if (expiresMs <= Date.now()) {
    throw new TrustRootValidationError(
      'trust_root_expired',
      `The pinned trust root expired at ${root.expires}.`,
      'Do not install this package. Publish a new trust root with a future expiry and re-build the installer payload.',
    );
  }

  // The anchor must be internally consistent: the root document's own
  // signatures must verify against the keys it itself declares for the root
  // role (TUF root self-verification). A tampered root fails here.
  try {
    metadata.verifyDelegate('root', metadata);
  } catch (error) {
    throw new TrustRootValidationError(
      'trust_root_unsigned',
      `The pinned trust root is not validly self-signed: ${error instanceof Error ? error.message : String(error)}`,
      'Do not install this package. The bundled trust root was tampered with or signed with different material.',
    );
  }

  return {
    bytes: Buffer.from(rawText, 'utf8'),
    keyIds: [...keyIds],
    version: root.version,
    expires: root.expires,
  };
}

export type TrustRootProvisioningOutcome =
  | { readonly outcome: 'provisioned'; readonly sourcePath: string; readonly trustRootPath: string; readonly keyIds: readonly string[]; readonly expires: string }
  | { readonly outcome: 'already-pinned'; readonly sourcePath: string; readonly trustRootPath: string }
  | { readonly outcome: 'skipped-no-source'; readonly payloadRoot: string }
  | { readonly outcome: 'retained-existing'; readonly sourcePath: string; readonly trustRootPath: string; readonly note: string };

export interface ProvisionTrustRootOptions {
  /** PD home root (e.g. the user's .pd directory). */
  readonly pdHome: string;
  /** The installer payload root (extracted asset / package dir) carrying trust/root.json. */
  readonly payloadRoot: string;
}

/**
 * Provision the installation's trust/root.json inside the installer
 * transaction. See the module header for the persistence contract. Throws
 * TrustRootValidationError when the payload carries a trust root that does
 * not satisfy the contract — the install must fail loud.
 */
export function provisionBootstrapTrustRoot(options: ProvisionTrustRootOptions): TrustRootProvisioningOutcome {
  const pdHomeRoot = path.resolve(options.pdHome);
  // Layout truth stays with install-layout's resolvePdHomePaths; the literal
  // join below only asserts the derived anchor path is the canonical
  // <pdHome>/trust/root.json (never an escape from the PD home).
  const paths = resolvePdHomePaths(pdHomeRoot);
  const trustRootPath = path.join(paths.trustDir, TRUST_ROOT_FILENAME);
  const canonicalTrustRootPath = path.join(pdHomeRoot, 'trust', TRUST_ROOT_FILENAME);
  if (trustRootPath !== canonicalTrustRootPath || !trustRootPath.startsWith(pdHomeRoot + path.sep)) {
    throw new TrustRootValidationError(
      'trust_root_path_escape',
      `The trust root path escapes the PD home (${pdHomeRoot}): ${trustRootPath}`,
      'Do not install this package. The PD home layout is corrupt; re-run the official installer.',
    );
  }

  const payloadRoot = path.resolve(options.payloadRoot);
  const payloadTrustRootPath = path.resolve(payloadRoot, PAYLOAD_TRUST_ROOT_RELATIVE);
  // Containment: the trusted asset path must stay inside the payload root
  // (a fixed relative segment makes this invariant explicit).
  if (!payloadTrustRootPath.startsWith(payloadRoot + path.sep)) {
    throw new TrustRootValidationError(
      'trust_root_path_escape',
      `The payload trust root path escapes the payload root: ${payloadTrustRootPath}`,
      'Do not install this package. The payload layout is corrupt; re-build the installer payload.',
    );
  }
  if (!fs.existsSync(payloadTrustRootPath)) {
    // A payload without a pinned root (pre-PRI-732 assets) stays unconfigured
    // — the ReleaseManager keeps degrading exactly as before, observably.
    return { outcome: 'skipped-no-source', payloadRoot: options.payloadRoot };
  }
  const candidateBytes = fs.readFileSync(payloadTrustRootPath);
  const validated = validateTrustRoot(candidateBytes);

  if (fs.existsSync(trustRootPath)) {
    const existing = fs.readFileSync(trustRootPath);
    if (Buffer.compare(existing, validated.bytes) === 0) {
      return { outcome: 'already-pinned', sourcePath: payloadTrustRootPath, trustRootPath };
    }
    return {
      outcome: 'retained-existing',
      sourcePath: payloadTrustRootPath,
      trustRootPath,
      note: 'The installed trust root differs from the pinned root in this payload; the EXISTING anchor is kept (replacing a trust anchor is key rotation — a separate governance action).',
    };
  }

  fs.mkdirSync(paths.trustDir, { recursive: true });
  const stagingName = `root.staging-${process.pid}-${Date.now()}.json`;
  const stagingPath = path.join(paths.trustDir, stagingName);
  if (!stagingPath.startsWith(pdHomeRoot + path.sep)) {
    throw new TrustRootValidationError(
      'trust_root_path_escape',
      `The trust root staging path escapes the PD home (${pdHomeRoot}): ${stagingPath}`,
      'Do not install this package. The PD home layout is corrupt; re-run the official installer.',
    );
  }
  try {
    fs.writeFileSync(stagingPath, validated.bytes);
    fs.renameSync(stagingPath, trustRootPath);
  } catch (error) {
    try {
      fs.rmSync(stagingPath, { force: true });
    } catch {
      // best-effort staging cleanup
    }
    throw error;
  }

  return {
    outcome: 'provisioned',
    sourcePath: payloadTrustRootPath,
    trustRootPath,
    keyIds: validated.keyIds,
    expires: validated.expires,
  };
}
