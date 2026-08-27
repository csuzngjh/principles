/**
 * Protected retention cleanup endpoint tests (review remediation P1-4).
 *
 * Locks the contract of POST /api/product-telemetry/cleanup:
 * - auth: no/wrong token → 401; weak/missing configured token → 500;
 * - the cutoff is computed server-side from the SHARED retention policy
 *   (retentionCutoffDate — same computation as the write-time sweep);
 * - cleanup runs with NO new telemetry writes (independent enforcement);
 * - boundary: 89/90 days kept, 91 days swept;
 * - idempotence: a second run succeeds with deleted=0;
 * - no telemetry row contents are ever returned.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleTelemetryCleanup, type CleanupEnv } from '../telemetry-cleanup-core.js';
import { retentionCutoffDate, type TelemetryD1 } from '../telemetry-core.js';

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

function makeDb(): { db: Database.Database; d1: TelemetryD1; seed(serverDailyId: string, bucketDate: string): void } {
  const db = new Database(':memory:');
  applyMigrations(db);
  const d1: TelemetryD1 = {
    prepare: (query: string) => {
      const statement = db.prepare(query);
      return {
        bind: (...values: unknown[]) => ({
          run: async () => ({ meta: { changes: statement.run(...values).changes } }),
        }),
      };
    },
  };
  return {
    db,
    d1,
    seed(serverDailyId, bucketDate) {
      db.prepare(SEED_ROW_SQL).run(serverDailyId, bucketDate, '1', '1.0.0', 'openclaw', 1, 1, 1, 1, 1, 1, 0, `${bucketDate}T00:00:00.000Z`, `${bucketDate}T00:00:00.000Z`);
    },
  };
}

// 48 hex chars = 24 bytes — matches the enforced token floor exactly.
const TOKEN = 'ef'.repeat(24);
const NOW = Date.parse('2026-08-26T10:00:00.000Z');

let seeded: ReturnType<typeof makeDb>;

beforeEach(() => {
  seeded = makeDb();
});

function makeEnv(overrides: Partial<CleanupEnv> = {}): CleanupEnv {
  return { PD_PRODUCT_TELEMETRY: seeded.d1, PRODUCT_TELEMETRY_CLEANUP_TOKEN: TOKEN, ...overrides };
}

describe('cleanup auth', () => {
  it('rejects requests without a token with 401', async () => {
    const result = await handleTelemetryCleanup({ env: makeEnv(), now: () => NOW });
    expect(result.status).toBe(401);
  });

  it('rejects wrong tokens with 401', async () => {
    const result = await handleTelemetryCleanup({ env: makeEnv(), authorization: 'Bearer wrong-token-value-0123', now: () => NOW });
    expect(result.status).toBe(401);
  });

  it('fails closed when the configured token is missing, too short, or non-hex', async () => {
    for (const bad of [undefined, 'short', 'z'.repeat(48), 'ef'.repeat(23)]) {
      const env: CleanupEnv = { PD_PRODUCT_TELEMETRY: seeded.d1, ...(bad !== undefined ? { PRODUCT_TELEMETRY_CLEANUP_TOKEN: bad } : {}) };
      const result = await handleTelemetryCleanup({ env, authorization: `Bearer ${TOKEN}`, now: () => NOW });
      expect(result.status, `token=${String(bad)}`).toBe(500);
      expect(JSON.stringify(result.json), `token=${String(bad)}`).toContain('cleanup_misconfigured');
    }
  });

  it('executes with the correct bearer token', async () => {
    const result = await handleTelemetryCleanup({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(result.status).toBe(200);
  });
});

describe('cleanup retention semantics', () => {
  it('deletes expired rows with NO new telemetry writes (independent enforcement)', async () => {
    seeded.seed('old-1', '2026-05-01');
    seeded.seed('old-2', '2026-05-27');
    seeded.seed('keep-1', '2026-05-28');
    const result = await handleTelemetryCleanup({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(result.status).toBe(200);
    const remaining = (seeded.db.prepare('SELECT server_daily_id FROM product_telemetry_daily').all() as Array<{ server_daily_id: string }>).map((r) => r.server_daily_id).sort();
    expect(remaining).toEqual(['keep-1']);
  });

  it('boundary: 89 and 90 days old kept, 91 days old deleted; cutoff matches the shared policy', async () => {
    expect(retentionCutoffDate(NOW)).toBe('2026-05-28');
    seeded.seed('d91', '2026-05-27');
    seeded.seed('d90', '2026-05-28');
    seeded.seed('d89', '2026-05-29');
    const result = await handleTelemetryCleanup({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(result.status).toBe(200);
    const json = result.json as { ok: boolean; deleted: number; cutoff: string };
    expect(json.ok).toBe(true);
    expect(json.deleted).toBe(1);
    expect(json.cutoff).toBe(retentionCutoffDate(NOW));
    const remaining = (seeded.db.prepare('SELECT bucket_date FROM product_telemetry_daily').all() as Array<{ bucket_date: string }>).map((r) => r.bucket_date).sort();
    expect(remaining).toEqual(['2026-05-28', '2026-05-29']);
  });

  it('is idempotent: a second run succeeds with deleted=0', async () => {
    seeded.seed('old-1', '2026-01-01');
    const first = await handleTelemetryCleanup({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect((first.json as { deleted: number }).deleted).toBe(1);
    const second = await handleTelemetryCleanup({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(second.status).toBe(200);
    expect((second.json as { ok: boolean; deleted: number }).ok).toBe(true);
    expect((second.json as { deleted: number }).deleted).toBe(0);
  });

  it('returns no telemetry row contents — only ok/deleted/cutoff', async () => {
    seeded.seed('old-1', '2026-01-01');
    const result = await handleTelemetryCleanup({ env: makeEnv(), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(Object.keys(result.json as Record<string, unknown>).sort()).toEqual(['cutoff', 'deleted', 'ok']);
  });

  it('maps a D1 failure to a bounded 500 with a coarse reason', async () => {
    const broken: TelemetryD1 = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('D1_ERROR: internal detail');
          },
        }),
      }),
    };
    const result = await handleTelemetryCleanup({ env: makeEnv({ PD_PRODUCT_TELEMETRY: broken }), authorization: `Bearer ${TOKEN}`, now: () => NOW });
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.json)).toContain('storage_unavailable');
    expect(JSON.stringify(result.json)).not.toContain('D1_ERROR');
  });
});
