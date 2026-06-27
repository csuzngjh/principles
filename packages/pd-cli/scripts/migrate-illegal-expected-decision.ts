/**
 * 一次性数据迁移脚本：修正 pi_artifacts 中 expectedDecision = "requireApproval" 的历史坏数据。
 *
 * 背景：
 *   GoldenTraceDecision 的合法值只有 "allow" | "block" | "propose_correction"
 *   （定义在 @principles/core/runtime-v2 的 golden-trace.ts GoldenTraceDecisionSchema）。
 *   但 PRI-427 加固前创建的 rule artifact 可能含有 "requireApproval"
 *   （这是 RuleHostDecision 的运行时枚举值，不是测试期望值）。
 *   这类 artifact 在 owner 批准时会失败，错误信息为
 *   "gate_decision_not_accepted_shadow:rejected_validation_failed"，对 owner 不可操作。
 *
 *   根因已在 rule-host-writer.ts 的 extractGoldenTrace() 中修复（调用 validateGoldenTrace
 *   前置 schema 校验）。本脚本用于清理已存在的坏数据。
 *
 * 修复策略：
 *   - kind=negative + expectedDecision=requireApproval → 改为 "block"
 *     （validateCaseDecision 的 'block' case 接受 requireApproval 作为合法运行时输出）
 *   - kind=positive + expectedDecision=requireApproval → 改为 "allow"
 *     （理论上不应出现，但兜底处理）
 *   - 其他非法值 → 报告但不修改（需人工判断）
 *
 * 使用：
 *   npx tsx scripts/migrate-illegal-expected-decision.ts <workspace-dir> [--write]
 *
 * 示例：
 *   npx tsx scripts/migrate-illegal-expected-decision.ts D:/.openclaw/workspace
 *   npx tsx scripts/migrate-illegal-expected-decision.ts D:/.openclaw/workspace --write
 *
 * 安全保障：
 *   1. 默认 dry-run（只读），必须显式 --write 才会写入
 *   2. --write 模式下自动备份 state.db 到 state.db.backup-<timestamp>
 *   3. 只修改 artifact_kind='rule' 的记录
 *   4. 同时修正 goldenTrace 和 goldenTraceCases 两个字段（artificer raw 输出副本）
 *   5. --write 模式下所有 UPDATE 在单个事务内执行，保证原子性
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

interface CliArgs {
  workspaceDir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.slice(2).filter((a) => !a.startsWith('--'));
  // Safety default: dry-run (read-only). Operator must pass --write to mutate.
  const writeMode = argv.includes('--write');
  if (positional.length === 0) {
    console.error('Usage: npx tsx scripts/migrate-illegal-expected-decision.ts <workspace-dir> [--write]');
    console.error('Example: npx tsx scripts/migrate-illegal-expected-decision.ts D:/.openclaw/workspace');
    console.error('         npx tsx scripts/migrate-illegal-expected-decision.ts D:/.openclaw/workspace --write');
    process.exit(1);
  }
  return { workspaceDir: positional[0] ?? '', dryRun: !writeMode };
}

interface FixRecord {
  artifactId: string;
  caseId: string;
  kind: string;
  from: string;
  to: string;
  field: 'goldenTrace' | 'goldenTraceCases';
}

function normalizeExpectedDecision(value: unknown, kind: unknown): string | null {
  if (value !== 'requireApproval') return null;
  // Only map explicit kinds — unknown kind must NOT be silently coerced.
  // Unknown kinds are reported (not modified) so a human can review them.
  if (kind === 'positive') return 'allow';
  if (kind === 'negative') return 'block';
  return null;
}

function fixCasesArray(
  cases: unknown,
  artifactId: string,
  field: 'goldenTrace' | 'goldenTraceCases',
  fixes: FixRecord[],
  issues: Array<{ artifactId: string; issue: string }>,
): boolean {
  if (!Array.isArray(cases)) return false;
  let modified = false;
  for (const c of cases) {
    if (typeof c !== 'object' || c === null) continue;
    const rec = c as Record<string, unknown>;
    const newVal = normalizeExpectedDecision(rec.expectedDecision, rec.kind);
    if (newVal !== null) {
      fixes.push({
        artifactId,
        caseId: typeof rec.caseId === 'string' ? rec.caseId : '<unknown>',
        kind: typeof rec.kind === 'string' ? rec.kind : '<unknown>',
        from: String(rec.expectedDecision),
        to: newVal,
        field,
      });
      rec.expectedDecision = newVal;
      modified = true;
    } else if (rec.expectedDecision === 'requireApproval') {
      // Illegal value found but kind is not positive/negative — cannot
      // auto-fix safely. Record for manual review instead of silently
      // coercing to 'block' (rc-9: no silent fallback).
      const kindStr = typeof rec.kind === 'string' ? rec.kind : '<unknown>';
      const caseIdStr = typeof rec.caseId === 'string' ? rec.caseId : '<unknown>';
      issues.push({
        artifactId,
        issue: `requireApproval with unknown kind="${kindStr}" (case=${caseIdStr}, field=${field}) — manual review required`,
      });
    }
  }
  return modified;
}

function main(): void {
  const { workspaceDir, dryRun } = parseArgs(process.argv);
  const dbPath = path.join(workspaceDir, '.pd', 'state.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`[error] state.db not found at ${dbPath}`);
    process.exit(1);
  }

  // 1. 备份 DB（非 dry-run 时）
  if (!dryRun) {
    const backupPath = `${dbPath}.backup-${Date.now()}`;
    fs.copyFileSync(dbPath, backupPath);
    console.log(`[backup] created ${backupPath}`);
  } else {
    console.log('[dry-run] no backup created');
  }

  const db = new Database(dbPath, { readonly: dryRun });
  console.log(`\n[mode] ${dryRun ? 'DRY-RUN (read-only)' : 'WRITE'}`);
  console.log(`[db] ${dbPath}`);

  // 2. 扫描所有 rule artifact
  const artifactsRaw = db
    .prepare('SELECT artifact_id, content_json FROM pi_artifacts WHERE artifact_kind = ?')
    .all('rule');
  // Runtime guard: better-sqlite3 returns unknown[]. Validate shape before use (rc-1/rc-2).
  const artifacts: Array<{ artifact_id: string; content_json: string }> = [];
  if (Array.isArray(artifactsRaw)) {
    for (const row of artifactsRaw) {
      if (
        typeof row === 'object' && row !== null
        && typeof (row as Record<string, unknown>).artifact_id === 'string'
        && typeof (row as Record<string, unknown>).content_json === 'string'
      ) {
        artifacts.push({
          artifact_id: (row as Record<string, string>).artifact_id,
          content_json: (row as Record<string, string>).content_json,
        });
      }
    }
  }
  console.log(`[scan] found ${artifacts.length} rule artifacts`);

  const fixes: FixRecord[] = [];
  const issues: Array<{ artifactId: string; issue: string }> = [];

  for (const art of artifacts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(art.content_json);
    } catch {
      issues.push({ artifactId: art.artifact_id, issue: 'content_json parse failed' });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;

    // 修复 goldenTrace.cases
    if (typeof obj.goldenTrace === 'object' && obj.goldenTrace !== null) {
      const trace = obj.goldenTrace as Record<string, unknown>;
      fixCasesArray(trace.cases, art.artifact_id, 'goldenTrace', fixes, issues);
    }

    // 修复 goldenTraceCases（artificer raw 输出副本）
    fixCasesArray(obj.goldenTraceCases, art.artifact_id, 'goldenTraceCases', fixes, issues);
  }

  // 3. 报告
  if (fixes.length === 0 && issues.length === 0) {
    console.log('\n[summary] no illegal expectedDecision values found. Nothing to fix.');
    db.close();
    return;
  }

  if (fixes.length > 0) {
    console.log(`\n[fixes] ${fixes.length} case(s) ${dryRun ? 'would be ' : ''}fixed across ${new Set(fixes.map((f) => f.artifactId)).size} artifact(s):`);
    for (const f of fixes) {
      console.log(`  ${f.artifactId} | ${f.field} | case=${f.caseId} kind=${f.kind}: ${f.from} → ${f.to}`);
    }
  } else {
    console.log('\n[fixes] 0 cases can be auto-fixed.');
  }

  if (issues.length > 0) {
    console.log(`\n[issues] ${issues.length} artifact(s) had parse issues or require manual review:`);
    for (const i of issues) console.log(`  ${i.artifactId}: ${i.issue}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] no changes written. Re-run with --write to apply.');
    db.close();
    return;
  }

  if (fixes.length === 0) {
    // Nothing to write — only issues (manual review). Don't open a transaction.
    db.close();
    return;
  }

  // 4. 应用修复 — 所有 UPDATE 在单个事务内执行，保证原子性 (all-or-nothing)
  let updatedCount = 0;
  const artifactsToFix = new Set(fixes.map((f) => f.artifactId));
  const applyTx = db.transaction(() => {
    for (const art of artifacts) {
      if (!artifactsToFix.has(art.artifact_id)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(art.content_json);
      } catch {
        continue;
      }
      // Runtime guard (rc-1/rc-2): validate parsed shape before use.
      if (typeof parsed !== 'object' || parsed === null) continue;
      const parsedObj = parsed as Record<string, unknown>;

      if (typeof parsedObj.goldenTrace === 'object' && parsedObj.goldenTrace !== null) {
        const trace = parsedObj.goldenTrace as Record<string, unknown>;
        fixCasesArray(trace.cases, art.artifact_id, 'goldenTrace', [], issues);
      }
      fixCasesArray(parsedObj.goldenTraceCases, art.artifact_id, 'goldenTraceCases', [], issues);

      const newContentJson = JSON.stringify(parsedObj);
      const result = db
        .prepare('UPDATE pi_artifacts SET content_json = ?, updated_at = ? WHERE artifact_id = ?')
        .run(newContentJson, new Date().toISOString(), art.artifact_id);
      if (result.changes > 0) updatedCount++;
    }
  });
  applyTx();

  console.log(`\n[summary] ${updatedCount} artifact row(s) updated (transaction committed)`);

  db.close();
}

main();
