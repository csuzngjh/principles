/**
 * PRI-813 — promotion host-liveness resolution.
 *
 * Before PRI-813 the promotion call sites passed OPENCLAW_HOST_LIVENESS_CONTRACT
 * unconditionally, so a Codex workspace reported runtime_compatibility /
 * runtime_shadow_evidence as PASSED — a false capability claim that hid the
 * "promotion on this host is unsupported" truth behind a sample-count failure.
 * The resolver routes the ONE existing contract authority by the workspace's
 * real host declarations and fails closed everywhere else.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { saveHostToolDeclaration } from '../src/host-tool-declaration.js';
import {
  OPENCLAW_HOST_LIVENESS_CONTRACT,
  resolvePromotionHostLiveness,
} from '../src/host-liveness-contract.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-liveness-813-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const OPENCLAW = {
  version: 1 as const,
  hostKind: 'openclaw',
  mappings: [{ rawToolName: 'shell', canonicalKind: 'execute' as const }],
  declaredAt: '2026-09-16T00:00:00.000Z',
};

const CODEX = {
  version: 1 as const,
  hostKind: 'codex',
  mappings: [{ rawToolName: 'Bash', canonicalKind: 'execute' as const }],
  declaredAt: '2026-09-16T00:00:00.000Z',
};

/** Seed durable host-behavior provenance: pain_events.host_kind rows (trajectory.db). */
function seedProvenance(kinds: readonly string[]): void {
  mkdirSync(path.join(ws, '.state'), { recursive: true });
  const db = new Database(path.join(ws, '.state', 'trajectory.db'));
  db.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, host_kind TEXT)');
  const insert = db.prepare('INSERT INTO pain_events (host_kind) VALUES (?)');
  for (const kind of kinds) insert.run(kind);
  db.close();
}

describe('resolvePromotionHostLiveness (PRI-813 fail-closed capability routing)', () => {
  it('keeps the historical OpenClaw contract when no host has declared anything yet — distinguishable via empty hostKinds (review S3)', () => {
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toEqual({
      ok: true,
      hostKind: 'openclaw',
      hostKinds: [],
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: 'openclaw-legacy@1',
    });
  });

  it('resolves the OpenClaw contract for an OpenClaw-declared workspace', () => {
    expect(saveHostToolDeclaration(ws, OPENCLAW).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved.ok).toBe(true);
    expect(resolved).toEqual({
      ok: true,
      hostKind: 'openclaw',
      hostKinds: ['openclaw'],
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: 'openclaw-legacy@1',
    });
  });

  it('fails closed for a Codex-only workspace — no contract inheritance, no false PASS (Test F)', () => {
    expect(saveHostToolDeclaration(ws, CODEX).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'promotion_host_unsupported',
      hostKinds: ['codex'],
      hostContract: null,
      hostRuntimeVersion: null,
    });
  });

  it('fails closed with an ambiguity reason when multiple hosts are declared — never defaults to OpenClaw (Test H)', () => {
    expect(saveHostToolDeclaration(ws, OPENCLAW).ok).toBe(true);
    expect(saveHostToolDeclaration(ws, CODEX).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'multi_host_promotion_ambiguous',
      hostKinds: ['codex', 'openclaw'],
      hostContract: null,
    });
  });

  it('fails closed observably when the host declarations cannot be read', () => {
    const declarationsDir = path.join(ws, '.pd', 'host-tool-semantics');
    mkdirSync(declarationsDir, { recursive: true });
    writeFileSync(path.join(declarationsDir, 'codex.json'), '{ not json', 'utf8');
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'host_declarations_unreadable',
      hostContract: null,
    });
  });

  it('round-4 (Owner): a Codex workspace whose codex.json was DELETED fails closed — trajectory evidence forbids the OpenClaw fallback', () => {
    // The exact reviewed attack sequence: Codex ran here (durable pain_events
    // host_kind='codex' rows), then the declaration is lost. The resolver
    // must NOT treat "missing" as legacy-OpenClaw.
    seedProvenance(['codex']);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'host_declaration_missing_for_configured_host',
      hostKinds: ['codex'],
      hostContract: null,
      hostRuntimeVersion: null,
    });
  });

  it('round-4 (Owner): an openclaw.json that survives while codex evidence exists still fails closed (partial-declaration variant)', () => {
    seedProvenance(['codex']);
    expect(saveHostToolDeclaration(ws, OPENCLAW).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'host_declaration_missing_for_configured_host',
      hostKinds: ['codex', 'openclaw'],
      hostContract: null,
    });
  });

  it('round-4: openclaw-only behavioral evidence keeps the legacy OpenClaw default (no over-correction)', () => {
    seedProvenance(['openclaw']);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toEqual({
      ok: true,
      hostKind: 'openclaw',
      hostKinds: [],
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: 'openclaw-legacy@1',
    });
  });

  it('round-4: an unreadable trajectory database fails closed instead of guessing', () => {
    mkdirSync(path.join(ws, '.state'), { recursive: true });
    writeFileSync(path.join(ws, '.state', 'trajectory.db'), 'this is not sqlite', 'utf8');
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'workspace_provenance_unreadable',
      hostContract: null,
    });
  });

  it('round-4: a pain_events table predating the host_kind column carries no evidence BY CONSTRUCTION — legacy default stands (e2e seed shape)', () => {
    // The pd-console e2e seed hand-creates pain_events WITHOUT host_kind:
    // rows written before the column existed could never record Codex
    // evidence, so this is empty evidence, not unreadable provenance.
    mkdirSync(path.join(ws, '.state'), { recursive: true });
    const db = new Database(path.join(ws, '.state', 'trajectory.db'));
    db.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)');
    db.prepare("INSERT INTO pain_events (session_id, source, score, created_at) VALUES ('s', 'manual', 0.8, '2026-09-01')").run();
    db.close();
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toEqual({
      ok: true,
      hostKind: 'openclaw',
      hostKinds: [],
      hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: 'openclaw-legacy@1',
    });
  });
});
