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
  CODEX_HOST_LIVENESS_CONTRACT,
  OPENCLAW_HOST_LIVENESS_CONTRACT,
  WORKBUDDY_HOST_LIVENESS_CONTRACT,
  readWorkspaceHostKindFacts,
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

const WORKBUDDY = {
  version: 1 as const,
  hostKind: 'workbuddy',
  mappings: [{ rawToolName: 'Bash', canonicalKind: 'execute' as const }],
  declaredAt: '2026-10-28T00:00:00.000Z',
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

  it('SPEC H01/B: a Codex-declared workspace resolves the Codex capability contract (was promotion_host_unsupported before the evidence-backed Codex contract existed)', () => {
    expect(saveHostToolDeclaration(ws, CODEX).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toEqual({
      ok: true,
      hostKind: 'codex',
      hostKinds: ['codex'],
      hostContract: CODEX_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: 'codex-v2@1',
    });
    // The Codex contract's protected tool aliases are the REAL Codex tool
    // surface (B1) — capitalized Bash, not the OpenClaw lowercase vocabulary.
    expect(CODEX_HOST_LIVENESS_CONTRACT.protectedCapabilities.every(
      capability => capability.hostToolAliases.every(alias => alias !== 'bash'),
    )).toBe(true);
  });

  it('SPEC H01/C: a WorkBuddy-declared workspace resolves the WorkBuddy capability contract — never the OpenClaw one (H02)', () => {
    expect(saveHostToolDeclaration(ws, WORKBUDDY).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toEqual({
      ok: true,
      hostKind: 'workbuddy',
      hostKinds: ['workbuddy'],
      hostContract: WORKBUDDY_HOST_LIVENESS_CONTRACT,
      hostRuntimeVersion: 'workbuddy-v1@1',
    });
    expect(resolved.ok && resolved.hostContract).not.toBe(OPENCLAW_HOST_LIVENESS_CONTRACT);
  });

  it('SPEC H01: an unknown declared host kind fails closed as promotion_host_unsupported', () => {
    expect(saveHostToolDeclaration(ws, {
      version: 1 as const,
      hostKind: 'trae',
      mappings: [{ rawToolName: 'shell', canonicalKind: 'execute' as const }],
      declaredAt: '2026-10-28T00:00:00.000Z',
    }).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'promotion_host_unsupported',
      hostKinds: ['trae'],
      hostContract: null,
      hostRuntimeVersion: null,
    });
  });

  it('SPEC H01: codex and workbuddy declarations together stay multi-host ambiguous', () => {
    expect(saveHostToolDeclaration(ws, CODEX).ok).toBe(true);
    expect(saveHostToolDeclaration(ws, WORKBUDDY).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'multi_host_promotion_ambiguous',
      hostKinds: ['codex', 'workbuddy'],
      hostContract: null,
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

  it('SPEC H02: workbuddy pain evidence without a declaration fails closed — the historical OpenClaw default must NOT extend to a workspace where WorkBuddy appeared', () => {
    seedProvenance(['workbuddy']);
    const facts = readWorkspaceHostKindFacts(ws);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.evidenceKinds).toEqual(['workbuddy']);
    expect(facts.effectiveKinds).toEqual(['workbuddy']);
    // SPEC §4.3: durable non-OpenClaw evidence whose declaration is missing
    // is a structured refusal — never a silent OpenClaw fallback. (The
    // pre-SPEC resolver returned the OpenClaw contract here; that behavior
    // is intentionally changed by SPEC-RULECODE-HOST-PROMOTION-001 A.)
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'host_declaration_missing_for_configured_host',
      hostKinds: ['workbuddy'],
      hostContract: null,
      hostRuntimeVersion: null,
    });
  });

  it('SPEC H02: an openclaw.json surviving alongside workbuddy evidence still fails closed (WorkBuddy partial-declaration variant)', () => {
    seedProvenance(['workbuddy']);
    expect(saveHostToolDeclaration(ws, OPENCLAW).ok).toBe(true);
    const resolved = resolvePromotionHostLiveness(ws);
    expect(resolved).toMatchObject({
      ok: false,
      reason: 'host_declaration_missing_for_configured_host',
      hostKinds: ['openclaw', 'workbuddy'],
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
