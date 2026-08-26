/**
 * Anonymous Product Telemetry v1 collector tests (PRI-600; review
 * remediation: tri-state facts, keyed-IP abuse limiter, shared retention).
 *
 * The D1 shim is a REAL better-sqlite3 in-memory database (schema from
 * migrations/0001 + 0002 — the nullable-facts rebuild) so upsert/dedup/
 * retention SQL semantics are exercised for real, not simulated.
 * Drift-lock vectors come from @principles/core's own builder — a snapshot
 * the official client builder produces must pass collector validation, so
 * the two validators cannot silently diverge.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleTelemetrySnapshot, bucketDateOf, retentionCutoffDate, type TelemetryD1, type TelemetryEnv } from '../telemetry-core.js';
import {
  buildProductTelemetrySnapshot,
  deriveDailyTelemetryId,
  deriveWorkspaceScopeId,
  generateTelemetrySecretHex,
  PRODUCT_TELEMETRY_TOP_LEVEL_FIELDS,
  type ProductTelemetrySnapshotV1,
  type ProductTelemetryMilestoneInput,
} from '@principles/core/runtime-v2';

// ── D1 shim over real SQLite (all migrations applied in order) ───────────────

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

/** Apply every migration DDL statement-by-statement via prepared statements. */
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

class SqliteD1Shim {
  readonly db: Database.Database;
  constructor() {
    this.db = new Database(':memory:');
    applyMigrations(this.db);
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
  readonly map = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.map.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// 64 hex chars = 32 bytes — matches the enforced HMAC secret floor exactly.
const HMAC_SECRET = 'ab'.repeat(32);
const ABUSE_SECRET = '12'.repeat(32);
const NOW = Date.parse('2026-08-26T10:00:00.000Z');

const DEFAULT_MILESTONES: ProductTelemetryMilestoneInput = {
  initialized: true,
  painObserved: true,
  principleObserved: true,
  activationObserved: false,
  presenceReceiptObserved: true,
  effectReceiptObserved: false,
};

function buildSnapshot(
  overrides: { dailyTelemetryId?: string; bucketDate?: string; milestones?: ProductTelemetryMilestoneInput; initializationFailed?: boolean | null } = {},
): ProductTelemetrySnapshotV1 {
  return buildProductTelemetrySnapshot({
    dailyTelemetryId: overrides.dailyTelemetryId ?? deriveDailyTelemetryId(generateTelemetrySecretHex(), deriveWorkspaceScopeId(generateTelemetrySecretHex(), '/ws'), '2026-08-26'),
    bucketDate: overrides.bucketDate ?? '2026-08-26',
    pdVersion: '1.218.0',
    hostKind: 'openclaw',
    milestones: overrides.milestones ?? DEFAULT_MILESTONES,
    // `?? false` would collapse null → false; the override itself decides.
    reliability: { initializationFailed: overrides.initializationFailed !== undefined ? overrides.initializationFailed : false },
  });
}

function makeEnv(db: SqliteD1Shim, kv: MemKV): TelemetryEnv {
  return {
    PD_PRODUCT_TELEMETRY: db as unknown as TelemetryD1,
    FEEDBACK_KV: kv,
    TELEMETRY_HMAC_SECRET: HMAC_SECRET,
    TELEMETRY_ABUSE_HMAC_SECRET: ABUSE_SECRET,
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
    // A string "null" (or any other pseudo-unknown value) is still invalid.
    const stringNull = { ...buildSnapshot(), reliability: { initializationFailed: 'null' } };
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(stringNull), now: () => NOW })).status).toBe(400);
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

  it('stores null facts as SQL NULL — unavailable is never observed-false (review remediation)', async () => {
    const snapshot = buildSnapshot({
      milestones: {
        initialized: true,
        painObserved: null,
        principleObserved: null,
        activationObserved: false,
        presenceReceiptObserved: null,
        effectReceiptObserved: null,
      },
      initializationFailed: null,
    });
    const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    expect(result.status).toBe(204);
    const row = db.rows()[0] as Record<string, unknown>;
    expect(row.pain_observed).toBeNull();
    expect(row.presence_receipt_observed).toBeNull();
    expect(row.effect_receipt_observed).toBeNull();
    expect(row.initialization_failed).toBeNull();
    expect(row.initialized).toBe(1);
    expect(row.activation_observed).toBe(0);
  });

  it('same workspace + same day = one row (upsert dedup, SPEC §38)', async () => {
    const snapshot = buildSnapshot();
    const first = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    const second = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW });
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(db.rows()).toHaveLength(1);
  });

  it('different daily IDs (different days or workspaces) are independent rows', async () => {
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
    const other = buildSnapshot({ dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), deriveWorkspaceScopeId(generateTelemetrySecretHex(), '/ws'), '2026-08-26') });
    expect((await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(other), now: () => NOW })).status).toBe(204);
  });

  it('fails closed when the server HMAC secret is missing, too short, or non-hex', async () => {
    for (const bad of [undefined, 'short', 'z'.repeat(64), 'ab'.repeat(31) /* 62 hex chars = 31 bytes */]) {
      const envBad = { ...makeEnv(db, kv), ...(bad !== undefined ? { TELEMETRY_HMAC_SECRET: bad } : { TELEMETRY_HMAC_SECRET: undefined }) };
      const result = await handleTelemetrySnapshot({ env: envBad, body: JSON.stringify(buildSnapshot()), now: () => NOW });
      expect(result.status, `secret=${String(bad)}`).toBe(500);
      expect(JSON.stringify(result.json), `secret=${String(bad)}`).toContain('collector_misconfigured');
    }
  });

  it('maps D1 persist failure to a bounded 500 with a fixed coarse reason — no backend error text', async () => {
    const brokenDb: TelemetryD1 = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('D1_ERROR: network failed at /internal/path');
          },
        }),
      }),
    };
    const env = { ...makeEnv(db, kv), PD_PRODUCT_TELEMETRY: brokenDb };
    const result = await handleTelemetrySnapshot({ env, body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(500);
    const body = JSON.stringify(result.json);
    expect(body).toContain('storage_unavailable');
    // The public responder must never see backend error text (review round 2).
    expect(body).not.toContain('D1_ERROR');
    expect(body).not.toContain('/internal/path');
  });

  it('still returns 204 when the persist succeeds but the retention sweep fails (sweep is best-effort)', async () => {
    // Real SQLite for the upsert; the DELETE statement throws.
    const sweepBrokenDb: TelemetryD1 = {
      prepare: (query: string) => {
        if (query.startsWith('DELETE')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('D1_ERROR: delete failed');
              },
            }),
          };
        }
        return db.prepare(query);
      },
    };
    const env = { ...makeEnv(db, kv), PD_PRODUCT_TELEMETRY: sweepBrokenDb };
    const result = await handleTelemetrySnapshot({ env, body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(204);
    // The snapshot itself was persisted.
    expect(db.rows()).toHaveLength(1);
  });
});

describe('transport abuse limiter (review remediation P1-3)', () => {
  const SOURCE_IP = '203.0.113.7';

  it('same source IP with ROTATING daily IDs is still rate limited (attack rotation defeated)', async () => {
    let lastStatus = 0;
    // Each request uses a fresh dailyTelemetryId — the layer-1 limiter never
    // fires; only the keyed-IP token bound can stop the flood.
    for (let i = 0; i < 121; i++) {
      const snapshot = buildSnapshot({ dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), deriveWorkspaceScopeId(generateTelemetrySecretHex(), `/ws-${i}`), '2026-08-26') });
      const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW, sourceIp: SOURCE_IP });
      lastStatus = result.status;
    }
    expect(lastStatus).toBe(429);
    const blocked = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW, sourceIp: SOURCE_IP });
    expect(blocked.status).toBe(429);
    expect((blocked.headers ?? {})['Retry-After']).toBe('3600');
  });

  it('a different source IP has an independent allowance', async () => {
    for (let i = 0; i < 121; i++) {
      const snapshot = buildSnapshot({ dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), deriveWorkspaceScopeId(generateTelemetrySecretHex(), `/ws-${i}`), '2026-08-26') });
      await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW, sourceIp: SOURCE_IP });
    }
    const other = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW, sourceIp: '198.51.100.9' });
    expect(other.status).toBe(204);
  });

  it('KV keys never contain the raw IP; tokens are keyed HMACs with ~1h TTL', async () => {
    await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW, sourceIp: SOURCE_IP });
    for (const key of kv.map.keys()) {
      expect(key, key).not.toContain(SOURCE_IP);
      expect(key, key).not.toContain('203.0.113');
    }
    const abuseKeys = [...kv.map.keys()].filter((key) => key.startsWith('tl-ab:'));
    expect(abuseKeys).toHaveLength(1);
    expect(abuseKeys[0]).toMatch(/^tl-ab:[0-9a-f]{64}$/);
    expect(kv.ttls.get(abuseKeys[0] as string)).toBe(3600);
  });

  it('raw IP never reaches the response body', async () => {
    for (let i = 0; i < 121; i++) {
      const snapshot = buildSnapshot({ dailyTelemetryId: deriveDailyTelemetryId(generateTelemetrySecretHex(), deriveWorkspaceScopeId(generateTelemetrySecretHex(), `/ws-${i}`), '2026-08-26') });
      await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(snapshot), now: () => NOW, sourceIp: SOURCE_IP });
    }
    const blocked = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW, sourceIp: SOURCE_IP });
    expect(JSON.stringify(blocked.json)).not.toContain(SOURCE_IP);
    // D1 never sees the IP either.
    for (const row of db.rows()) {
      expect(JSON.stringify(row)).not.toContain(SOURCE_IP);
    }
  });

  it('fails closed when the abuse HMAC secret is missing or weak', async () => {
    for (const bad of [undefined, 'short', 'z'.repeat(64), '12'.repeat(31)]) {
      const envBad = { ...makeEnv(db, kv), ...(bad !== undefined ? { TELEMETRY_ABUSE_HMAC_SECRET: bad } : { TELEMETRY_ABUSE_HMAC_SECRET: undefined }) };
      const result = await handleTelemetrySnapshot({ env: envBad, body: JSON.stringify(buildSnapshot()), now: () => NOW, sourceIp: SOURCE_IP });
      expect(result.status, `secret=${String(bad)}`).toBe(500);
      expect(JSON.stringify(result.json), `secret=${String(bad)}`).toContain('TELEMETRY_ABUSE_HMAC_SECRET');
    }
  });

  it('skips the abuse layer when the platform provided no source address (layer 1 still applies)', async () => {
    // No sourceIp — a request with a fresh ID is accepted via layer 1 only.
    const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(204);
  });
});

describe('retention (SPEC §54, 90 days — shared policy)', () => {
  it('sweeps rows older than 90 days on each accepted write', async () => {
    db.seedRow('old-id-1', '2026-05-01', 'openclaw', 1, '2026-05-01T00:00:00.000Z'); // > 90 days before 2026-08-26
    db.seedRow('recent-id-1', '2026-08-20', 'codex', 1, '2026-08-20T00:00:00.000Z'); // within 90 days
    const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(204);
    const remaining = db.rows().map((r) => (r as Record<string, string>).bucket_date).sort();
    expect(remaining).toEqual(['2026-08-20', '2026-08-26']);
  });

  it('boundary policy: 89 and 90 days old are kept, 91 days old is swept', async () => {
    // NOW = 2026-08-26 → cutoff = 2026-05-28 (90 days). Deletion is
    // bucket_date < cutoff.
    expect(retentionCutoffDate(NOW)).toBe('2026-05-28');
    db.seedRow('d91', '2026-05-27', 'openclaw', 1, '2026-05-27T00:00:00.000Z'); // 91 days — swept
    db.seedRow('d90', '2026-05-28', 'openclaw', 1, '2026-05-28T00:00:00.000Z'); // 90 days — kept (== cutoff)
    db.seedRow('d89', '2026-05-29', 'openclaw', 1, '2026-05-29T00:00:00.000Z'); // 89 days — kept
    const result = await handleTelemetrySnapshot({ env: makeEnv(db, kv), body: JSON.stringify(buildSnapshot()), now: () => NOW });
    expect(result.status).toBe(204);
    const remaining = db.rows().map((r) => (r as Record<string, string>).bucket_date).sort();
    expect(remaining).toEqual(['2026-05-28', '2026-05-29', '2026-08-26']);
  });
});
