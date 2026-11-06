import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAdaptiveMappingSha256, validateControlledAdmissionBinding } from '@principles/core/runtime-v2';
import type { PluginHookBeforePromptBuildEvent } from '../openclaw-sdk.js';
import type { AdaptiveActivationConfig } from './adaptive-activation-config.js';
import { resolveCurrentUserMessage } from './prompt-helpers.js';

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_ADMISSION_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const CLAIM_CACHE_CAPACITY = 2;
const CLAIM_CACHE_TTL_MS = 60_000;
const MAX_ADMISSION_LIFETIME_MS = 15 * 60_000;
const SCENE_MARKER = '[PD-AA:delivery-review:v1]';
const ADMISSION_SCHEMA = 'pd-aa-controlled-admission/v2';

export const CONTROLLED_ADMISSION_ENV = {
  admissionFile: 'PD_AA_ADMISSION_FILE',
  experimentRoot: 'PD_AA_EXPERIMENT_ROOT',
} as const;

export type ControlledAdmissionReason =
  | 'admission_native_identity_present'
  | 'admission_path_outside_root'
  | 'admission_file_invalid'
  | 'admission_input_mismatch'
  | 'admission_input_parse_mismatch'
  | 'admission_manifest_mismatch'
  | 'admission_target_mismatch'
  | 'admission_mapping_mismatch'
  | 'admission_session_mismatch'
  | 'admission_agent_to_agent'
  | 'admission_scene_mismatch'
  | 'admission_expired'
  | 'admission_already_consumed'
  | 'admission_claim_write_failed';

export interface ControlledAdmissionEnvironment {
  enabled: boolean;
  admissionFile?: string;
  experimentRoot?: string;
}

export interface ControlledAdmissionIdentity {
  admissionId: string;
  operator: string;
  purpose: string;
  inputSha256: string;
  manifestSha256: string;
  mappingSha256: string;
  targetArtifactId: string;
  targetActivationId: string;
  expiresAt: string;
  consumedAt: string;
  consumedBy: { sessionId: string; runId: string | null; hookInvocationId: string };
}

export interface ControlledAdmissionManifest {
  targetArtifactId: string;
  targetActivationId: string;
  sourceRef: string;
  fixtureFile: string;
  fixtureSha256: string;
  expectedToolName: string;
  expectedContentMarker: string;
  configSnapshot: Record<string, unknown>;
}

export interface ControlledAdmissionClaim {
  claimId: string;
  identity: ControlledAdmissionIdentity;
  manifest: ControlledAdmissionManifest;
  admittedText: string;
  hookInvocationId: string;
}

export type ControlledAdmissionClaimResult =
  | { status: 'disabled' }
  | { status: 'rejected'; reason: ControlledAdmissionReason; detail?: string }
  | { status: 'claimed'; claim: ControlledAdmissionClaim };

export interface ControlledAdmissionClaimRequest {
  event: PluginHookBeforePromptBuildEvent;
  workspaceDir: string;
  sessionId: string | undefined;
  runId?: string | null;
  mapping: AdaptiveActivationConfig;
  hookInvocationId: string;
  now?: number;
}

interface AdmissionDocument {
  schemaVersion: string;
  admissionId: string;
  operator: string;
  purpose: string;
  experimentRoot: string;
  inputPath: string;
  inputSha256: string;
  manifestPath: string;
  manifestSha256: string;
  targetArtifactId: string;
  targetActivationId: string;
  mappingSha256: string;
  sessionBinding: 'predeclared' | 'first_consumer';
  expectedSessionId: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: { sessionId: string; runId: string | null; hookInvocationId: string } | null;
}

interface CachedClaim {
  claim: ControlledAdmissionClaim;
  event: object;
  claimedAt: number;
}

class AdmissionFailure extends Error {
  constructor(readonly reason: ControlledAdmissionReason, readonly detail?: string) {
    super(detail ?? reason);
  }
}

const claimCache = new Map<string, CachedClaim>();

/**
 * The controlled admission branch is opt-in per isolated process only. There is
 * no persisted configuration and no plugin default that could enable it.
 */
export function readControlledAdmissionEnvironment(env: NodeJS.ProcessEnv = process.env): ControlledAdmissionEnvironment {
  const admissionFile = env[CONTROLLED_ADMISSION_ENV.admissionFile]?.trim();
  const experimentRoot = env[CONTROLLED_ADMISSION_ENV.experimentRoot]?.trim();
  if (!admissionFile || !experimentRoot) return { enabled: false };
  return { enabled: true, admissionFile, experimentRoot };
}

export function isControlledAdmissionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readControlledAdmissionEnvironment(env).enabled;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readRealPath(filePath: string, rootRealPath: string): string {
  if (!path.isAbsolute(filePath)) throw new AdmissionFailure('admission_path_outside_root', 'path is not absolute');
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(filePath);
  } catch {
    throw new AdmissionFailure('admission_file_invalid', `missing file: ${path.basename(filePath)}`);
  }
  if (lstat.isSymbolicLink()) throw new AdmissionFailure('admission_path_outside_root', 'symbolic link or junction');
  if (!lstat.isFile()) throw new AdmissionFailure('admission_file_invalid', `not a regular file: ${path.basename(filePath)}`);
  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    throw new AdmissionFailure('admission_path_outside_root', 'unreadable real path');
  }
  const root = normalizePath(rootRealPath);
  const actual = normalizePath(realPath);
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) {
    throw new AdmissionFailure('admission_path_outside_root', 'path escapes the experiment root');
  }
  return realPath;
}

// One open handle for the size check and the read: a path-based stat followed
// by a path-based read is a check-then-use race (CodeQL js/file-system-race).
function readBounded(filePath: string, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    throw new AdmissionFailure('admission_file_invalid', `unreadable file: ${path.basename(filePath)}`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new AdmissionFailure('admission_file_invalid', `file exceeds the ${maxBytes}-byte limit or is not a file`);
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, bytes, offset, stat.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== stat.size) {
      throw new AdmissionFailure('admission_file_invalid', 'file changed while it was being read');
    }
    return bytes;
  } finally {
    try { fs.closeSync(fd); } catch { /* the bounded bytes are already in memory */ }
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AdmissionFailure('admission_file_invalid', `${label} is not valid JSON`);
  }
  if (!isJsonObject(parsed)) throw new AdmissionFailure('admission_file_invalid', `${label} must be a JSON object`);
  return parsed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function requireString(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (!isNonEmptyString(value)) throw new AdmissionFailure('admission_file_invalid', `${label}.${key} must be a non-empty string`);
  return value;
}

function requireSha256(source: Record<string, unknown>, key: string, label: string): string {
  const value = source[key];
  if (!isSha256(value)) throw new AdmissionFailure('admission_file_invalid', `${label}.${key} must be a 64-hex sha256`);
  return value;
}

function validateAdmissionDocument(source: Record<string, unknown>, experimentRoot: string): AdmissionDocument {
  if (source.schemaVersion !== ADMISSION_SCHEMA) {
    throw new AdmissionFailure('admission_file_invalid', `unknown schemaVersion (expected ${ADMISSION_SCHEMA})`);
  }
  const admissionId = requireString(source, 'admissionId', 'admission');
  const operator = requireString(source, 'operator', 'admission');
  const purpose = requireString(source, 'purpose', 'admission');
  const declaredRoot = requireString(source, 'experimentRoot', 'admission');
  if (normalizePath(declaredRoot) !== normalizePath(experimentRoot)) {
    throw new AdmissionFailure('admission_file_invalid', 'admission.experimentRoot does not match the configured experiment root');
  }
  const inputPath = requireString(source, 'inputPath', 'admission');
  const inputSha256 = requireSha256(source, 'inputSha256', 'admission');
  const manifestPath = requireString(source, 'manifestPath', 'admission');
  const manifestSha256 = requireSha256(source, 'manifestSha256', 'admission');
  const targetArtifactId = requireString(source, 'targetArtifactId', 'admission');
  const targetActivationId = requireString(source, 'targetActivationId', 'admission');
  const mappingSha256 = requireSha256(source, 'mappingSha256', 'admission');
  const sessionBinding = source.sessionBinding;
  if (sessionBinding !== 'predeclared' && sessionBinding !== 'first_consumer') {
    throw new AdmissionFailure('admission_file_invalid', 'admission.sessionBinding must be predeclared or first_consumer');
  }
  const expectedSessionId = source.expectedSessionId ?? null;
  if (sessionBinding === 'predeclared' ? !isNonEmptyString(expectedSessionId) : expectedSessionId !== null) {
    throw new AdmissionFailure('admission_file_invalid', 'admission.expectedSessionId must be set iff sessionBinding=predeclared');
  }
  if (!isIsoTimestamp(source.createdAt) || !isIsoTimestamp(source.expiresAt)) {
    throw new AdmissionFailure('admission_file_invalid', 'admission timestamps must be valid ISO strings');
  }
  const createdAtMs = Date.parse(source.createdAt);
  const expiresAtMs = Date.parse(source.expiresAt);
  if (expiresAtMs <= createdAtMs || expiresAtMs - createdAtMs > MAX_ADMISSION_LIFETIME_MS) {
    throw new AdmissionFailure('admission_file_invalid', 'admission.expiresAt must be after createdAt and within 15 minutes');
  }
  const consumedAt = source.consumedAt ?? null;
  if (consumedAt !== null && !isIsoTimestamp(consumedAt)) {
    throw new AdmissionFailure('admission_file_invalid', 'admission.consumedAt must be null or a valid ISO string');
  }
  const consumedBy = source.consumedBy ?? null;
  if (consumedBy !== null && (!isJsonObject(consumedBy)
    || !isNonEmptyString(consumedBy.sessionId)
    || !isNonEmptyString(consumedBy.hookInvocationId)
    || !(typeof consumedBy.runId === 'string' || consumedBy.runId === null))) {
    throw new AdmissionFailure('admission_file_invalid', 'admission.consumedBy is malformed');
  }
  return {
    schemaVersion: ADMISSION_SCHEMA,
    admissionId, operator, purpose,
    experimentRoot: declaredRoot,
    inputPath, inputSha256, manifestPath, manifestSha256,
    targetArtifactId, targetActivationId, mappingSha256,
    sessionBinding,
    expectedSessionId: sessionBinding === 'predeclared' ? expectedSessionId as string : null,
    createdAt: source.createdAt as string,
    expiresAt: source.expiresAt as string,
    consumedAt: consumedAt as string | null,
    consumedBy: consumedBy as AdmissionDocument['consumedBy'],
  };
}

function validateManifestDocument(source: Record<string, unknown>, experimentRoot: string): ControlledAdmissionManifest {
  const targetArtifactId = requireString(source, 'targetArtifactId', 'manifest');
  const targetActivationId = requireString(source, 'targetActivationId', 'manifest');
  const sourceRef = requireString(source, 'sourceRef', 'manifest');
  const fixtureFile = requireString(source, 'fixtureFile', 'manifest');
  const fixtureSha256 = requireSha256(source, 'fixtureSha256', 'manifest');
  readRealPath(fixtureFile, experimentRoot);
  const expectedToolName = requireString(source, 'expectedToolName', 'manifest');
  const expectedContentMarker = requireString(source, 'expectedContentMarker', 'manifest');
  const configSnapshot = source.configSnapshot;
  if (!isJsonObject(configSnapshot)) {
    throw new AdmissionFailure('admission_file_invalid', 'manifest.configSnapshot must be an object');
  }
  return {
    targetArtifactId, targetActivationId, sourceRef, fixtureFile, fixtureSha256,
    expectedToolName, expectedContentMarker, configSnapshot,
  };
}

function acquireClaimLock(admissionFile: string): { release: () => void } {
  const lockPath = `${admissionFile}.claim.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new AdmissionFailure('admission_already_consumed', 'another claim holds the admission lock');
    throw new AdmissionFailure('admission_claim_write_failed', `cannot create the claim lock (${code ?? 'unknown'})`);
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try { fs.closeSync(fd); } catch { /* the lock file is the durable signal */ }
      try { fs.unlinkSync(lockPath); } catch { /* leaving the lock fails closed, never open */ }
    },
  };
}

function writeConsumedAdmission(admissionFile: string, document: AdmissionDocument, consumedAt: string,
  consumedBy: { sessionId: string; runId: string | null; hookInvocationId: string }): void {
  const payload = Buffer.from(`${JSON.stringify({ ...document, consumedAt, consumedBy }, null, 2)}\n`, 'utf8');
  if (payload.length > MAX_ADMISSION_BYTES) {
    throw new AdmissionFailure('admission_claim_write_failed', 'consumed admission would exceed the byte limit');
  }
  const tempPath = `${admissionFile}.claim.tmp`;
  try {
    fs.writeFileSync(tempPath, payload, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, admissionFile);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* original file is untouched */ }
    throw new AdmissionFailure('admission_claim_write_failed', String((error as Error)?.message ?? error));
  }
}

function validateTargetAndMapping(document: AdmissionDocument, manifest: ControlledAdmissionManifest,
  mapping: AdaptiveActivationConfig, workspaceDir: string): void {
  if (document.targetArtifactId !== mapping.artifactId || document.targetActivationId !== mapping.activationId) {
    throw new AdmissionFailure('admission_target_mismatch', 'admission target does not match the live mapping');
  }
  if (manifest.targetArtifactId !== document.targetArtifactId || manifest.targetActivationId !== document.targetActivationId) {
    throw new AdmissionFailure('admission_target_mismatch', 'manifest target does not match the admission');
  }
  const workspaceRealPath = fs.realpathSync(workspaceDir);
  const expectedMappingSha256 = canonicalAdaptiveMappingSha256({
    workspaceRealPath,
    artifactId: mapping.artifactId,
    activationId: mapping.activationId,
    softTimeoutMs: mapping.softTimeoutMs,
    expiresAtMs: mapping.expiresAtMs,
  });
  if (document.mappingSha256 !== expectedMappingSha256) {
    throw new AdmissionFailure('admission_mapping_mismatch', 'live mapping does not match the authorized mapping');
  }
}

function validatePromptProof(event: PluginHookBeforePromptBuildEvent, sessionId: string,
  inputSha256: string, admittedText: string): void {
  const prompt = Object.getOwnPropertyDescriptor(event, 'prompt')?.value;
  if (typeof prompt !== 'string') throw new AdmissionFailure('admission_input_mismatch', 'event.prompt is not a string');
  if (sha256Bytes(Buffer.from(prompt, 'utf8')) !== inputSha256) {
    throw new AdmissionFailure('admission_input_mismatch', 'event.prompt bytes do not match inputSha256');
  }
  const resolved = resolveCurrentUserMessage(event, sessionId);
  if (resolved.isAgentToAgent) throw new AdmissionFailure('admission_agent_to_agent', 'agent-to-agent messages are not operator input');
  if (resolved.message !== admittedText) {
    throw new AdmissionFailure('admission_input_parse_mismatch', 'resolved user message is not the frozen input bytes');
  }
}

function purgeClaimCache(now: number): void {
  for (const [admissionId, entry] of claimCache) {
    if (now - entry.claimedAt >= CLAIM_CACHE_TTL_MS) claimCache.delete(admissionId);
  }
}

function cacheClaim(claim: ControlledAdmissionClaim, event: object, now: number): void {
  purgeClaimCache(now);
  while (claimCache.size >= CLAIM_CACHE_CAPACITY) {
    const oldest = claimCache.keys().next().value;
    if (oldest === undefined) break;
    claimCache.delete(oldest);
  }
  claimCache.set(claim.identity.admissionId, { claim, event, claimedAt: now });
}

/**
 * Takes the same-round provider→prompt handoff for the exact host event object
 * and hook invocation. A duplicate callback, a new run with the same input, a
 * cross-session callback or a post-tool second request cannot take it: either
 * the entry is already gone or its identity does not match.
 */
export function takeControlledAdmissionHandoff(event: PluginHookBeforePromptBuildEvent,
  hookInvocationId: string | undefined, now = Date.now()): ControlledAdmissionClaim | null {
  purgeClaimCache(now);
  for (const [admissionId, entry] of claimCache) {
    if (entry.event !== event) continue;
    if (!hookInvocationId || entry.claim.hookInvocationId !== hookInvocationId) continue;
    claimCache.delete(admissionId);
    return entry.claim;
  }
  return null;
}

/** Journal close / abnormal exit removes the handoff entry; disk `consumedAt` stays authoritative. */
export function releaseControlledAdmissionClaim(claim: ControlledAdmissionClaim | null | undefined): void {
  if (!claim) return;
  const entry = claimCache.get(claim.identity.admissionId);
  if (entry?.claim.claimId === claim.claimId) claimCache.delete(claim.identity.admissionId);
}

export function resetControlledAdmissionCacheForTest(): void {
  claimCache.clear();
}

/**
 * Exclusive read→validate→write consumption. The lock, every read, the consumed
 * marker write and its rollback happen inside one mutual exclusion region, so
 * two callers can never both observe an unconsumed admission.
 */
export function claimControlledAdmission(request: ControlledAdmissionClaimRequest): ControlledAdmissionClaimResult {
  const env = readControlledAdmissionEnvironment();
  if (!env.enabled || !env.admissionFile || !env.experimentRoot) return { status: 'disabled' };
  const now = request.now ?? Date.now();
  try {
    if (!isNonEmptyString(request.sessionId)) {
      throw new AdmissionFailure('admission_session_mismatch', 'sessionId is unavailable at the consumption point');
    }
    const ownMessageId = Object.getOwnPropertyDescriptor(request.event, 'currentUserMessageId')?.value;
    const ownRequestId = Object.getOwnPropertyDescriptor(request.event, 'requestId')?.value;
    if (isNonEmptyString(ownMessageId) || isNonEmptyString(ownRequestId)) {
      throw new AdmissionFailure('admission_native_identity_present', 'operator admission cannot coexist with native host identity');
    }
    const rootRealPath = fs.realpathSync(env.experimentRoot);
    const admissionRealPath = readRealPath(env.admissionFile, rootRealPath);
    const lock = acquireClaimLock(admissionRealPath);
    try {
      const admissionBytes = readBounded(admissionRealPath, MAX_ADMISSION_BYTES);
      const document = validateAdmissionDocument(parseJsonObject(admissionBytes, 'admission'), rootRealPath);
      if (document.consumedAt !== null) {
        throw new AdmissionFailure('admission_already_consumed', 'admission was already consumed');
      }
      if (now >= Date.parse(document.expiresAt)) {
        throw new AdmissionFailure('admission_expired', 'admission expired before consumption');
      }
      const inputRealPath = readRealPath(document.inputPath, rootRealPath);
      const manifestRealPath = readRealPath(document.manifestPath, rootRealPath);
      const inputBytes = readBounded(inputRealPath, MAX_INPUT_BYTES);
      if (sha256Bytes(inputBytes) !== document.inputSha256) {
        throw new AdmissionFailure('admission_input_mismatch', 'input.txt bytes do not match inputSha256');
      }
      const manifestBytes = readBounded(manifestRealPath, MAX_MANIFEST_BYTES);
      if (sha256Bytes(manifestBytes) !== document.manifestSha256) {
        throw new AdmissionFailure('admission_manifest_mismatch', 'manifest.json bytes do not match manifestSha256');
      }
      const manifest = validateManifestDocument(parseJsonObject(manifestBytes, 'manifest'), rootRealPath);
      validateTargetAndMapping(document, manifest, request.mapping, request.workspaceDir);
      if (document.sessionBinding === 'predeclared' && document.expectedSessionId !== request.sessionId) {
        throw new AdmissionFailure('admission_session_mismatch', 'session does not match the predeclared binding');
      }
      const admittedText = inputBytes.toString('utf8');
      if (admittedText.split(/\r?\n/, 1)[0] !== SCENE_MARKER) {
        throw new AdmissionFailure('admission_scene_mismatch', 'frozen input does not open with the scene marker');
      }
      validatePromptProof(request.event, request.sessionId, document.inputSha256, admittedText);
      const binding = validateControlledAdmissionBinding({
        controlledAdmission: {
          admissionId: document.admissionId,
          inputSha256: document.inputSha256,
          manifestSha256: document.manifestSha256,
        },
        currentUserMessage: admittedText,
        sessionId: request.sessionId,
      });
      if (!binding.ok) throw new AdmissionFailure('admission_input_mismatch', `core binding rejected: ${binding.reason}`);
      const consumedAt = new Date(now).toISOString();
      const consumedBy = { sessionId: request.sessionId, runId: request.runId ?? null, hookInvocationId: request.hookInvocationId };
      writeConsumedAdmission(admissionRealPath, document, consumedAt, consumedBy);
      const claim: ControlledAdmissionClaim = {
        claimId: randomUUID(),
        identity: {
          admissionId: document.admissionId,
          operator: document.operator,
          purpose: document.purpose,
          inputSha256: document.inputSha256,
          manifestSha256: document.manifestSha256,
          mappingSha256: document.mappingSha256,
          targetArtifactId: document.targetArtifactId,
          targetActivationId: document.targetActivationId,
          expiresAt: document.expiresAt,
          consumedAt,
          consumedBy,
        },
        manifest,
        admittedText,
        hookInvocationId: request.hookInvocationId,
      };
      cacheClaim(claim, request.event, now);
      return { status: 'claimed', claim };
    } finally {
      lock.release();
    }
  } catch (error) {
    if (error instanceof AdmissionFailure) return { status: 'rejected', reason: error.reason, detail: error.detail };
    return { status: 'rejected', reason: 'admission_file_invalid', detail: String((error as Error)?.message ?? error) };
  }
}
