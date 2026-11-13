#!/usr/bin/env node
/**
 * Read-only Principle identity audit (P1-2, 2026-11-13).
 *
 * It NEVER writes to the inspected database and never rewrites identities. It
 * classifies prompt activations so a future migration can be decided from
 * evidence instead of a bulk title → UUID replacement:
 *
 *   A  fully consistent: activation target UUID = artifact source_principle_id
 *      = every principle_applications.principle_id
 *   B  title-shaped artifact identity, but exactly one verifiable UUID lineage
 *      (the receipt/activation agree on one ledger UUID)
 *   C  multiple candidate mappings (ambiguous)
 *   D  missing necessary lineage (no UUID target, no artifact, no receipt, …)
 *
 * Usage:
 *   node scripts/dev/principle-identity-audit.mjs --db <state.db> [--json|--markdown]
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value.trim());

function parseArgs(argv) {
  const options = { db: null, format: 'markdown' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') options.db = argv[++i];
    else if (arg === '--json') options.format = 'json';
    else if (arg === '--markdown') options.format = 'markdown';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.db) throw new Error('--db <state.db> is required');
  return options;
}

function readRows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    if (String(error).includes('no such table')) return [];
    throw error;
  }
}

function contentPrincipleId(contentJson) {
  try {
    const parsed = JSON.parse(contentJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (isUuid(parsed.principleId)) return parsed.principleId.trim().toLowerCase();
    if (isUuid(parsed.sourcePrincipleId)) return parsed.sourcePrincipleId.trim().toLowerCase();
    return null;
  } catch {
    return null;
  }
}

function audit(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const activations = readRows(
      db,
      `SELECT activation_id, artifact_id, channel, action, target_ref, activated_at, deactivated_at
         FROM activations WHERE channel = 'prompt' AND action = 'prompt_activate'`,
    );
    const artifacts = new Map(
      readRows(db, 'SELECT artifact_id, artifact_kind, content_json, validation_status, source_principle_id FROM pi_artifacts')
        .map((row) => [row.artifact_id, row]),
    );
    const applications = readRows(db, 'SELECT principle_id, activation_id FROM principle_applications');
    const receiptsByActivation = new Map();
    for (const row of applications) {
      const key = row.activation_id;
      if (key === null || key === undefined) continue;
      const list = receiptsByActivation.get(key) ?? [];
      list.push(row.principle_id);
      receiptsByActivation.set(key, list);
    }

    const classes = { A: [], B: [], C: [], D: [] };
    const legacyTitleReceipts = [];
    for (const activation of activations) {
      const targetRaw = typeof activation.target_ref === 'string' ? activation.target_ref : '';
      const targetId = targetRaw.startsWith('ledger://') && isUuid(targetRaw.slice('ledger://'.length))
        ? targetRaw.slice('ledger://'.length).trim().toLowerCase()
        : null;
      const artifact = artifacts.get(activation.artifact_id);
      const columnId = artifact && isUuid(artifact.source_principle_id) ? artifact.source_principle_id.trim().toLowerCase() : null;
      const contentId = artifact ? contentPrincipleId(artifact.content_json) : null;
      const receiptIds = [...new Set((receiptsByActivation.get(activation.activation_id) ?? []).filter((id) => typeof id === 'string'))];
      const uuidReceipts = receiptIds.filter(isUuid);
      const titleReceipts = receiptIds.filter((id) => !isUuid(id));

      if (titleReceipts.length > 0 && targetId !== null) {
        legacyTitleReceipts.push({
          activationId: activation.activation_id,
          artifactId: activation.artifact_id,
          targetId,
          titleReceipts: titleReceipts.slice(0, 3),
        });
      }

      const base = {
        activationId: activation.activation_id,
        artifactId: activation.artifact_id,
        deactivatedAt: activation.deactivated_at,
        targetId,
        columnId,
        contentId,
        receiptIds: receiptIds.slice(0, 5),
      };

      if (targetId !== null && columnId === targetId && (receiptIds.length === 0 || receiptIds.every((id) => id === targetId))) {
        classes.A.push(base);
      } else if (targetId !== null && columnId === null && uuidReceipts.length === 1 && uuidReceipts[0] === targetId) {
        classes.B.push(base);
      } else if (uuidReceipts.length > 1) {
        classes.C.push(base);
      } else {
        classes.D.push(base);
      }
    }

    return {
      dbPath: path.resolve(dbPath),
      generatedAt: new Date().toISOString(),
      totals: {
        promptActivations: activations.length,
        livePromptActivations: activations.filter((row) => row.deactivated_at === null).length,
        artifacts: artifacts.size,
        applications: applications.length,
      },
      classes: {
        A: classes.A.length,
        B: classes.B.length,
        C: classes.C.length,
        D: classes.D.length,
      },
      legacyTitleReceipts: {
        count: legacyTitleReceipts.length,
        samples: legacyTitleReceipts.slice(0, 10),
      },
      samples: {
        A: classes.A.slice(0, 3),
        B: classes.B.slice(0, 3),
        C: classes.C.slice(0, 3),
        D: classes.D.slice(0, 5),
      },
    };
  } finally {
    db.close();
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Principle identity read-only audit',
    '',
    `- Database: \`${report.dbPath}\``,
    `- Generated: ${report.generatedAt}`,
    `- Prompt activations: ${report.totals.promptActivations} (live ${report.totals.livePromptActivations})`,
    `- pi_artifacts: ${report.totals.artifacts}; principle_applications: ${report.totals.applications}`,
    '',
    '| Class | Meaning | Count |',
    '| --- | --- | ---: |',
    `| A | target UUID = artifact UUID = receipt UUID | ${report.classes.A} |`,
    `| B | title-shaped artifact, one verifiable UUID lineage | ${report.classes.B} |`,
    `| C | multiple candidate mappings | ${report.classes.C} |`,
    `| D | missing necessary lineage | ${report.classes.D} |`,
    '',
    `## Legacy title receipts`,
    '',
    `${report.legacyTitleReceipts.count} activation(s) carry a UUID target but at least one non-UUID \`principle_applications.principle_id\`.`,
    '',
  ];
  for (const sample of report.legacyTitleReceipts.samples) {
    lines.push(`- ${sample.activationId} → ${sample.targetId} (title receipt: ${sample.titleReceipts.join(' | ')})`);
  }
  lines.push('', '## Read-only note', '', 'No row was modified. Any migration needs its own SPEC, dry-run and reversibility plan.', '');
  return lines.join('\n');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.db)) throw new Error(`database not found: ${options.db}`);
  const report = audit(options.db);
  process.stdout.write(options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
