// product-signals-core.ts
// Protected maintainer product-signals view (PRI-601, SPEC §56-§63).
//
// GET /product-signals with `Authorization: Bearer <PRODUCT_SIGNALS_TOKEN>`.
// Renders a minimal HTML page from D1 aggregates. NOT a BI platform:
// exactly four signal groups — daily participating telemetry units, version
// distribution, milestone reach, coarse reliability — plus the permanent
// opt-in-bias warning (SPEC §62). No per-unit rows or IDs are ever rendered;
// the identity architecture makes a per-deployment timeline impossible by
// construction (daily unlinkable IDs, server-HMACed before storage).
//
// Measurement wording is part of the metric contract (SPEC §57):
// - "participating installations", never "users";
// - multi-day sums are "daily-unit observations" (cross-day dedup is
//   intentionally impossible);
// - "Effect receipt observed", never "Agent improved".

/** Minimal D1 query surface for aggregate reads. */
export interface SignalsD1 {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export interface SignalsEnv {
  PD_PRODUCT_TELEMETRY: SignalsD1;
  PRODUCT_SIGNALS_TOKEN?: string;
}

export interface SignalsDeps {
  env: SignalsEnv;
  /** Raw Authorization header value. */
  authorization?: string;
  now?: () => number;
}

export interface SignalsResult {
  status: number;
  /** HTML body (200) or a tiny JSON error (401/500). */
  body: string;
  contentType: 'text/html; charset=utf-8' | 'application/json';
}

const PERMANENT_WARNING =
  'Anonymous telemetry is opt-in and represents only participating telemetry units. It must not be interpreted as the complete PD user population.';

interface DailyCounts {
  total: number;
  initialized: number;
  painObserved: number;
  principleObserved: number;
  activationObserved: number;
  presenceReceiptObserved: number;
  effectReceiptObserved: number;
  initializationFailed: number;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function readDailyCounts(db: SignalsD1['PD_PRODUCT_TELEMETRY'], bucketDate: string): Promise<DailyCounts> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(initialized), 0) AS initialized,
              COALESCE(SUM(pain_observed), 0) AS painObserved,
              COALESCE(SUM(principle_observed), 0) AS principleObserved,
              COALESCE(SUM(activation_observed), 0) AS activationObserved,
              COALESCE(SUM(presence_receipt_observed), 0) AS presenceReceiptObserved,
              COALESCE(SUM(effect_receipt_observed), 0) AS effectReceiptObserved,
              COALESCE(SUM(initialization_failed), 0) AS initializationFailed
       FROM product_telemetry_daily WHERE bucket_date = ?`,
    )
    .bind(bucketDate)
    .first();
  const toNum = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    total: toNum(row?.total),
    initialized: toNum(row?.initialized),
    painObserved: toNum(row?.painObserved),
    principleObserved: toNum(row?.principleObserved),
    activationObserved: toNum(row?.activationObserved),
    presenceReceiptObserved: toNum(row?.presenceReceiptObserved),
    effectReceiptObserved: toNum(row?.effectReceiptObserved),
    initializationFailed: toNum(row?.initializationFailed),
  };
}

export async function handleProductSignals(deps: SignalsDeps): Promise<SignalsResult> {
  const now = deps.now ?? Date.now;
  const token = deps.env.PRODUCT_SIGNALS_TOKEN;
  if (token === undefined || token.length < 16) {
    return { status: 500, body: JSON.stringify({ error: 'view_misconfigured', reason: 'PRODUCT_SIGNALS_TOKEN missing or too short' }), contentType: 'application/json' };
  }
  const expected = `Bearer ${token}`;
  const provided = deps.authorization ?? '';
  if (provided.length !== expected.length || provided !== expected) {
    return { status: 401, body: JSON.stringify({ error: 'unauthorized' }), contentType: 'application/json' };
  }

  const today = new Date(now()).toISOString().slice(0, 10);
  const cutoff7 = new Date(now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const db = deps.env.PD_PRODUCT_TELEMETRY;
  try {
    const counts = await readDailyCounts(db, today);
    const sevenDayRow = await db
      .prepare('SELECT COUNT(*) AS observations FROM product_telemetry_daily WHERE bucket_date >= ?')
      .bind(cutoff7)
      .first();
    const versionRows = await db
      .prepare(
        'SELECT pd_version AS version, COUNT(*) AS units FROM product_telemetry_daily WHERE bucket_date = ? GROUP BY pd_version ORDER BY units DESC, version ASC LIMIT 20',
      )
      .bind(today)
      .all();

    const sevenDayObservations = typeof sevenDayRow?.observations === 'number' ? sevenDayRow.observations : 0;
    const versions = versionRows.results.map((r) => ({
      version: typeof r.version === 'string' ? r.version : String(r.version),
      units: typeof r.units === 'number' ? r.units : 0,
    }));

    const healthy = counts.total - counts.initializationFailed;
    const html = renderSignalsPage({ today, counts, sevenDayObservations, versions, healthy });
    return { status: 200, body: html, contentType: 'text/html; charset=utf-8' };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : 'd1_error';
    return { status: 500, body: JSON.stringify({ error: 'storage_unavailable', reason }), contentType: 'application/json' };
  }
}

function renderSignalsPage(data: {
  today: string;
  counts: DailyCounts;
  sevenDayObservations: number;
  versions: Array<{ version: string; units: number }>;
  healthy: number;
}): string {
  const { today, counts, sevenDayObservations, versions, healthy } = data;
  const versionRows = versions
    .map((v) => `        <tr><td>${esc(v.version)}</td><td>${v.units}</td></tr>`)
    .join('\n');
  const milestone = (label: string, value: number): string => `        <tr><td>${label}</td><td>${value}</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>PD Product Signals (maintainer)</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 46rem; color: #1f2937; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
  table { border-collapse: collapse; margin-top: .5rem; }
  td, th { border: 1px solid #d1d5db; padding: .25rem .75rem; text-align: left; }
  .warning { background: #fef3c7; border: 1px solid #f59e0b; padding: .75rem; margin-top: 1rem; font-size: .875rem; }
  .note { color: #6b7280; font-size: .8125rem; margin-top: .25rem; }
</style>
</head>
<body>
  <h1>PD Anonymous Product Signals — ${esc(today)} (UTC)</h1>
  <p class="warning"><strong>${esc(PERMANENT_WARNING)}</strong></p>

  <h2>Participating telemetry units (today)</h2>
  <table>
    <tr><th>Signal</th><th>Participating installations</th></tr>
    <tr><td>Daily participating telemetry units</td><td>${counts.total}</td></tr>
    <tr><td>7-day participating daily-unit observations</td><td>${sevenDayObservations}</td></tr>
  </table>
  <p class="note">Cross-day deduplication is intentionally impossible (daily unlinkable IDs) — the 7-day figure is a sum of daily observations, not unique installations.</p>

  <h2>Version distribution (today)</h2>
  <table>
    <tr><th>PD version</th><th>Participating daily units</th></tr>
${versionRows || '        <tr><td colspan="2">(no data)</td></tr>'}
  </table>

  <h2>Milestone reach (today)</h2>
  <table>
    <tr><th>Milestone</th><th>Participating daily units</th></tr>
${milestone('Initialized', counts.initialized)}
${milestone('Pain observed', counts.painObserved)}
${milestone('Principle observed', counts.principleObserved)}
${milestone('Activation observed', counts.activationObserved)}
${milestone('Presence receipt observed', counts.presenceReceiptObserved)}
${milestone('Effect receipt observed', counts.effectReceiptObserved)}
  </table>
  <p class="note">An effect receipt proves a governance mechanism affected one execution — it is not evidence of durable Agent improvement.</p>

  <h2>Reliability (today, coarse)</h2>
  <table>
    <tr><th>Signal</th><th>Daily units</th></tr>
    <tr><td>Healthy</td><td>${healthy}</td></tr>
    <tr><td>Initialization failure</td><td>${counts.initializationFailed}</td></tr>
  </table>
</body>
</html>
`;
}
