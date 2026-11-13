import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONVERSATION_INGESTION_MAX_BATCH_BYTES,
  TranscriptReplacedError,
  compareDisclosureVersions,
  planJsonlWindow,
  resolveTextPolicy,
  runConversationIngestion,
  type HookHints,
  type SessionRef,
  type TranscriptDelta,
  type TranscriptPort,
  type TranscriptSourceAdapter,
} from '../src/conversation-ingestion/index.js';
import {
  ingestGovernanceObservations,
  listGovernanceObservations,
  readGovernanceCheckpoint,
  type GovernanceObservationInput,
} from '../src/governance-observation-store.js';

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-conv-seam-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'trajectory.db'), '');
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

const NOW = new Date('2026-11-11T12:00:00.000Z');

function observation(overrides: Partial<GovernanceObservationInput> & { logicalObservationKey: string }): GovernanceObservationInput {
  return {
    hostKind: 'workbuddy',
    rolloutIdentity: 'sess-1',
    rootSessionId: 'root-1',
    hostTurnId: 't1',
    kind: 'user_turn',
    source: 'transcript',
    completeness: 'complete',
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeDelta(overrides: Partial<TranscriptDelta> = {}): TranscriptDelta {
  return {
    observations: [],
    rollout: { rootSessionId: 'root-1' },
    guard: null,
    compactionTimestamp: null,
    rollbackTurns: [],
    stop: { kind: 'eof' },
    nextByteOffset: 0,
    lastOrdinal: -1,
    warnings: [],
    fileSize: 0,
    ...overrides,
  };
}

interface SourceHarness {
  readonly source: TranscriptSourceAdapter;
  readonly reads: unknown[];
  readonly decodes: { window: unknown; checkpoint: unknown }[];
}

function makeSource(options: {
  delta?: TranscriptDelta | ((args: { checkpoint: unknown }) => TranscriptDelta);
  locate?: 'ok' | 'degraded';
} = {}): SourceHarness {
  const reads: unknown[] = [];
  const decodes: { window: unknown; checkpoint: unknown }[] = [];
  const source: TranscriptSourceAdapter = {
    hostKind: 'workbuddy',
    locate(_session: SessionRef, _hints: HookHints) {
      if (options.locate === 'degraded') {
        return { status: 'degraded', reason: 'locate_refused', nextAction: 'provide an explicit transcript path.' };
      }
      return {
        status: 'ok',
        filePath: 'C:\\transcripts\\sess-1.jsonl',
        expectedIdentity: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        sessionIdentity: 'sess-1',
      };
    },
    decodeWindow(_locator, window, checkpoint) {
      decodes.push({ window, checkpoint });
      return typeof options.delta === 'function' ? options.delta({ checkpoint }) : (options.delta ?? makeDelta());
    },
  };
  return { source, reads, decodes };
}

function makePort(result: { bytes: string; fileSize: number } | { throw: Error }): { port: TranscriptPort } {
  return {
    port: {
      read(request) {
        if ('throw' in result) throw result.throw;
        return { bytes: Buffer.from(result.bytes, 'utf8'), fileSize: result.fileSize };
      },
    },
  };
}

const BASE_ARGS = {
  workspaceDir: '',
  session: { sessionId: 'root-1' },
  hints: {},
  flags: { ingestionEnabled: true },
  consent: { decision: 'granted' as const },
  now: NOW,
};

describe('runConversationIngestion — gates (SPEC §10 / §8.2)', () => {
  it('flag-off short-circuits with ZERO port calls (hard privacy invariant)', () => {
    const harness = makeSource({ delta: makeDelta({ observations: [observation({ logicalObservationKey: 'wb|sess-1|t1|user' })] }) });
    const { port } = makePort({ bytes: 'x', fileSize: 1 });
    const outcome = runConversationIngestion({
      ...BASE_ARGS, workspaceDir, source: harness.source, port,
      flags: { ingestionEnabled: false },
    });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'ingestion_disabled' });
    expect(harness.decodes).toHaveLength(0);
    const listed = listGovernanceObservations({ workspaceDir });
    expect(listed.ok ? listed.observations : listed).toEqual([]);
  });

  it('consent not granted short-circuits with ZERO port calls', () => {
    const harness = makeSource();
    const outcome = runConversationIngestion({
      ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 0 }).port,
      consent: { decision: 'not_present' },
    });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'consent_not_granted:not_present' });
    expect(harness.decodes).toHaveLength(0);
  });

  it('a degraded locate passes through without touching the port', () => {
    const harness = makeSource({ locate: 'degraded' });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 0 }).port });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'locate_refused' });
    expect(harness.decodes).toHaveLength(0);
  });
});

describe('runConversationIngestion — transcript delta lifecycle', () => {
  it('commits observations with the checkpoint under the session identity', () => {
    const harness = makeSource({
      delta: makeDelta({
        observations: [observation({ logicalObservationKey: 'wb|sess-1|t1|user', visibleText: 'hello' })],
        nextByteOffset: 42,
        lastOrdinal: 3,
        fileSize: 42,
      }),
    });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 42 }).port });
    expect(outcome).toMatchObject({ status: 'ok', inserted: 1, lagBytes: 0, sessionIdentity: 'sess-1', checkpointByteOffset: 42 });
    const cp = readGovernanceCheckpoint({ workspaceDir, hostKind: 'workbuddy', rolloutIdentity: 'sess-1' });
    expect(cp && 'byteOffset' in cp ? cp : null).toMatchObject({ byteOffset: 42, lastOrdinal: 3, rootSessionId: 'root-1' });
  });

  it('a host guard refusal ingests NOTHING and holds the checkpoint (no row)', () => {
    const harness = makeSource({
      delta: makeDelta({
        observations: [observation({ logicalObservationKey: 'wb|sess-1|t1|user' })],
        guard: { reason: 'unsupported_version:9.9.9', nextAction: 'upgrade the host CLI.' },
      }),
    });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 10 }).port });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'unsupported_version:9.9.9' });
    expect(listGovernanceObservations({ workspaceDir })).toMatchObject({ ok: true, observations: [] });
    expect(readGovernanceCheckpoint({ workspaceDir, hostKind: 'workbuddy', rolloutIdentity: 'sess-1' })).toBeNull();
  });

  it('a pre-ingest side-write failure holds the checkpoint (retry-safe)', () => {
    const harness = makeSource({ delta: makeDelta({ nextByteOffset: 42, fileSize: 42 }) });
    const outcome = runConversationIngestion({
      ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 42 }).port,
      preIngest: () => ({ ok: false, reason: 'side_write_failed', nextAction: 'inspect the db.' }),
    });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'side_write_failed' });
    expect(readGovernanceCheckpoint({ workspaceDir, hostKind: 'workbuddy', rolloutIdentity: 'sess-1' })).toBeNull();
  });

  it('a malformed stop commits prior records, holds the checkpoint at the record, and degrades loudly', () => {
    const harness = makeSource({
      delta: makeDelta({
        observations: [observation({ logicalObservationKey: 'wb|sess-1|t1|user' })],
        stop: { kind: 'malformed', ordinal: 7 },
        nextByteOffset: 42,
        fileSize: 100,
      }),
    });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 100 }).port });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'transcript_record_malformed' });
    expect(listGovernanceObservations({ workspaceDir })).toMatchObject({ ok: true, observations: [expect.objectContaining({ logicalKey: 'wb|sess-1|t1|user' })] });
    const cp = readGovernanceCheckpoint({ workspaceDir, hostKind: 'workbuddy', rolloutIdentity: 'sess-1' });
    expect(cp && 'byteOffset' in cp ? cp : null).toMatchObject({ byteOffset: 42, lastDegradationReason: 'transcript_record_malformed' });
  });

  it('an incomplete tail is ok-with-warning and parks the checkpoint at the tail start', () => {
    const harness = makeSource({
      delta: makeDelta({ stop: { kind: 'incomplete_tail' }, nextByteOffset: 42, lastOrdinal: 5, fileSize: 60 }),
    });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 60 }).port });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.warnings).toContain('transcript_incomplete_tail');
      expect(outcome.lagBytes).toBe(18);
    }
  });

  it('TOCTOU replacement maps to the structured transcript_replaced refusal', () => {
    const harness = makeSource();
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ throw: new TranscriptReplacedError() }).port });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'transcript_replaced' });
  });

  it('a shrunken transcript below the committed cursor degrades as checkpoint_inconsistent', () => {
    // Seed a committed water mark above the file the port now reports.
    ingestGovernanceObservations({
      workspaceDir,
      observations: [],
      checkpoint: { hostKind: 'workbuddy', rolloutIdentity: 'sess-1', byteOffset: 100, lastOrdinal: 1, rootSessionId: 'root-1', incompleteTail: false },
      now: NOW,
    });
    const harness = makeSource();
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 50 }).port });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'checkpoint_inconsistent' });
  });
});

describe('planJsonlWindow — incomplete-tail semantics (host-neutral skeleton)', () => {
  it('splits complete lines with absolute byte starts and exposes the unterminated tail', () => {
    const plan = planJsonlWindow(Buffer.from('a\nbb\nccc', 'utf8'), 1000);
    expect(plan.lines.map((line) => [line.bytes.toString('utf8'), line.recordByteStart])).toEqual([['a', 1000], ['bb', 1002]]);
    expect(plan.completeEndOffset).toBe(1005);
    expect(plan.tail !== null ? [plan.tail.bytes.toString('utf8'), plan.tail.startOffset] : null).toEqual(['ccc', 1005]);
  });

  it('a fully newline-terminated window has no tail', () => {
    const plan = planJsonlWindow(Buffer.from('a\nb\n', 'utf8'), 0);
    expect(plan.tail).toBeNull();
    expect(plan.completeEndOffset).toBe(4);
  });

  it('empty lines are preserved as slices for the host to skip in order', () => {
    const plan = planJsonlWindow(Buffer.from('\n\nx\n', 'utf8'), 0);
    expect(plan.lines.map((line) => line.bytes.length)).toEqual([0, 0, 1]);
  });

  it('a window with no newline at all is one tail (oversized-record shape)', () => {
    const plan = planJsonlWindow(Buffer.from('abc', 'utf8'), 40);
    expect(plan.lines).toEqual([]);
    expect(plan.tail !== null ? plan.tail.startOffset : null).toBe(40);
  });

  it('an empty window plans to nothing', () => {
    const plan = planJsonlWindow(Buffer.alloc(0), 7);
    expect(plan.lines).toEqual([]);
    expect(plan.tail).toBeNull();
    expect(plan.completeEndOffset).toBe(7);
  });
});

describe('runConversationIngestion — consent-tiered text policy (PRI-1179)', () => {
  const long = `${'lorem ipsum dolor sit amet '.repeat(20)}end`;

  it('stores visible_text up to the full-tier bound when the caller resolves full', () => {
    const harness = makeSource({ delta: makeDelta({ observations: [observation({ logicalObservationKey: 'wb|sess-1|t1|user', visibleText: long })] }) });
    const outcome = runConversationIngestion({
      ...BASE_ARGS,
      workspaceDir,
      source: harness.source,
      port: makePort({ bytes: '', fileSize: 0 }).port,
      textPolicy: { tier: 'full', maxChars: 20_000 },
    });
    expect(outcome.status).toBe('ok');
    const listed = listGovernanceObservations({ workspaceDir, rolloutIdentity: 'sess-1' });
    expect(listed.ok ? listed.observations[0]?.visibleText : null).toBe(long);
  });

  it('keeps the bounded 200-char content cap when no policy is supplied', () => {
    const harness = makeSource({ delta: makeDelta({ observations: [observation({ logicalObservationKey: 'wb|sess-1|t1|user', visibleText: long })] }) });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 0 }).port });
    expect(outcome.status).toBe('ok');
    const listed = listGovernanceObservations({ workspaceDir, rolloutIdentity: 'sess-1' });
    expect(listed.ok ? listed.observations[0]?.visibleText : null).toBe(`${long.slice(0, 200)}___TRUNCATED___`);
  });
});

describe('resolveTextPolicy — consent-tiered bounds (SPEC v0.2 §8.1)', () => {
  it('defaults to bounded; full requires granted AND a disclosure at least the current one', () => {
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: 'b1' }, 'b2')).toEqual({ tier: 'bounded', maxChars: 200 });
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: 'b2' }, 'b2')).toEqual({ tier: 'full', maxChars: 20_000 });
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: 'b3' }, 'b2')).toEqual({ tier: 'full', maxChars: 20_000 });
    expect(resolveTextPolicy({ decision: 'revoked', disclosureVersion: 'b2' }, 'b2')).toEqual({ tier: 'bounded', maxChars: 200 });
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: null }, 'b2')).toEqual({ tier: 'bounded', maxChars: 200 });
  });

  it('numeric version segments compare numerically in BOTH directions (b2 < b10, review)', () => {
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: 'b2' }, 'b10')).toEqual({ tier: 'bounded', maxChars: 200 });
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: 'b10' }, 'b2')).toEqual({ tier: 'full', maxChars: 20_000 });
    // Date-style families keep their natural order.
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: 'g2a-2026-08-28' }, 'g2a-2026-09-01')).toEqual({ tier: 'bounded', maxChars: 200 });
    expect(resolveTextPolicy({ decision: 'granted', disclosureVersion: 'g2a-2026-09-01' }, 'g2a-2026-08-28')).toEqual({ tier: 'full', maxChars: 20_000 });
  });

  it('compareDisclosureVersions: mixed segments, prefix, and equality', () => {
    expect(compareDisclosureVersions('b2', 'b10')).toBeLessThan(0);
    expect(compareDisclosureVersions('b10', 'b2')).toBeGreaterThan(0);
    expect(compareDisclosureVersions('b2', 'b2')).toBe(0);
    expect(compareDisclosureVersions('g2a-2026-08-28', 'g2a-2026-08-28')).toBe(0);
    // Missing trailing segment orders below a present one ('b2' < 'b2.1').
    expect(compareDisclosureVersions('b2', 'b2.1')).toBeLessThan(0);
    // Non-numeric segments fall back to lexicographic.
    expect(compareDisclosureVersions('a10', 'b2')).toBeLessThan(0);
  });
});

describe('seam constants', () => {
  it('keeps the shared batch bounds (1 MiB / 256 records)', () => {
    expect(CONVERSATION_INGESTION_MAX_BATCH_BYTES).toBe(1024 * 1024);
  });
});

describe('runConversationIngestion — durable degradation fact (rc-9)', () => {
  interface DegradationFact {
    type: string;
    category: string;
    sessionId?: string;
    data: Record<string, unknown>;
  }

  function readDegradationFacts(): DegradationFact[] {
    const dir = path.join(workspaceDir, '.state', 'logs');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => /^events_\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((line) => line.trim().length > 0))
      .map((line) => JSON.parse(line) as DegradationFact)
      .filter((entry) => entry.type === 'conversation_ingestion');
  }

  it('a host contract refusal leaves a durable, bounded fact and still ingests nothing', () => {
    const harness = makeSource({
      delta: makeDelta({ guard: { reason: 'codex_version_unverified:0.167.0-alpha.4.1', nextAction: 'rerun the Codex contract probe / update supported fixtures' } }),
    });
    const outcome = runConversationIngestion({
      ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 0 }).port,
    });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'codex_version_unverified:0.167.0-alpha.4.1' });

    const facts = readDegradationFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      category: 'degraded',
      sessionId: 'root-1',
      data: {
        hostKind: 'workbuddy',
        reason: 'codex_version_unverified:0.167.0-alpha.4.1',
        warningCount: 0,
      },
    });
    // The fact must not become a second truth: the real ingest still wrote nothing.
    const listed = listGovernanceObservations({ workspaceDir });
    expect(listed.ok ? listed.observations : listed).toEqual([]);
    expect(readGovernanceCheckpoint({ workspaceDir, hostKind: 'workbuddy', rolloutIdentity: 'sess-1' })).toBeNull();
  });

  it('an ok ingestion writes no degraded fact', () => {
    const harness = makeSource({
      delta: makeDelta({
        observations: [observation({ logicalObservationKey: 'wb|sess-1|t1|user', visibleText: 'hello' })],
        nextByteOffset: 10,
        lastOrdinal: 0,
        fileSize: 10,
      }),
    });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 10 }).port });
    expect(outcome).toMatchObject({ status: 'ok', inserted: 1 });
    expect(readDegradationFacts()).toEqual([]);
  });

  it('bounds the recorded reason by code points, never splitting a surrogate pair', () => {
    const harness = makeSource({
      delta: makeDelta({ guard: { reason: '😀'.repeat(500), nextAction: 'probe' } }),
    });
    runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 0 }).port });
    const facts = readDegradationFacts();
    expect(facts).toHaveLength(1);
    const reason = String(facts[0].data.reason);
    expect(reason.includes('\uFFFD')).toBe(false);
    expect(Array.from(reason).length).toBeLessThanOrEqual(301);
  });

  it('a failed fact write stays observable instead of throwing', () => {
    // Make `.state/logs` un-writable by occupying it with a regular file.
    fs.writeFileSync(path.join(workspaceDir, '.state', 'logs'), 'not-a-directory');
    const harness = makeSource({ locate: 'degraded' });
    const outcome = runConversationIngestion({ ...BASE_ARGS, workspaceDir, source: harness.source, port: makePort({ bytes: '', fileSize: 0 }).port });
    expect(outcome).toMatchObject({ status: 'degraded', reason: 'locate_refused' });
    expect(outcome.status === 'degraded' ? outcome.warnings.some((w) => w.startsWith('degradation_event_log_failed:')) : false).toBe(true);
  });
});
