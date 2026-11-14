/**
 * Durable degraded-enforcement marker (security audit run-1,
 * gate-failopen-allow-on-state-corruption).
 *
 * Pins: (1) a marker file lands under `<home>/.pd/enforcement-health/` keyed
 * by the resolved workspace dir; (2) repeated records accumulate occurrences
 * and keep firstSeenAt; (3) every failure path is swallowed — the helper must
 * never throw into the gating code that calls it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: vi.fn() };
});

import { markerPathFor, readDegradedEnforcement, recordDegradedEnforcement } from '../src/degraded-enforcement-marker.js';

describe('recordDegradedEnforcement (durable out-of-workspace marker)', () => {
  let testHome = '';

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-marker-test-'));
    vi.mocked(os.homedir).mockReturnValue(testHome);
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it('writes a 0600 marker under <home>/.pd/enforcement-health keyed by workspace dir', () => {
    const workspaceDir = path.join(testHome, 'ws-a');
    recordDegradedEnforcement(workspaceDir, 'activation_db_not_found');

    const markerPath = markerPathFor(workspaceDir);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(markerPath).toContain(path.join('.pd', 'enforcement-health'));

    const record = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(record.workspaceDir).toBe(path.resolve(workspaceDir));
    expect(record.reason).toBe('activation_db_not_found');
    expect(record.occurrences).toBe(1);
    expect(typeof record.firstSeenAt).toBe('string');
  });

  it('accumulates occurrences and keeps firstSeenAt on repeat records', () => {
    const workspaceDir = path.join(testHome, 'ws-b');
    recordDegradedEnforcement(workspaceDir, 'activation_db_not_found', new Date('2026-09-23T00:00:00Z'));
    recordDegradedEnforcement(workspaceDir, 'activation_read_failed: corrupt', new Date('2026-09-23T01:00:00Z'));

    const record = JSON.parse(fs.readFileSync(markerPathFor(workspaceDir), 'utf8'));
    expect(record.occurrences).toBe(2);
    expect(record.firstSeenAt).toBe('2026-09-23T00:00:00.000Z');
    expect(record.lastSeenAt).toBe('2026-09-23T01:00:00.000Z');
    expect(record.reason).toBe('activation_read_failed: corrupt');
  });

  it('uses different marker files for different workspaces', () => {
    recordDegradedEnforcement(path.join(testHome, 'ws-1'), 'activation_db_not_found');
    recordDegradedEnforcement(path.join(testHome, 'ws-2'), 'activation_db_not_found');
    expect(markerPathFor(path.join(testHome, 'ws-1'))).not.toBe(markerPathFor(path.join(testHome, 'ws-2')));
    expect(JSON.parse(fs.readFileSync(markerPathFor(path.join(testHome, 'ws-1')), 'utf8')).occurrences).toBe(1);
  });

  it('never throws when the marker cannot be written (observability contract)', () => {
    // Point home at a regular FILE: mkdirSync under it must fail.
    const fileAsHome = path.join(testHome, 'not-a-dir');
    fs.writeFileSync(fileAsHome, 'x', 'utf8');
    vi.mocked(os.homedir).mockReturnValue(fileAsHome);

    expect(() => recordDegradedEnforcement(path.join(testHome, 'ws-c'), 'activation_db_not_found')).not.toThrow();
  });
});

/**
 * PRI-1210: the reader is the Owner-visible half of the marker. Three states
 * must stay distinguishable — a marker that cannot be read is `unknown`, never
 * healthy and never a zero count (the whole point of the durable marker).
 */
describe('readDegradedEnforcement (three-state read)', () => {
  let testHome = '';

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-marker-read-'));
    vi.mocked(os.homedir).mockReturnValue(testHome);
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it('reports healthy when no marker file exists', () => {
    const workspaceDir = path.join(testHome, 'ws-none');
    const reading = readDegradedEnforcement(workspaceDir);
    expect(reading.state).toBe('healthy');
    expect(reading.markerPath).toBe(markerPathFor(workspaceDir));
    expect(reading.reason).toBeUndefined();
    expect(reading.occurrences).toBeUndefined();
  });

  it('reports degraded with the recorded reason and timing', () => {
    const workspaceDir = path.join(testHome, 'ws-degraded');
    recordDegradedEnforcement(workspaceDir, 'activation_db_not_found', new Date('2026-09-23T00:00:00Z'));
    recordDegradedEnforcement(workspaceDir, 'activation_db_not_found', new Date('2026-09-23T02:00:00Z'));

    const reading = readDegradedEnforcement(workspaceDir);
    expect(reading.state).toBe('degraded');
    expect(reading.reason).toBe('activation_db_not_found');
    expect(reading.firstSeenAt).toBe('2026-09-23T00:00:00.000Z');
    expect(reading.lastSeenAt).toBe('2026-09-23T02:00:00.000Z');
    expect(reading.occurrences).toBe(2);
    expect(typeof reading.nextAction).toBe('string');
  });

  it('reports unknown (never healthy) for malformed JSON', () => {
    const workspaceDir = path.join(testHome, 'ws-malformed');
    const markerPath = markerPathFor(workspaceDir);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, '{not json', 'utf8');

    const reading = readDegradedEnforcement(workspaceDir);
    expect(reading.state).toBe('unknown');
    expect(reading.unreadableReason).toBe('marker_malformed_json');
    expect(reading.occurrences).toBeUndefined();
    expect(typeof reading.nextAction).toBe('string');
  });

  it('reports unknown for a shape-invalid record instead of repairing it', () => {
    const workspaceDir = path.join(testHome, 'ws-shape');
    const markerPath = markerPathFor(workspaceDir);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ workspaceDir, reason: 'x', occurrences: 0 }), 'utf8');

    const reading = readDegradedEnforcement(workspaceDir);
    expect(reading.state).toBe('unknown');
    expect(reading.unreadableReason).toBe('marker_shape_invalid');
  });

  it('reports unknown for a marker naming a different workspace', () => {
    const workspaceDir = path.join(testHome, 'ws-mine');
    const markerPath = markerPathFor(workspaceDir);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      workspaceDir: path.join(testHome, 'ws-other'),
      reason: 'activation_db_not_found',
      firstSeenAt: '2026-09-23T00:00:00.000Z',
      lastSeenAt: '2026-09-23T00:00:00.000Z',
      occurrences: 1,
    }), 'utf8');

    const reading = readDegradedEnforcement(workspaceDir);
    expect(reading.state).toBe('unknown');
    expect(reading.unreadableReason).toBe('marker_workspace_mismatch');
  });

  it('reports unknown (never healthy) when the marker path cannot be read', () => {
    const workspaceDir = path.join(testHome, 'ws-unreadable');
    const markerPath = markerPathFor(workspaceDir);
    // A DIRECTORY at the marker path makes readFileSync fail with EISDIR —
    // the portable way to exercise the unreadable branch on Windows too.
    fs.mkdirSync(markerPath, { recursive: true });

    const reading = readDegradedEnforcement(workspaceDir);
    expect(reading.state).toBe('unknown');
    expect(reading.unreadableReason).toContain('marker_unreadable');
  });
});
