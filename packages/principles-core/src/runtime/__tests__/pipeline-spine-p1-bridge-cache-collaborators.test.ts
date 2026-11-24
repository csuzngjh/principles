/**
 * SPEC-PD-PIPELINE-SPINE-001 review round 2 (P1-1) — the bridge cache keys the
 * per-entry collaborators a bridge CAPTURES by OBJECT identity.
 *
 * Defect (origin/main): the cache key encoded only whether an intent reader
 * was present. A second entry calling `createPainSignalBridge` for the same
 * workspace with its OWN trajectory reader / source-material authorization
 * got the FIRST entry's bridge and ran with the first entry's collaborators.
 *
 * Real factory (`createPainSignalBridge`) over a real temp workspace; only the
 * stage runner constructors and the context assembler constructor are
 * replaced by capture classes (same technique as
 * pain-signal-factory-intent-reader-wiring.test.ts).
 *
 *   A    — same workspace, different reader / authorization objects → a
 *          bridge of its own, carrying exactly the collaborators of THAT call;
 *   C    — the same collaborator objects again → the cached bridge is reused
 *          (no second construction), even with a fresh ledger adapter / probe;
 *   bound — a slot keeps at most two collaborator variants; the superseded
 *          bridge is retired idle-safely: never while an operation is
 *          running, and reliably once it has finished.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Hoisted {
  ctorCaptures: { name: string; deps: unknown }[];
  /** Held open by a test to keep a bridge operation in flight. */
  runnerGate: { wait: Promise<void> };
  runnerActivity: { started: number };
}

const { ctorCaptures, runnerGate, runnerActivity } = vi.hoisted((): Hoisted => ({
  ctorCaptures: [],
  runnerGate: { wait: Promise.resolve() },
  runnerActivity: { started: 0 },
}));

/** A failed Stage-A result, returned once the gate (if any) opens. */
async function gatedFailure(taskId: string) {
  runnerActivity.started += 1;
  await runnerGate.wait;
  return {
    status: 'failed' as const,
    taskId,
    errorCategory: 'output_invalid' as const,
    failureReason: 'mock runner (cache-identity test)',
    attemptCount: 1,
  };
}

function makeMockRunnerClass(name: string) {
  return class {
    constructor(deps: unknown) {
      ctorCaptures.push({ name, deps });
    }
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    run = async (taskId: string): Promise<unknown> => gatedFailure(taskId);
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    runWithDeadline = async (taskId: string): Promise<unknown> => gatedFailure(taskId);
  };
}

vi.mock('../internalization/diag-router-runner.js', () => ({
  DiagRouterRunner: makeMockRunnerClass('router'),
}));
vi.mock('../internalization/diag-rootcause-runner.js', () => ({
  DiagRootCauseRunner: makeMockRunnerClass('rootcause'),
}));
vi.mock('../internalization/diag-distiller-runner.js', () => ({
  DiagDistillerRunner: makeMockRunnerClass('distiller'),
}));
// The factory hands the per-entry reader / authorization to the context
// assembler as constructor options — capture them verbatim.
vi.mock('../store/context/sqlite-context-assembler.js', () => ({
  SqliteContextAssembler: class {
    // (taskStore, historyQuery, runStore, options) — the 4th argument is what the bridge captures
    constructor(...args: unknown[]) {
      ctorCaptures.push({ name: 'contextAssembler', deps: { options: args[3] } });
    }
  },
}));

import {
  createPainSignalBridge,
  disposePainSignalBridgesForWorkspace,
} from '../pain-signal-runtime-factory.js';
import { computeEffectivePdConfig } from '../config/pd-config-effective.js';
import { getDefaultPdConfig } from '../config/pd-config-defaults.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { IntentDocReader } from '../intent/intent-doc-reader-port.js';
import type { TrajectoryTurnReader } from '../store/context/trajectory-turn-reader.js';
import type { SourceMaterialAuthorizationPort } from '../source-material-authorization.js';
import type { PainSignalBridge } from '../pain-signal-bridge.js';

const OWNER = 'pri-1291-cache-identity-test';
const ENV_KEY = 'PRI1291_CACHE_IDENTITY_TEST_KEY';

type FactoryOptions = Parameters<typeof createPainSignalBridge>[0];

interface Collaborators {
  trajectoryTurnReader: TrajectoryTurnReader;
  sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
  intentDocReader: IntentDocReader;
  /** The automatic-pain authorization probe: a captured, behavior-defining collaborator too. */
  isAutoPainSubmissionAuthorized: () => boolean;
}

function makeEffectiveConfig(): EffectivePdConfig {
  const defaults = getDefaultPdConfig();
  return computeEffectivePdConfig({
    ...defaults,
    runtimeProfiles: {
      'diag-profile': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: ENV_KEY,
      },
    },
    internalAgents: {
      defaultRuntime: 'diag-profile',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'diag-profile' },
      },
    },
  } as never);
}

/** A fresh, distinct reader object per call (identity is what the cache keys on). */
function makeReader(): TrajectoryTurnReader {
  return {
    listUserTurnsForSession: () => [],
    listAssistantTurns: () => [],
  };
}

function makeAuthorization(): SourceMaterialAuthorizationPort {
  return {
    isHostSourceMaterialAuthorized: () => ({ authorized: false, reason: 'authorization_unavailable' }),
  };
}

function makeIntentReader(): IntentDocReader {
  return {
    readIntentDoc: () => ({
      ok: false,
      found: false,
      flagEnabled: false,
      reason: 'flag_disabled' as const,
      nextAction: 'cache-identity test reader',
    }),
  };
}

/** One collaborator set — four distinct objects, compared by identity. */
function makeVariant(): Collaborators {
  return {
    trajectoryTurnReader: makeReader(),
    sourceMaterialAuthorization: makeAuthorization(),
    intentDocReader: makeIntentReader(),
    isAutoPainSubmissionAuthorized: () => true,
  };
}

/** One factory call. Everything NOT part of the cache identity is recreated
 * per call on purpose (fresh ledger adapter, env accessor) — exactly what the
 * production call sites do — to prove none of it defeats the reuse. */
function call(workspaceDir: string, collaborators: Partial<Collaborators> = {}): Promise<PainSignalBridge> {
  return createPainSignalBridge({
    workspaceDir,
    stateDir: join(workspaceDir, '.state'),
    ledgerAdapter: {},
    owner: OWNER,
    effectiveConfig: makeEffectiveConfig(),
    getEnvVar: (name: string) => (name === ENV_KEY ? 'sentinel' : undefined),
    ...collaborators,
  } as FactoryOptions);
}

interface AssemblerOptions {
  trajectoryTurnReader?: TrajectoryTurnReader;
  sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
}

function lastAssemblerOptions(): AssemblerOptions {
  const captures = ctorCaptures.filter((c) => c.name === 'contextAssembler');
  const last = captures[captures.length - 1]?.deps as { options?: AssemblerOptions } | undefined;
  if (last?.options === undefined) throw new Error('no context assembler was constructed');
  return last.options;
}

function lastRootCauseDeps(): { intentDocReader?: IntentDocReader } {
  const captures = ctorCaptures.filter((c) => c.name === 'rootcause');
  const last = captures[captures.length - 1]?.deps as { intentDocReader?: IntentDocReader } | undefined;
  if (last === undefined) throw new Error('no Stage A runner was constructed');
  return last;
}

function constructions(): number {
  return ctorCaptures.filter((c) => c.name === 'contextAssembler').length;
}

afterEach(() => {
  ctorCaptures.length = 0;
  runnerGate.wait = Promise.resolve();
  runnerActivity.started = 0;
});

async function withWorkspace(run: (workspaceDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pri-1291-cache-identity-'));
  const workspaceDir = join(root, 'workspace');
  mkdirSync(join(workspaceDir, '.state'), { recursive: true });
  try {
    await run(workspaceDir);
  } finally {
    runnerGate.wait = Promise.resolve();
    await disposePainSignalBridgesForWorkspace(workspaceDir);
    rmSync(root, { recursive: true, force: true });
  }
}

describe('P1-1 — bridge cache identity follows the captured collaborators (object identity)', () => {
  it("scenario A: a second entry with its OWN reader / authorization never runs on the first entry's bridge", async () => {
    await withWorkspace(async (workspaceDir) => {
      const variantA = makeVariant();
      const bridgeA = await call(workspaceDir, variantA);
      expect(lastAssemblerOptions()).toMatchObject({
        trajectoryTurnReader: variantA.trajectoryTurnReader,
        sourceMaterialAuthorization: variantA.sourceMaterialAuthorization,
      });
      expect(lastRootCauseDeps().intentDocReader).toBe(variantA.intentDocReader);

      const variantB = makeVariant();
      const bridgeB = await call(workspaceDir, variantB);

      // its own bridge, built with exactly the collaborators of THIS call
      expect(bridgeB).not.toBe(bridgeA);
      expect(constructions()).toBe(2);
      expect(lastAssemblerOptions()).toMatchObject({
        trajectoryTurnReader: variantB.trajectoryTurnReader,
        sourceMaterialAuthorization: variantB.sourceMaterialAuthorization,
      });
      expect(lastRootCauseDeps().intentDocReader).toBe(variantB.intentDocReader);
    });
  });

  it('scenario A (the presence trap): both calls pass a reader AND an authorization — only identity tells them apart', async () => {
    await withWorkspace(async (workspaceDir) => {
      // Pre-fix key segment was `…:r:…` for BOTH calls → the second call got
      // the first bridge (e.g. the OpenClaw command's session reader replaced
      // by the background auto-run's governance reader).
      const autoRun = { trajectoryTurnReader: makeReader(), sourceMaterialAuthorization: makeAuthorization(), intentDocReader: makeIntentReader() };
      const openClawCommand = { trajectoryTurnReader: makeReader(), sourceMaterialAuthorization: makeAuthorization(), intentDocReader: makeIntentReader() };
      const first = await call(workspaceDir, autoRun);
      const second = await call(workspaceDir, openClawCommand);
      expect(second).not.toBe(first);
      expect(lastAssemblerOptions().trajectoryTurnReader).toBe(openClawCommand.trajectoryTurnReader);
    });
  });

  it('scenario C: the same collaborator objects again reuse the cached bridge — no second construction', async () => {
    await withWorkspace(async (workspaceDir) => {
      const stable = makeVariant();
      const first = await call(workspaceDir, stable);
      expect(constructions()).toBe(1);

      const again = await call(workspaceDir, stable);
      expect(again).toBe(first);
      expect(constructions()).toBe(1);
    });
  });

  it('absent and present collaborators are different cache identities (deny-all fallback never shadows a wired authorization)', async () => {
    await withWorkspace(async (workspaceDir) => {
      const withoutAny = await call(workspaceDir);
      const onlyReader = makeVariant();
      const withReader = await call(workspaceDir, { trajectoryTurnReader: onlyReader.trajectoryTurnReader });
      const onlyAuthorization = makeVariant();
      const withAuthorization = await call(workspaceDir, { sourceMaterialAuthorization: onlyAuthorization.sourceMaterialAuthorization });
      expect(new Set([withoutAny, withReader, withAuthorization]).size).toBe(3);
      expect(lastAssemblerOptions()).toMatchObject({
        trajectoryTurnReader: undefined,
        sourceMaterialAuthorization: onlyAuthorization.sourceMaterialAuthorization,
      });

      // the automatic-pain authorization probe is captured by the bridge and
      // is keyed as well: the same reader with a DIFFERENT probe is a
      // different cache identity (a bypass probe must never shadow the
      // workspace-flag probe of another entry)
      const probeOne = makeVariant().isAutoPainSubmissionAuthorized;
      const probeTwo = makeVariant().isAutoPainSubmissionAuthorized;
      const withProbeOne = await call(workspaceDir, { trajectoryTurnReader: onlyReader.trajectoryTurnReader, isAutoPainSubmissionAuthorized: probeOne });
      const withProbeTwo = await call(workspaceDir, { trajectoryTurnReader: onlyReader.trajectoryTurnReader, isAutoPainSubmissionAuthorized: probeTwo });
      expect(withProbeOne).not.toBe(withReader);
      expect(withProbeTwo).not.toBe(withProbeOne);
    });
  });

  it('bound: a third variant retires the least-recently-used one, which releases its handles once idle', async () => {
    await withWorkspace(async (workspaceDir) => {
      const variantA = makeVariant();
      const variantB = makeVariant();
      const variantC = makeVariant();
      const bridgeA = await call(workspaceDir, variantA);
      const bridgeB = await call(workspaceDir, variantB);
      // Consume each factory-return borrow before testing idle eviction. A
      // factory return that has not started an operation remains protected.
      await bridgeB.resumeSucceededDiagnosisPostProcessing({ taskId: 'missing-before-eviction-1' });
      // touch B, then A: the slot's recency order is now [B (older), A (newer)]
      expect(await call(workspaceDir, variantB)).toBe(bridgeB);
      await bridgeB.resumeSucceededDiagnosisPostProcessing({ taskId: 'missing-before-eviction-2' });
      expect(await call(workspaceDir, variantA)).toBe(bridgeA);

      const disposeBSpy = vi.spyOn(bridgeB, 'dispose');
      const bridgeC = await call(workspaceDir, variantC);
      // the bound is two per slot: C superseded the least recently used, B
      await vi.waitFor(() => expect(disposeBSpy).toHaveBeenCalledTimes(1));

      // A (the more recently used one) is still cached; B is gone — its own
      // collaborators now build a NEW bridge, which in turn retires the
      // now-oldest variant C: the bound holds after every insertion
      expect(await call(workspaceDir, variantA)).toBe(bridgeA);
      const disposeCSpy = vi.spyOn(bridgeC, 'dispose');
      await bridgeC.resumeSucceededDiagnosisPostProcessing({ taskId: 'missing-before-eviction-3' });
      const bridgeB2 = await call(workspaceDir, variantB);
      expect(bridgeB2).not.toBe(bridgeB);
      await vi.waitFor(() => expect(disposeCSpy).toHaveBeenCalledTimes(1));
    });
  });

  it('factory borrow protects a returned bridge until its first operation starts', async () => {
    await withWorkspace(async (workspaceDir) => {
      const variantA = makeVariant();
      const bridgeA = await call(workspaceDir, variantA);
      const disposeASpy = vi.spyOn(bridgeA, 'dispose');

      // Two other variants evict A before its caller starts using it.
      await call(workspaceDir, makeVariant());
      await call(workspaceDir, makeVariant());
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(disposeASpy).not.toHaveBeenCalled();

      // Starting the first operation consumes the borrow. The deferred
      // retirement then runs after that operation releases its active count.
      const result = await bridgeA.resumeSucceededDiagnosisPostProcessing({ taskId: 'missing-after-eviction' });
      expect(result.status).toBe('not_applicable');
      await vi.waitFor(() => expect(disposeASpy).toHaveBeenCalledTimes(1));
    });
  });

  it('idle-safe retirement: an evicted bridge finishes the operation it is running, then is disposed — never mid-run', async () => {
    await withWorkspace(async (workspaceDir) => {
      const variantA = makeVariant();
      const bridgeA = await call(workspaceDir, variantA);
      const disposeASpy = vi.spyOn(bridgeA, 'dispose');
      // a pending diagnosis task for bridge A to execute
      const { taskId } = await bridgeA.submitPainSignal({
        painId: 'pain-cache-identity',
        painType: 'user_frustration',
        source: 'manual',
        reason: 'cache identity idle-safety',
        sessionId: 'session-cache-identity',
        agentId: 'agent',
        evidence: [{ sourceRef: 'tool_calls:1', note: 'evidence' }],
      });

      // hold the stage runner open so the operation stays in flight …
      let release: () => void = () => undefined;
      runnerGate.wait = new Promise<void>((resolve) => { release = resolve; });
      const inFlight = bridgeA.executePendingDiagnosis({ taskId });
      await vi.waitFor(() => expect(runnerActivity.started).toBe(1));

      // … while two other variants arrive and the bound retires A
      await call(workspaceDir, makeVariant());
      await call(workspaceDir, makeVariant());
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      // retirement was requested but deferred: the running diagnosis is NOT interrupted
      expect(disposeASpy).not.toHaveBeenCalled();

      release();
      await inFlight;
      // … and happens reliably once the operation has finished
      await vi.waitFor(() => expect(disposeASpy).toHaveBeenCalledTimes(1));
    });
  });
});
