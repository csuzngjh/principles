// product-signals-core.ts
// Protected maintainer product-signals view (PRI-601, SPEC §56-§63; review
// remediation: workspace measurement unit + tri-state denominators).
//
// GET /product-signals with `Authorization: Bearer <PRODUCT_SIGNALS_TOKEN>`.
// Renders a minimal HTML page from D1 aggregates. NOT a BI platform:
// exactly four signal groups — daily participating workspaces, version
// distribution, milestone reach, coarse reliability — plus the permanent
// opt-in-bias warning (SPEC §62). No per-workspace rows or IDs are ever
// rendered; the identity architecture makes a per-workspace timeline
// impossible by construction (daily unlinkable IDs, server-HMACed before
// storage).
//
// Measurement wording is part of the metric contract (SPEC §57):
// - "participating workspaces", never "installations" or "users";
// - these are accepted anonymous submissions — the collector cannot prove
//   the sender is a real PD installation;
// - multi-day sums are "daily-workspace observations" (cross-day dedup is
//   intentionally impossible) — never "unique workspaces";
// - "Effect receipt observed", never "Agent improved";
// - NULL facts are excluded from denominators (Observed / Evaluable /
//   Unavailable per milestone) — never summed as 0.

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
  'Anonymous telemetry is opt-in and represents only participating workspaces that submitted this snapshot. Figures are accepted anonymous submissions, not verified product usage, and must not be interpreted as the complete PD population.';

interface FactCounts {
  observed: number;
  evaluable: number;
  unavailable: number;
}

interface DailyCounts {
  total: number;
  initialized: FactCounts;
  painObserved: FactCounts;
  principleObserved: FactCounts;
  activationObserved: FactCounts;
  presenceReceiptObserved: FactCounts;
  effectReceiptObserved: FactCounts;
  initializationFailed: FactCounts;
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FACT_COLUMNS = [
  'initialized',
  'pain_observed',
  'principle_observed',
  'activation_observed',
  'presence_receipt_observed',
  'effect_receipt_observed',
  'initialization_failed',
] as const;

/**
 * Per-fact tri-state aggregation for one bucket date. `observed` = SUM(col)
 * (SQL SUM ignores NULL); `evaluable` = COUNT(col) (non-NULL rows); the
 * complement of COUNT(*) is `unavailable`. Unknown facts never enter a
 * denominator and are never counted as 0.
 */
async function readDailyCounts(db: SignalsD1['PD_PRODUCT_TELEMETRY'], bucketDate: string): Promise<DailyCounts> {
  const selects = FACT_COLUMNS.map((col) => `COALESCE(SUM(${col}), 0) AS sum_${col}, COUNT(${col}) AS eval_${col}`).join(', ');
  const row = await db
    .prepare(`SELECT COUNT(*) AS total, ${selects} FROM product_telemetry_daily WHERE bucket_date = ?`)
    .bind(bucketDate)
    .first();
  const toNum = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const fact = (col: string): FactCounts => {
    const evaluable = toNum(row?.[`eval_${col}`]);
    return {
      observed: toNum(row?.[`sum_${col}`]),
      evaluable,
      unavailable: toNum(row?.total) - evaluable,
    };
  };
  return {
    total: toNum(row?.total),
    initialized: fact('initialized'),
    painObserved: fact('pain_observed'),
    principleObserved: fact('principle_observed'),
    activationObserved: fact('activation_observed'),
    presenceReceiptObserved: fact('presence_receipt_observed'),
    effectReceiptObserved: fact('effect_receipt_observed'),
    initializationFailed: fact('initialization_failed'),
  };
}

/** Constant-time byte-string comparison (same construction as relay-core; WebCrypto has no timingSafeEqual). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!;
  }
  return diff === 0;
}

export async function handleProductSignals(deps: SignalsDeps): Promise<SignalsResult> {
  const now = deps.now ?? Date.now;
  const token = deps.env.PRODUCT_SIGNALS_TOKEN;
  // Token floor matches the runbook exactly: ≥24 bytes as hex (48+ hex chars).
  if (token === undefined || !/^[0-9a-f]{48,}$/i.test(token)) {
    return { status: 500, body: JSON.stringify({ error: 'view_misconfigured', reason: 'PRODUCT_SIGNALS_TOKEN must be >=24 bytes as hex (48+ hex chars)' }), contentType: 'application/json' };
  }
  const expected = `Bearer ${token}`;
  const provided = deps.authorization ?? '';
  if (!constantTimeEqual(provided, expected)) {
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
        'SELECT pd_version AS version, COUNT(*) AS workspaces FROM product_telemetry_daily WHERE bucket_date = ? GROUP BY pd_version ORDER BY workspaces DESC, version ASC LIMIT 20',
      )
      .bind(today)
      .all();

    const sevenDayObservations = typeof sevenDayRow?.observations === 'number' ? sevenDayRow.observations : 0;
    const versions = versionRows.results.map((r) => ({
      version: typeof r.version === 'string' ? r.version : String(r.version),
      workspaces: typeof r.workspaces === 'number' ? r.workspaces : 0,
    }));

    const html = renderSignalsPage({ today, counts, sevenDayObservations, versions });
    return { status: 200, body: html, contentType: 'text/html; charset=utf-8' };
  } catch (error) {
    // Fixed coarse reason only — backend error text never reaches the responder.
    console.error('[product-signals] read failed:', error instanceof Error ? error.message : String(error));
    return { status: 500, body: JSON.stringify({ error: 'storage_unavailable', reason: 'signals could not be read' }), contentType: 'application/json' };
  }
}

function renderSignalsPage(data: {
  today: string;
  counts: DailyCounts;
  sevenDayObservations: number;
  versions: Array<{ version: string; workspaces: number }>;
}): string {
  const { today, counts, sevenDayObservations, versions } = data;
  const versionRows = versions
    .map((v) => `        <tr><td>${esc(v.version)}</td><td>${v.workspaces}</td></tr>`)
    .join('\n');
  const milestone = (label: string, f: FactCounts): string =>
    `        <tr><td>${label}</td><td>${f.observed}</td><td>${f.evaluable}</td><td>${f.unavailable}</td></tr>`;
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

  <h2>Participating workspaces (today)</h2>
  <table>
    <tr><th>Signal</th><th>Count</th></tr>
    <tr><td>Daily participating workspaces</td><td>${counts.total}</td></tr>
    <tr><td>7-day participating daily-workspace observations</td><td>${sevenDayObservations}</td></tr>
  </table>
  <p class="note">Cross-day deduplication is intentionally impossible (daily unlinkable IDs) — the 7-day figure is a sum of daily workspace observations, NOT unique workspaces.</p>

  <h2>Version distribution (today)</h2>
  <table>
    <tr><th>PD version</th><th>Daily workspace observations</th></tr>
${versionRows || '        <tr><td colspan="2">(no data)</td></tr>'}
  </table>

  <h2>Milestone reach (today)</h2>
  <table>
    <tr><th>Milestone</th><th>Observed</th><th>Evaluable workspaces</th><th>Unavailable</th></tr>
${milestone('Initialized', counts.initialized)}
${milestone('Pain observed', counts.painObserved)}
${milestone('Principle observed', counts.principleObserved)}
${milestone('Activation observed', counts.activationObserved)}
${milestone('Presence receipt observed', counts.presenceReceiptObserved)}
${milestone('Effect receipt observed', counts.effectReceiptObserved)}
  </table>
  <p class="note">Observed / Evaluable / Unavailable: NULL ("source unavailable") facts are excluded from the denominator and never counted as false.</p>
  <p class="note">An effect receipt proves a governance mechanism affected one execution — it is not evidence of durable Agent improvement.</p>

  <h2>Reliability (today, coarse)</h2>
  <table>
    <tr><th>Signal</th><th>Observed</th><th>Evaluable workspaces</th><th>Unavailable</th></tr>
    ${milestone('Initialization failure', counts.initializationFailed)}
  </table>
</body>
</html>
`;
}
