/**
 * Anonymous Product Telemetry v1 collector tests (PRI-600).
 *
 * The D1 shim is a REAL better-sqlite3 in-memory database (schema from
 * migrations/0001) so upsert/dedup/retention SQL semantics are exercised
 * for real, not simulated. Drift-lock vectors come from @principles/core's
 * own builder — a snapshot the official client builder produces must pass
 * collector validation, so the two validators cannot silently diverge.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleTelemetrySnapshot, bucketDateOf, type TelemetryD1, type TelemetryEnv } from '../telemetry-core.js';
import {
  buildProductTelemetrySnapshot,
  deriveDailyTelemetryId,
  generateTelemetrySecretHex,
  PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS,
  type ProductTelemetrySnapshotV1,
} from '@principles/core/runtime-v2';

// ── D1 shim over real SQLite ─────────────────────────────────────────────────

const MIGRATION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations', '0001_product_telemetry_daily.sql');

/** Apply the migration DDL statement-by-statement via prepared statements. */
function applyMigration(db: Database.Database): void {
  const ddl = fs.readFileSync(MIGRATION_PATH, 'utf8');
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

const SEED_ROW_SQL =
  'INSERT INTO product_telemetry_daily (server_daily_id, bucket_date, schema_version, pd_version, host_kind, initialized, pain_observed, principle_observed, activation_observed, presence_receipt_observed, effect_receipt_observed, initialization_failed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

class SqliteD1Shim {
  readonly db: Database.Database;
  constructor() {
    this.db = new Database(':memory:');
    applyMigration(this.db);
  }

  prepare(query: string) {
    const statement = this.db.prepare(query);
    return {
      bind: (...values: unknown[]) => ({
        run: async () => ({ meta: { changes: statement.run(...values).changes } }),
      }),
    };
  }

  /** Test-only raw access for seeding/inspecting rows (parameter-bound). */
  rows(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM product_telemetry_daily').all() as Array<Record<string, unknown>>;
  }

  seedRow(
    serverDailyId: string,
    bucketDate: string,
    hostKind: string,
    flag: number,
    createdAt: string,
  ): void {
    this.db
      .prepare(SEED_ROW_SQL)
      .run(serverDailyId, bucketDate, '1', '1.0.0', hostKind, flag, flag, flag, flag, flag, flag, 0, createdAt, createdAt);
  }

  close(): void {
    this.db.close();
  }
}

class MemKV {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HMAC_SECRET = 'unit-test-server-secret-0123456789abcdef';
const NOW = Date.parse('2026-08-26T10:00:00.000Z');

function buildSnapshot(overrides: { dailyTelemetryId?: string; bucketDate?: string } = {}): ProductTelemetrySnapshotV1 {
  return buildProductTelemetrySnapshot({
    dailyTelemetryId: overrides.dailyTelemetryId ?? deriveDailyTelemetryId(generateTelemetrySecretHex(), '2026-08-26'),
    bucketDate: overrides.bucketDate ?? '2026-08-26',
    pdVersion: '1.218.0',
    hostKind: 'openclaw',
    milestones: {
      initialized: true,
      painObserved: true,
      principleObserved: true,
      activationObserved: false,
      presenceReceiptObserved: true,
      effectReceiptObserved: false,
    },
    reliability: { initializationFailed: false },
  });
}

function makeEnv(db: SqliteD1Shim, kv: MemKV): TelemetryEnv {
  return {
    PD_PRODUCT_TELEMETRY: db as unknown as TelemetryD1,
    FEEDBACK_KV: kv,
    TELEMETRY_HMAC_SECRET: HMAC_SECRET,
  };
}

let db: SqliteD1Shim;
let kv: MemKV;

beforeEach(() => {
  db = new SqliteD1Shim();
  kv = new MemKV();
});

describe('schema drift-lock with the official client contract', () => {
  it('collector accept-list matches core PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS', async () => {
    // A snapshot built by the OFFICIAL core builder must be accepted. If
    // either side drifts (new field, renamed field), this fails.
    const snapshot = buildSnapshot();
    const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    expect(result.status).toBe(204);
    expect(PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS).toHaveLength(8);
  });

  it('collector rejects every field set core rejects (shared tamper vectors)', async () => {
    for (const tampered of [
      { ...buildSnapshot(), extra: 'x' },
      { ...buildSnapshot(), schemaVersion: '2' },
      { ...buildSnapshot(), hostKind: 'windows' },
      { ...buildSnapshot(), dailyTelemetryId: 'XYZ' },
    ]) {
      const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(tampered), now: () => NOW });
      expect(result.status, JSON.stringify(tampered)).toBe(400);
    }
    const nestedTampered = {
      ...buildSnapshot(),
      milestones: { ...buildSnapshot().milestones, painText: 'secret' },
    };
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(nestedTampered), now: () => NOW })).status).toBe(400);
  });
});

describe('snapshot persistence', () => {
  it('stores a server-HMACed daily ID — never the client ID — and no metadata', async () => {
    const snapshot = buildSnapshot();
    await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    const rows = db.rows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, string>;
    expect(row.server_daily_id).not.toBe(snapshot.dailyTelemetryId);
    expect(row.server_daily_id).toMatch(/^[0-9a-f]{64}$/);
    expect(row.bucket_date).toBe('2026-08-26');
    expect(row.pd_version).toBe('1.218.0');
    expect(row.host_kind).toBe('openclaw');
    expect(row.initialized).toBe(1);
    expect(row.effect_receipt_observed).toBe(0);
    // Column set is exactly the allowlisted schema — no IP/UA/content columns.
    expect(Object.keys(row).sort()).toEqual([
      'activation_observed',
      'bucket_date',
      'created_at',
      'effect_receipt_observed',
      'host_kind',
      'initialization_failed',
      'initialized',
      'pain_observed',
      'pd_version',
      'presence_receipt_observed',
      'principle_observed',
      'schema_version',
      'server_daily_id',
      'updated_at',
    ]);
  });

  it('same telemetry unit + same day = one row (upsert dedup, SPEC §38)', async () => {
    const snapshot = buildSnapshot();
    const first = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    const second = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(db.rows()).toHaveLength(1);
  });

  it('different daily IDs (different days) are independent rows', async () => {
    const day1 = buildSnapshot({ bucketDate: '2026-08-25' });
    const day2 = buildSnapshot({ bucketDate: '2026-08-26' });
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(day1), now: () => NOW })).status).toBe(204);
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(day2), now: () => NOW })).status).toBe(204);
    expect(db.rows()).toHaveLength(2);
  });
});

describe('request hardening', () => {
  it('rejects oversized bodies with 413 before validation', async () => {
    const snapshot = buildSnapshot();
    const padded = JSON.stringify({ ...snapshot, pad: 'x'.repeat(5 * 1024) });
    const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: padded, now: () => NOW });
    expect(result.status).toBe(413);
  });

  it('rejects bucket dates too far from today (back/fill flooding)', async () => {
    const future = buildSnapshot({ bucketDate: bucketDateOf(NOW + 2 * 24 * 60 * 60 * 1000) });
    const stale = buildSnapshot({ bucketDate: '2026-08-20' });
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(future), now: () => NOW })).status).toBe(400);
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(stale), now: () => NOW })).status).toBe(400);
    // Today and yesterday are accepted (clock skew tolerance).
    const yesterday = buildSnapshot({ bucketDate: '2026-08-25' });
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(yesterday), now: () => NOW })).status).toBe(204);
  });

  it('rate limits per daily ID after 60 requests/hour with Retry-After', async () => {
    const snapshot = buildSnapshot();
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
      lastStatus = result.status;
    }
    expect(lastStatus).toBe(429);
    const rateLimited = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    expect(rateLimited.status).toBe(429);
    expect((rateLimited.headers ?? {})['Retry-After']).toBe('3600');
    // A different daily ID is not affected by another ID's counter.
    const other = buildSnapshot({ dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), '2026-08-26') });
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(other), now: () => NOW })).status).toBe(204);
  });

  it('fails closed when the server HMAC secret is missing or too short', async () => {
    const envNoSecret = { ...makeEnv(db, kv), TELEMETRY_HMAC_SECRET: undefined };
    const result = await handleTelemetrySnapshot({ env: envNoSecret, body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.json)).toContain('collector_misconfigured');
  });

  it('maps D1 failure to a bounded 500 with a coarse reason (no body echo)', async () => {
    const brokenDb: TelemetryD1 = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('D1_ERROR: network failed');
          },
        }),
      }),
    };
    const env = { ...makeEnv(db, kv), PD_PRODUCT_TELEMETRY: brokenDb };
    const result = await handleTelemetrySnapshot({ env, body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.json)).toContain('storage_unavailable');
  });
});

describe('retention (SPEC §54, 90 days)', () => {
  it('sweeps rows older than 90 days on each accepted write', async () => {
    db.seedRow('old-id-1', '2026-05-01', 'openclaw', 1, '2026-05-01T00:00:00.000Z'); // > 90 days before 2026-08-26
    db.seedRow('recent-id-1', '2026-08-20', 'codex', 1, '2026-08-20T00:00:00.000Z'); // within 90 days
    const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(204);
    const remaining = db.rows().map((r) => (r as Record<string, string>).bucket_date).sort();
    expect(remaining).toEqual(['2026-08-20', '2026-08-26']);
  });
});
