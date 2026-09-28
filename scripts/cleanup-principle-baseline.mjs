#!/usr/bin/env node
/**
 * cleanup-principle-baseline.mjs — Principle Knowledge Baseline Reset (design + tool).
 *
 * STATUS: Owner-review artifact. NOT executed against production.
 *         Default mode is --dry-run; --apply is required for any write.
 *
 * PURPOSE
 *   The Principle Tree Ledger (`<ws>/.state/principle_training_state.json`, `_tree.principles`)
 *   currently carries 122 entries whose source candidates were of four different
 *   `recommendation_kind` values (principle 49 / rule 40 / prompt 17 / implementation 16).
 *   This tool separates the genuine behavioural-principle assets (the new baseline)
 *   from rule material, prompt instructions, implementation suggestions and
 *   domain-overfit/self-referential/redundant entries — WITHOUT deleting anything.
 *
 * AUTHORITY / SAFETY MODEL (see docs/audit/principle-baseline-reset.md)
 *   - The ledger is the SSOT and has a single locked writer. This tool NEVER
 *     hand-writes the ledger file: it mutates the in-memory store returned by
 *     `loadLedger()` and persists it through the ledger's own `saveLedger()`,
 *     so the cross-process file lock (PRI-459) and the atomic rename are reused.
 *   - No deletion. Excluded entries are MARKED in place
 *     (`sourceRecommendationKind` / `baselineExcluded` / `baselineExit` / `baselineReason`).
 *     `_tree` extra namespaces are DROPPED by `parseTree()` on the next
 *     read-modify-write, so an "archive namespace inside _tree" would silently
 *     lose data — the archive is therefore written to a SEPARATE EXPORT FILE.
 *   - `--apply` REQUIRES a successful snapshot first (verified by sha256).
 *   - Live-injected entries (currently in `activations` with `deactivated_at IS NULL`)
 *     are excluded from marking by default: removing them from the baseline view
 *     would change runtime injection behaviour and needs an explicit Owner opt-in
 *     (`--include-live`), ideally after a staged deactivation.
 *
 * USAGE
 *   node scripts/cleanup-principle-baseline.mjs --workspace <ws>              # dry run
 *   node scripts/cleanup-principle-baseline.mjs --workspace <ws> --json
 *   node scripts/cleanup-principle-baseline.mjs --workspace <ws> --apply
 *   node scripts/cleanup-principle-baseline.mjs --workspace <ws> --apply --include-live
 *
 * CONSTRAINTS HONOURED
 *   no production data change without --apply · no file deletion · no migration ·
 *   no embedding · no Resolver · never touches ~/.pd / ~/.openclaw/extensions / <ws>/.pd
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ── configuration ──────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const LEDGER_MODULE = path.join(REPO_ROOT, 'packages', 'principles-core', 'dist', 'principle-tree-ledger.js');
const BETTER_SQLITE3 = path.join(REPO_ROOT, 'node_modules', 'better-sqlite3');

const NEAR_DUP_JACCARD = 0.15; // char-bigram Jaccard; see audit §Classification Method

/**
 * Domain-overfit detectors. These are HEURISTICS and every match is reported with
 * its tag so the Owner can override. They are deliberately explicit and auditable:
 * the classification must be reproducible, not model-judged.
 */
const DOMAIN_DETECTORS = {
  MEDIA: /成片|字幕|镜头|对白|音轨|MV|分镜|CLIP|HUD|hud_gen|gpt_hud|Episode|时间轴|渲染|封面|彩蛋|特效|台词|空镜|长视频|视频|图像|图片|视觉|动画|媒体|角色参考|角色形象|主体一致性|可读性验收|滚动时长/i,
  PD_INTERNAL: /疼痛报告|会话绑定|跟踪可用性|Gate ?[AB]|毕业验证|hook执行日志|诊断流程|诊断工具|诊断者|RuleCode|内化|原则库|intentTension|promote_to_rulehost|source-of-truth|CURRENT_STATE|event.?trace|数据库连接状态|子代理|sessions_yield|graduation/i,
};

/** Forbidden write targets — never touch the installer-owned paths. */
const FORBIDDEN_PREFIXES = ['.pd', '.openclaw'];

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { apply: false, json: false, includeLive: false, overrides: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--json') out.json = true;
    else if (a === '--include-live') out.includeLive = true;
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--state-dir') out.stateDir = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--overrides') out.overrides = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const USAGE = `
cleanup-principle-baseline — separate genuine Principle assets from non-principle ledger entries.

  --workspace <path>   PD workspace root (required; contains .state/ and .pd/)
  --state-dir <path>   override ledger dir (default: <workspace>/.state)
  --out-dir <path>     snapshot/archive output dir (default: <workspace>/.state)
  --overrides <path>   JSON { forceKeep: [id...], forceExclude: [id...] }
  --apply              perform the marking write (default: dry run, zero writes)
  --include-live       also mark entries that currently have a LIVE activation (opt-in)
  --json               machine-readable output
`;

// ── helpers ────────────────────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ts = () => new Date().toISOString().replace(/[:.]/g, '-');

function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const o = new Set();
  for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2));
  return o;
}
function jaccard(a, b) {
  let inter = 0;
  a.forEach((x) => { if (b.has(x)) inter++; });
  return inter / ((a.size + b.size - inter) || 1);
}

function assertNotForbidden(target) {
  const rel = path.relative(REPO_ROOT, target).replace(/\\/g, '/');
  const parts = rel.split('/');
  if (parts.some((p) => FORBIDDEN_PREFIXES.includes(p))) {
    throw new Error(`Refusing to write into an installer-owned path: ${target}`);
  }
}

// ── core: classification (pure; identical rules to the audit) ──────────────

function classifyEntry(entry, ctx) {
  const text = `${entry.text || ''} ${entry.action || ''}`;
  const cid = (entry.derivedFromPainIds || [])[0];
  const cand = ctx.candByCid.get(cid);
  const kind = cand ? cand.recommendation_kind : 'unknown';
  const tags = Object.entries(DOMAIN_DETECTORS)
    .filter(([, re]) => re.test(text))
    .map(([k]) => k);
  const clusterSize = ctx.clusterSizeById.get(entry.id) || 1;
  const isDup = clusterSize > 1;
  const isLive = ctx.liveCandidateIds.has(cid);

  let category;
  let reason;

  if (kind === 'rule') {
    category = 'B';
    reason = 'source candidate kind=rule — mechanically evaluable (triggerPattern + action present)';
  } else if (kind === 'prompt' || kind === 'implementation') {
    category = 'C';
    reason = `source candidate kind=${kind} — not a behavioural principle`;
  } else if (kind === 'principle') {
    if (tags.length > 0) {
      category = 'C';
      reason = `principle semantics but domain-overfit/self-referential [${tags.join('+')}]`;
    } else if (isDup) {
      category = 'C';
      reason = `principle semantics but overlaps a same-semantics cluster (n=${clusterSize})`;
    } else {
      category = 'A';
      reason = 'principle semantics + generic scope + no same-semantics overlap';
    }
  } else {
    category = 'D';
    reason = 'source candidate kind unresolvable — data-integrity anomaly';
  }

  // live-activation guard: never silently drop something that is being injected today
  const archiveBlockedByLive = category !== 'A' && category !== 'B' && isLive;

  return { category, reason, kind, tags, isDup, clusterSize, isLive, archiveBlockedByLive };
}

function buildClusters(entries) {
  const sig = entries.map((e) => ({ id: e.id, bg: bigrams(`${e.text || ''} ${e.action || ''}`) }));
  const parent = new Map(sig.map((s) => [s.id, s.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (let i = 0; i < sig.length; i++) {
    for (let j = i + 1; j < sig.length; j++) {
      if (jaccard(sig[i].bg, sig[j].bg) >= NEAR_DUP_JACCARD) {
        const a = find(sig[i].id); const b = find(sig[j].id);
        if (a !== b) parent.set(a, b);
      }
    }
  }
  const size = new Map();
  for (const s of sig) { const r = find(s.id); size.set(s.id, (size.get(s.id) || 0) + 1); }
  // recompute true cluster sizes
  const counts = new Map();
  for (const s of sig) { const r = find(s.id); counts.set(r, (counts.get(r) || 0) + 1); }
  const out = new Map();
  for (const s of sig) out.set(s.id, counts.get(find(s.id)) || 1);
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.workspace) { process.stdout.write(USAGE); process.exit(opts.help ? 0 : 2); }

  const workspace = path.resolve(opts.workspace);
  const stateDir = path.resolve(opts.stateDir || path.join(workspace, '.state'));
  const outDir = path.resolve(opts.outDir || stateDir);
  const dbPath = path.join(workspace, '.pd', 'state.db');

  if (!fs.existsSync(LEDGER_MODULE)) {
    throw new Error(`Ledger module not built: ${LEDGER_MODULE}. Run: npm run build --workspace=@principles/core`);
  }
  if (!fs.existsSync(dbPath)) throw new Error(`state.db not found: ${dbPath}`);

  // Reuse the ledger's own SSOT read/mutate API (never hand-write the file).
  const ledgerMod = await import(pathToFileURL(LEDGER_MODULE).href);
  const { loadLedger, saveLedger, getLedgerFilePathPublic } = ledgerMod;
  const ledgerPath = getLedgerFilePathPublic(stateDir);
  if (!fs.existsSync(ledgerPath)) throw new Error(`Ledger not found: ${ledgerPath}`);

  const require = createRequire(import.meta.url);
  const Database = require(BETTER_SQLITE3);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const store = loadLedger(stateDir);
  const entries = Object.values(store.tree.principles || {});

  const cands = db.prepare(
    'SELECT candidate_id, recommendation_kind, status, title, description, created_at FROM principle_candidates',
  ).all();
  const candByCid = new Map(cands.map((c) => [c.candidate_id, c]));

  const acts = db.prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations').all();
  const liveCandidateIds = new Set();
  for (const a of acts) {
    if (a.deactivated_at) continue;
    const m = String(a.artifact_id || '').match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/);
    if (m) liveCandidateIds.add(m[1]);
  }
  db.close();

  const overrides = opts.overrides && fs.existsSync(opts.overrides)
    ? JSON.parse(fs.readFileSync(opts.overrides, 'utf8'))
    : { forceKeep: [], forceExclude: [] };
  const forceKeep = new Set(overrides.forceKeep || []);
  const forceExclude = new Set(overrides.forceExclude || []);

  const clusterSizeById = buildClusters(entries);
  const ctx = { candByCid, liveCandidateIds, clusterSizeById };

  // ── P1 SCAN (read-only) ──
  const rows = entries.map((e) => {
    const c = classifyEntry(e, ctx);
    let planned = 'keep';
    if (forceKeep.has(e.id)) planned = 'keep(forced)';
    else if (forceExclude.has(e.id)) planned = 'exclude(forced)';
    else if (c.category === 'A') planned = 'keep';
    else if (c.archiveBlockedByLive && !opts.includeLive) planned = 'deferred-live';
    else planned = 'exclude';
    return { entry: e, candId: (e.derivedFromPainIds || [])[0], ...c, planned };
  });

  const tally = {};
  for (const r of rows) { const k = `${r.category}:${r.planned}`; tally[k] = (tally[k] || 0) + 1; }
  const unclassified = rows.filter((r) => r.category === 'D').length;
  const toExclude = rows.filter((r) => r.planned === 'exclude');
  const toMark = toExclude.filter((r) => r.entry.baselineExcluded !== true);

  const summary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    includeLive: opts.includeLive,
    workspace,
    ledgerPath,
    totalEntries: entries.length,
    tally,
    categories: {
      A_keep: rows.filter((r) => r.category === 'A').length,
      B_rule: rows.filter((r) => r.category === 'B').length,
      C_archive: rows.filter((r) => r.category === 'C').length,
      D_invalid: unclassified,
    },
    deferredLive: rows.filter((r) => r.planned === 'deferred-live').length,
    toMark: toMark.length,
    alreadyMarked: toExclude.length - toMark.length,
    projectedBaseline: entries.length - toExclude.length,
  };

  if (!opts.json) {
    console.log('=== P1 SCAN ===');
    console.log(`ledger: ${ledgerPath}`);
    console.log(`entries: ${entries.length}`);
    console.log(`categories: A(keep)=${summary.categories.A_keep}  B(rule)=${summary.categories.B_rule}  C(archive)=${summary.categories.C_archive}  D(invalid)=${summary.categories.D_invalid}`);
    console.log(`deferred (live activation, needs --include-live): ${summary.deferredLive}`);
    console.log(`planned to mark: ${summary.toMark}  already marked: ${summary.alreadyMarked}`);
    console.log(`projected baseline size: ${summary.projectedBaseline}`);
    console.log('\n-- planned exclusions (first 20) --');
    for (const r of toExclude.slice(0, 20)) {
      console.log(`  ${r.entry.id.slice(0, 8)} [${r.kind}/${r.category}] ${r.reason.slice(0, 58)} | ${String(r.entry.text).slice(0, 34)}`);
    }
    if (toExclude.length > 20) console.log(`  ... +${toExclude.length - 20} more`);
    if (summary.deferredLive) {
      console.log('\n-- deferred because currently LIVE (not marked) --');
      rows.filter((r) => r.planned === 'deferred-live').forEach((r) =>
        console.log(`  ${r.entry.id.slice(0, 8)} [${r.kind}] ${String(r.entry.text).slice(0, 56)}`));
    }
  }

  // INVARIANT: classification must be complete before any write.
  if (unclassified > 0 && opts.apply) {
    throw new Error(`Refusing to apply: ${unclassified} unclassifiable entr(ies). Inspect and resolve first.`);
  }

  if (!opts.apply) {
    if (opts.json) console.log(JSON.stringify({ ...summary, rows: rows.map(briefRow) }, null, 2));
    else console.log('\nDRY RUN — nothing written. Re-run with --apply to mark entries.');
    return;
  }

  // ── P2 SNAPSHOT (mandatory before any write) ──
  assertNotForbidden(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = ts();
  const ledgerRaw = fs.readFileSync(ledgerPath);
  const ledgerDigest = sha256(ledgerRaw);
  const backupPath = path.join(outDir, `principle_training_state.backup-${stamp}.json`);
  fs.writeFileSync(backupPath, ledgerRaw);

  const dbDump = path.join(outDir, `principle-candidates-${stamp}.json`);
  {
    const Database2 = require(BETTER_SQLITE3);
    const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const snap = db2.prepare('SELECT candidate_id, recommendation_kind, status, title, description, trigger_pattern, action, abstracted_principle, confidence, created_at, source_recommendation_json FROM principle_candidates').all();
    db2.close();
    fs.writeFileSync(dbDump, JSON.stringify(snap, null, 2));
  }
  const backupDigest = sha256(fs.readFileSync(backupPath));
  if (backupDigest !== ledgerDigest) throw new Error('Backup verification failed (digest mismatch) — aborting.');

  console.log('\n=== P2 SNAPSHOT ===');
  console.log(`ledger backup : ${backupPath}  sha256=${ledgerDigest}`);
  console.log(`candidate dump: ${dbDump}`);

  // ── P3 ARCHIVE EXPORT (recovery artifact; separate file, NOT an in-`_tree` namespace) ──
  const archivePath = path.join(outDir, `principle-baseline-archive-${stamp}.json`);
  fs.writeFileSync(archivePath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: 'Full copies of every entry excluded from the baseline. This file is a RECOVERY ARTIFACT, not a source of truth.',
    sourceLedger: ledgerPath,
    ledgerSha256: ledgerDigest,
    entries: toExclude.map((r) => ({
      id: r.entry.id,
      category: r.category,
      reason: r.reason,
      sourceCandidateId: r.candId,
      sourceRecommendationKind: r.kind,
      liveActivation: r.isLive,
      entry: r.entry,
      candidate: candByCid.get(r.candId) || null,
    })),
  }, null, 2));
  console.log('\n=== P3 ARCHIVE EXPORT ===');
  console.log(`archive: ${archivePath}  (${toExclude.length} entries)`);

  // ── P4 MARK (in place, additive only) ──
  const markedIds = [];
  for (const r of toMark) {
    const e = r.entry;
    store.tree.principles[e.id] = {
      ...e,
      sourceRecommendationKind: r.kind,
      baselineExcluded: true,
      baselineExit: r.category === 'B' ? 'rule-material' : r.category === 'D' ? 'invalid' : 'archive',
      baselineReason: r.reason,
    };
    markedIds.push(e.id);
  }
  // single locked persist through the ledger's own SSOT mutator
  saveLedger(stateDir, store);

  console.log('\n=== P4 MARK ===');
  console.log(`marked ${markedIds.length} entr(ies) via saveLedger() (locked + atomic rename).`);

  // ── P5 VERIFY ──
  const after = loadLedger(stateDir);
  const afterEntries = Object.values(after.tree.principles || {});
  const problems = [];
  if (afterEntries.length !== entries.length) problems.push(`entry count changed: ${entries.length} -> ${afterEntries.length}`);
  for (const id of markedIds) {
    const e = after.tree.principles[id];
    if (!e || e.baselineExcluded !== true || typeof e.sourceRecommendationKind !== 'string') {
      problems.push(`entry not correctly marked: ${id}`);
    }
  }
  for (const r of rows) {
    const before = r.entry; const now = after.tree.principles[before.id];
    if (!now) { problems.push(`entry vanished: ${before.id}`); continue; }
    for (const field of ['text', 'status', 'derivedFromPainIds', 'ruleIds', 'createdAt']) {
      if (JSON.stringify(now[field]) !== JSON.stringify(before[field])) {
        problems.push(`immutable field mutated on ${before.id}: ${field}`);
      }
    }
  }
  console.log('\n=== P5 VERIFY ===');
  console.log(`entries after: ${afterEntries.length} (expected ${entries.length})`);
  console.log(`marked: ${markedIds.length}`);
  if (problems.length) {
    console.error('VERIFICATION FAILED:');
    for (const p of problems.slice(0, 20)) console.error('  - ' + p);
    console.error(`Roll back with: cp "${backupPath}" "${ledgerPath}"`);
    process.exitCode = 1;
    return;
  }
  console.log('OK — count unchanged, marks applied, immutable fields untouched.');
  console.log(`Rollback: cp "${backupPath}" "${ledgerPath}"`);
}

function briefRow(r) {
  return {
    id: r.entry.id,
    status: r.entry.status,
    kind: r.kind,
    category: r.category,
    planned: r.planned,
    live: r.isLive,
    dup: r.isDup,
    tags: r.tags,
    reason: r.reason,
    text: String(r.entry.text || '').slice(0, 120),
  };
}

main().catch((err) => {
  console.error('ERROR: ' + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
