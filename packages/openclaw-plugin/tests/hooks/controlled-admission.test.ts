import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalAdaptiveMappingSha256 } from '@principles/core/runtime-v2';
import type { PluginHookBeforePromptBuildEvent } from '../../src/openclaw-sdk.js';
import {
  claimControlledAdmission,
  isControlledAdmissionConfigured,
  releaseControlledAdmissionClaim,
  resetControlledAdmissionCacheForTest,
  takeControlledAdmissionHandoff,
} from '../../src/hooks/controlled-admission.js';

const SCENE = '[PD-AA:delivery-review:v1]\nInspect the fixture file and report its marker.';

interface Fixture {
  root: string;
  workspaceDir: string;
  mapping: { artifactId: string; activationId: string; softTimeoutMs: number; expiresAtMs: number };
  inputText: string;
  admissionPath: string;
}

let fixture: Fixture;
const savedEnv = { ...process.env };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeFixture(options: {
  inputText?: string;
  artifactId?: string;
  activationId?: string;
  sessionBinding?: 'predeclared' | 'first_consumer';
  expectedSessionId?: string | null;
  expiresInMs?: number;
  createdAtInMs?: number;
  consumedAt?: string | null;
  mappingSha256?: string;
  inputSha256?: string;
  manifestSha256?: string;
} = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-aa-admission-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const inputText = options.inputText ?? SCENE;
  const artifactId = options.artifactId ?? 'artifact-1';
  const activationId = options.activationId ?? 'activation-1';
  const now = Date.now();
  const mapping = { artifactId, activationId, softTimeoutMs: 5_000, expiresAtMs: now + 10 * 60_000 };

  const inputPath = path.join(root, 'input.txt');
  fs.writeFileSync(inputPath, inputText, 'utf8');
  const fixturePath = path.join(root, 'fixture.txt');
  const fixtureContent = 'AA-FIXTURE-CONTENT';
  fs.writeFileSync(fixturePath, fixtureContent, 'utf8');
  const manifest = {
    targetArtifactId: artifactId,
    targetActivationId: activationId,
    sourceRef: '#2386@3579474cf',
    fixtureFile: fixturePath,
    fixtureSha256: sha256(fixtureContent),
    expectedToolName: 'read',
    expectedContentMarker: fixtureContent,
    configSnapshot: { adaptiveActivation: { artifactId, activationId } },
  };
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  const admission = {
    schemaVersion: 'pd-aa-controlled-admission/v2',
    admissionId: 'adm-1',
    operator: 'owner',
    purpose: 'controlled-admission wiring experiment',
    experimentRoot: root,
    inputPath,
    inputSha256: options.inputSha256 ?? sha256(inputText),
    manifestPath,
    manifestSha256: options.manifestSha256 ?? sha256(JSON.stringify(manifest)),
    targetArtifactId: artifactId,
    targetActivationId: activationId,
    mappingSha256: options.mappingSha256 ?? canonicalAdaptiveMappingSha256({
      workspaceRealPath: fs.realpathSync(workspaceDir),
      artifactId,
      activationId,
      softTimeoutMs: mapping.softTimeoutMs,
      expiresAtMs: mapping.expiresAtMs,
    }),
    sessionBinding: options.sessionBinding ?? 'first_consumer',
    expectedSessionId: options.expectedSessionId ?? null,
    createdAt: new Date(now + (options.createdAtInMs ?? 0)).toISOString(),
    expiresAt: new Date(now + (options.expiresInMs ?? 10 * 60_000)).toISOString(),
    consumedAt: options.consumedAt ?? null,
    consumedBy: null,
  };
  const admissionPath = path.join(root, 'admission.json');
  fs.writeFileSync(admissionPath, JSON.stringify(admission, null, 2), 'utf8');
  process.env.PD_AA_ADMISSION_FILE = admissionPath;
  process.env.PD_AA_EXPERIMENT_ROOT = root;
  return { root, workspaceDir, mapping, inputText, admissionPath };
}

function event(prompt: string, extra: Record<string, unknown> = {}): PluginHookBeforePromptBuildEvent {
  return { prompt, messages: [], ...extra } as unknown as PluginHookBeforePromptBuildEvent;
}

function claim(overrides: Partial<Parameters<typeof claimControlledAdmission>[0]> = {}) {
  return claimControlledAdmission({
    event: event(fixture.inputText),
    workspaceDir: fixture.workspaceDir,
    sessionId: 'session-1',
    runId: 'run-1',
    mapping: fixture.mapping,
    hookInvocationId: 'hook-1',
    ...overrides,
  });
}

beforeEach(() => {
  resetControlledAdmissionCacheForTest();
  fixture = writeFixture();
});

afterEach(() => {
  process.env = { ...savedEnv };
  try { fs.rmSync(fixture.root, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('controlled admission — default off and disabled branches', () => {
  it('is disabled unless both isolation variables are present', () => {
    delete process.env.PD_AA_ADMISSION_FILE;
    delete process.env.PD_AA_EXPERIMENT_ROOT;
    expect(isControlledAdmissionConfigured()).toBe(false);
    expect(claim({}).status).toBe('disabled');
    process.env.PD_AA_ADMISSION_FILE = fixture.admissionPath;
    delete process.env.PD_AA_EXPERIMENT_ROOT;
    expect(claim({}).status).toBe('disabled');
  });
});

describe('controlled admission — one-time consumption', () => {
  it('claims once, persists consumedAt/consumedBy and hands off to the same-round prompt callback', () => {
    const hostEvent = event(fixture.inputText);
    const first = claim({ event: hostEvent });
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') return;

    const persisted = JSON.parse(fs.readFileSync(fixture.admissionPath, 'utf8'));
    expect(persisted.consumedAt).toBe(first.claim.identity.consumedAt);
    expect(persisted.consumedBy.hookInvocationId).toBe('hook-1');
    expect(persisted.consumedBy.sessionId).toBe('session-1');

    // Same-round provider→prompt handoff: identical event object and hook invocation.
    const handedOff = takeControlledAdmissionHandoff(hostEvent, 'hook-1');
    expect(handedOff?.claimId).toBe(first.claim.claimId);

    // The handoff is one-way: a duplicate callback with the same event cannot take it again.
    expect(takeControlledAdmissionHandoff(hostEvent, 'hook-1')).toBeNull();
  });

  it('rejects a repeated callback, a new run with the same input and a post-tool second request', () => {
    expect(claim({ event: event(fixture.inputText) }).status).toBe('claimed');

    const repeatedCallback = claim({ event: event(fixture.inputText), hookInvocationId: 'hook-2' });
    expect(repeatedCallback.status).toBe('rejected');
    if (repeatedCallback.status === 'rejected') expect(repeatedCallback.reason).toBe('admission_already_consumed');

    const newRunSameInput = claim({ event: event(fixture.inputText), runId: 'run-2', hookInvocationId: 'hook-3' });
    expect(newRunSameInput.status).toBe('rejected');
    if (newRunSameInput.status === 'rejected') expect(newRunSameInput.reason).toBe('admission_already_consumed');

    const afterToolSecondRequest = claimControlledAdmission({
      event: event(`${fixture.inputText}\ntool result: ok`),
      workspaceDir: fixture.workspaceDir,
      sessionId: 'session-1',
      runId: 'run-1',
      mapping: fixture.mapping,
      hookInvocationId: 'hook-4',
    });
    expect(afterToolSecondRequest.status).toBe('rejected');
    if (afterToolSecondRequest.status === 'rejected') expect(afterToolSecondRequest.reason).toBe('admission_already_consumed');
  });

  it('never lets a pre-declared cross-session consumer claim the admission', () => {
    fixture = writeFixture({ sessionBinding: 'predeclared', expectedSessionId: 'session-A' });
    const rejected = claim({ sessionId: 'session-B' });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_session_mismatch');
    const persisted = JSON.parse(fs.readFileSync(fixture.admissionPath, 'utf8'));
    expect(persisted.consumedAt).toBeNull();
  });

  it('treats a held claim lock as already consumed instead of racing a second reader', () => {
    fs.writeFileSync(`${fixture.admissionPath}.claim.lock`, '', 'utf8');
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_already_consumed');
  });

  it('releases the cache entry without reviving the disk admission', () => {
    const hostEvent = event(fixture.inputText);
    const first = claim({ event: hostEvent });
    if (first.status !== 'claimed') throw new Error('expected claim');
    releaseControlledAdmissionClaim(first.claim);
    expect(takeControlledAdmissionHandoff(hostEvent, 'hook-1')).toBeNull();
    expect(claim({ event: event(fixture.inputText), hookInvocationId: 'hook-9' }).status).toBe('rejected');
  });
});

describe('controlled admission — rejected inputs', () => {
  it('rejects when native host identity is present', () => {
    const rejected = claim({ event: event(fixture.inputText, { currentUserMessageId: 'native-1' }) });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_native_identity_present');
  });

  it('rejects when event.prompt bytes no longer match inputSha256', () => {
    const rejected = claim({ event: event('[PD-AA:delivery-review:v1]\ndifferent input') });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_input_mismatch');
  });

  it('rejects when the frozen input does not open with the scene marker', () => {
    fixture = writeFixture({ inputText: 'no marker here' });
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_scene_mismatch');
  });

  it('rejects an expired admission', () => {
    fixture = writeFixture({ createdAtInMs: -120_000, expiresInMs: -60_000 });
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_expired');
  });

  it('rejects a live mapping that differs from the authorized mapping', () => {
    fixture = writeFixture();
    const rejected = claim({ mapping: { ...fixture.mapping, activationId: 'activation-2' } });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_target_mismatch');
  });

  it('rejects a mapping hash that does not match the live configuration', () => {
    fixture = writeFixture({ mappingSha256: 'a'.repeat(64) });
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_mapping_mismatch');
  });

  it('rejects a manifest whose bytes do not match manifestSha256', () => {
    fixture = writeFixture({ manifestSha256: 'b'.repeat(64) });
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_manifest_mismatch');
  });

  it('rejects an input file above the byte limit', () => {
    fixture = writeFixture({ inputText: `${SCENE}\n${'x'.repeat(20 * 1024)}` });
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_file_invalid');
  });

  it('rejects an admission path outside the experiment root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-aa-outside-'));
    const outsideFile = path.join(outside, 'admission.json');
    fs.writeFileSync(outsideFile, fs.readFileSync(fixture.admissionPath));
    process.env.PD_AA_ADMISSION_FILE = outsideFile;
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_path_outside_root');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects an admission that is already consumed on disk', () => {
    fixture = writeFixture({ consumedAt: new Date().toISOString() });
    const rejected = claim({});
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_already_consumed');
  });

  it('does not consume on a failed validation, so one corrected attempt remains possible', () => {
    const rejected = claim({ event: event('wrong bytes') });
    expect(rejected.status).toBe('rejected');
    expect(JSON.parse(fs.readFileSync(fixture.admissionPath, 'utf8')).consumedAt).toBeNull();
    expect(claim({}).status).toBe('claimed');
  });

  it('rejects without a trusted session at the consumption point', () => {
    const rejected = claim({ sessionId: undefined });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.reason).toBe('admission_session_mismatch');
  });
});
