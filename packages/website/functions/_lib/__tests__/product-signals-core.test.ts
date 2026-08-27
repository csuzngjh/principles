/**
 * Protected maintainer product-signals view tests (PRI-601; review
 * remediation: workspace measurement wording + tri-state denominators).
 *
 * Access protection, aggregate correctness, honest metric wording, and the
 * no-IDs-rendered property. The D1 shim reuses the real SQLite schema from
 * migrations/0001 + 0002 (same approach as telemetry-core.test.ts).
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleProductSignals, type SignalsD1, type SignalsEnv } from '../product-signals-core.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

function applyMigrations(db: Database.Database): void {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const ddl = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const stripped = ddl
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    for (const statement of stripped.split(';')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        db.prepare(trimmed).run();
      }
    }
  }
}

const SEED_ROW_SQL =
  'INSERT INTO product_telemetry_daily (server_daily_id, bucket_date, schema_version, pd_version, host_kind, initialized, pain_observed, principle_observed, activation_observed, presence_receipt_observed, effect_receipt_observed, initialization_failed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

interface SeededDb {
  db: Database.Database;
  d1: SignalsD1;
  seed(args: {
    serverDailyId: string;
    bucketDate: string;
    pdVersion: string;
    hostKind: string;
    /** 1 = observed true, 0 = evaluated false, null = unavailable. */
    initialized: number | null;
    pain: number | null;
    principle: number | null;
    activation: number | null;
    presence: number | null;
    effect: number | null;
    initFailed: number | null;
  }): void;
}

function makeDb(): SeededDb {
  const db = new Database(':memory:');
  applyMigrations(db);
  const d1: SignalsD1 = {
    prepare: (query: string) => {
      const statement = db.prepare(query);
      return {
        bind: (...values: unknown[]) => ({
          first: async <T = Record<string, unknown>>(): Promise<T | null> => (statement.get(...values) as T | null) ?? null,
          all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => ({ results: statement.all(...values) as T[] }),
        }),
      };
    },
  };
  return {
    db,
    d1,
    seed(args) {
      db.prepare(SEED_ROW_SQL).run(
        args.serverDailyId,
        args.bucketDate,
        '1',
        args.pdVersion,
        args.hostKind,
        args.initialized,
        args.pain,
        args.principle,
        args.activation,
        args.presence,
        args.effect,
        args.initFailed,
        `${args.bucketDate}T00:00:00.000Z`,
        `${args.bucketDate}T00:00:00.000Z`,
      );
    },
  };
}

// 48 hex chars = 24 bytes — matches the enforced token floor exactly.
const TOKEN = 'cd'.repeat(24);
const NOW = Date.parse('2026-08-26T10:00:00.000Z');

let seeded: SeededDb;

beforeEach(() => {
  seeded = makeDb();
  // Today: 3 participating workspaces.
  seeded.seed({ serverDailyId: 'a'.repeat(64), bucketDate: '2026-08-26', pdVersion: '1.218.0', hostKind: 'openclaw', initialized: 1, pain: 1, principle: 1, activation: 1, presence: 1, effect: 1, initFailed: 0 });
  seeded.seed({ serverDailyId: 'b'.repeat(64), bucketDate: '2026-08-26', pdVersion: '1.217.0', hostKind: 'codex', initialized: 1, pain: 1, principle: 0, activation: 0, presence: 0, effect: 0, initFailed: 0 });
  seeded.seed({ serverDailyId: 'c'.repeat(64), bucketDate: '2026-08-26', pdVersion: '1.218.0', hostKind: 'openclaw', initialized: 0, pain: 0, principle: 0, activation: 0, presence: 0, effect: 0, initFailed: 1 });
  // Yesterday: 2 more daily observations (cannot be deduped across days — by design).
  seeded.seed({ serverDailyId: 'd'.repeat(64), bucketDate: '2026-08-25', pdVersion: '1.218.0', hostKind: 'openclaw', initialized: 1, pain: 0, principle: 0, activation: 0, presence: 0, effect: 0, initFailed: 0 });
  seeded.seed({ serverDailyId: 'e'.repeat(64), bucketDate: '2026-08-25', pdVersion: '1.216.0', hostKind: 'other', initialized: 1, pain: 0, principle: 0, activation: 0, presence: 0, effect: 0, initFailed: 0 });
});

function makeEnv(): SignalsEnv {
  return { PD_PRODUCT_TELEMETRY: seeded.d1, PRODUCT_SIGNALS_TOKEN: TOKEN };
}

describe('access protection (SPEC §47)', () => {
  it('rejects requests without a token with 401', async () => {
    const result = await handleProductSignals({ env: makeEnv(), now: () => NOW });
    expect(result.status).toBe(401);
    expect(result.contentType).toBe('application/json');
  });

  it('rejects wrong tokens with 401', async () => {
    const result = await handleProductSignals({ env: makeEnv(), authorization: 'Bearer wrong-token-value-0123', now: () => NOW });
    expect(result.status).toBe(401);
  });

  it('fails closed when the token is not configured, too short, or non-hex', async () => {
    for (const bad of [undefined, 'short', 'z'.repeat(48), 'cd'.repeat(23) /* 46 hex chars = 23 bytes */]) {
      const env = { PD_PRODUCT_TELEMETRY: seeded.d1, ...(bad !== undefined ? { PRODUCT_SIGNALS_TOKEN: bad } : {}) };
      const result = await handleProductSignals({ env, authorization: `Bearer ${TOKEN}`, now: () => NOW });
      expect(result.status, `token=${String(bad)}`).toBe(500);
      expect(result.body, `token=${String(bad)}`).toContain('view_misconfigured');
    }
  });
});

describe('signal rendering (honest metric wording, SPEC §57-§62)', () => {
  it('shows today counts, 7-day observations, version distribution, milestones, reliability', async () => {
    const result = await handleProductSignals({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html; charset=utf-8');
    const html = result.body;
    expect(html).toContain('Daily participating workspaces</td><td>3');
    expect(html).toContain('7-day participating daily-workspace observations</td><td>5');
    expect(html).toContain('<td>1.218.0</td><td>2</td>');
    expect(html).toContain('<td>1.217.0</td><td>1</td>');
    // Tri-state columns: Observed / Evaluable / Unavailable per milestone.
    expect(html).toContain('Initialized</td><td>2</td><td>3</td><td>0</td>');
    expect(html).toContain('Pain observed</td><td>2</td><td>3</td><td>0</td>');
    expect(html).toContain('Effect receipt observed</td><td>1</td><td>3</td><td>0</td>');
    expect(html).toContain('Initialization failure</td><td>1</td><td>3</td><td>0</td>');
  });

  it('excludes NULL facts from denominators — Observed/Evaluable/Unavailable, never 2/11', async () => {
    // Two more workspaces today with unavailable (NULL) effect receipts.
    seeded.seed({ serverDailyId: 'f'.repeat(64), bucketDate: '2026-08-26', pdVersion: '1.218.0', hostKind: 'openclaw', initialized: 1, pain: 1, principle: 1, activation: 1, presence: 1, effect: null, initFailed: null });
    seeded.seed({ serverDailyId: 'g'.repeat(64), bucketDate: '2026-08-26', pdVersion: '1.218.0', hostKind: 'openclaw', initialized: 1, pain: 0, principle: 0, activation: 0, presence: null, effect: null, initFailed: null });
    const result = await handleProductSignals({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(result.status).toBe(200);
    const html = result.body;
    // 5 workspaces today, but only 3 evaluable for effect receipts:
    // observed=1, evaluable=3, unavailable=2 — NOT 1/5 and NOT summed to 0.
    expect(html).toContain('Effect receipt observed</td><td>1</td><td>3</td><td>2</td>');
    expect(html).toContain('Presence receipt observed</td><td>2</td><td>4</td><td>1</td>');
    expect(html).toContain('Daily participating workspaces</td><td>5');
    expect(html).toContain('excluded from the denominator');
  });

  it('permanently displays the opt-in bias warning (SPEC §62) and effect≠improvement note', async () => {
    const result = await handleProductSignals({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(result.body).toContain('must not be interpreted as the complete PD population');
    expect(result.body).toContain('not evidence of durable Agent improvement');
    expect(result.body).toContain('Cross-day deduplication is intentionally impossible');
    expect(result.body).toContain('accepted anonymous submissions');
  });

  it('never uses "user"/"installation" wording or renders any server_daily_id / workspace rows', async () => {
    const result = await handleProductSignals({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    const html = result.body;
    expect(html).not.toMatch(/\busers\b/i);
    expect(html).not.toMatch(/\binstallations\b/i);
    expect(html).not.toContain('DAU');
    expect(html).not.toContain('retention rate');
    for (const id of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]) {
      expect(html).not.toContain(id);
    }
  });
});
