#!/usr/bin/env node
/**
 * Core export-surface admission gate (P0: freeze the surface, block increments).
 *
 * WHY THIS EXISTS
 * `packages/principles-core` publishes 27 `package.json#exports` subpaths. The
 * names behind those subpaths are the package's public API, and they were
 * growing faster than real demand (audit: docs/reports/PD_CORE_EXPORT_SURFACE_RULE_DRAFT_20261112.md).
 * The existing PRI-775 guard freezes only two barrels via a regex extractor;
 * it cannot see the other 25 entries and it silently misses `export type X = ...`.
 *
 * WHAT IT DOES
 * - Parses every one of the 27 entry source files with the TypeScript AST.
 * - Compares the resulting symbol set per entry with a checked-in baseline
 *   (`export-surface-baseline.json`). Any added symbol needs an admission
 *   record, any removed symbol needs a removal record, any new subpath needs
 *   a `kind: "subpath"` admission. Expired exceptions fail unconditionally.
 *
 * WHY AST, NOT REGEX
 * Entry files that are not barrels (e.g. `./trajectory-types`, 31 symbols)
 * declare names with `export type X = ...`, which the PRI-775 regex does not
 * match. AST also removes the comment/whitespace edge cases the regex had to
 * patch by hand, and it fails loud on `export *` / default export, where a
 * name-set snapshot cannot prove anything.
 *
 * WHY THIS RUNS INSIDE THE EXISTING CORE TEST JOB
 * `Test principles-core` already runs vitest over `src/runtime/__tests__`.
 * A new CI process would add a separate checkout/install/startup cost for a
 * check that takes well under a second. The gate is invoked from
 * `src/runtime/__tests__/export-surface-admission.test.ts`, so it inherits the
 * existing job, logs and failure reporting.
 *
 * USAGE
 *   node scripts/check-core-export-surface.mjs                  # check (exit 1 on drift)
 *   node scripts/check-core-export-surface.mjs --write          # refresh the baseline
 *   node scripts/check-core-export-surface.mjs --baseline <f> --admissions <f>
 *   node scripts/check-core-export-surface.mjs --today 2027-01-01
 * Options exist so the guard test can replay failures against temp copies
 * without touching the checked-in fixtures.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, '..');
const CORE_REL = join('packages', 'principles-core');
const FIXTURE_REL = join('src', 'runtime', '__tests__', 'fixtures');

const MIN_WHY_NOT_INTERNAL = 40;
const MIN_ALTERNATIVE_CONSIDERED = 20;
const TEST_PATH_RE = /(^|\/)(tests|__tests__)(\/|$)/;
const PRI_RE = /^PRI-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Surface extraction ───────────────────────────────────────────────────────

function failLoud(file, message) {
  throw new Error(`core export surface: ${file}: ${message}`);
}

/**
 * Names a single entry source file exports. Throws instead of guessing when
 * the file uses a form whose surface cannot be proven from that file alone.
 */
export function extractEntrySymbols(filePath, sourceText) {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set();

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (!stmt.exportClause) {
        failLoud(filePath,
          '`export * from` detected. An entry point must enumerate exported names so the '
          + 'baseline can prove its surface; replace it with an explicit `export { ... }`.');
      }
      if (ts.isNamespaceExport(stmt.exportClause)) {
        names.add(stmt.exportClause.name.text);
        continue;
      }
      for (const el of stmt.exportClause.elements) {
        names.add(el.name.text);
      }
      continue;
    }

    if (ts.isExportAssignment(stmt)) {
      failLoud(filePath,
        '`export default` / `export =` detected. A name-set snapshot cannot describe it; '
        + 'use a named export.');
    }

    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      failLoud(filePath, 'default export detected; use a named export.');
    }
    for (const name of declaredNames(filePath, stmt)) names.add(name);
  }

  return [...names].sort();
}

function declaredNames(filePath, node) {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((decl) => {
      if (!ts.isIdentifier(decl.name)) {
        failLoud(filePath,
          'destructuring export detected; export each name individually so the baseline '
          + 'records a stable symbol list.');
      }
      return decl.name.text;
    });
  }
  if (
    ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)
    || ts.isModuleDeclaration(node)
  ) {
    if (!node.name || !ts.isIdentifier(node.name)) {
      failLoud(filePath, 'exported declaration without a plain identifier name.');
    }
    return [node.name.text];
  }
  failLoud(filePath,
    `unsupported exported statement (${ts.SyntaxKind[node.kind]}). Extend this extractor `
    + 'deliberately instead of freezing an unproven surface.');
}

function readPackageExports(coreDir) {
  const pkg = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf-8'));
  const out = [];
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (subpath === './package.json') continue;
    const typesPath = typeof target === 'string' ? target : target?.types;
    if (!typesPath) failLoud(join(coreDir, 'package.json'), `exports["${subpath}"] has no "types" target`);
    out.push({ subpath, typesPath });
  }
  return out;
}

/** `./dist/runtime/index.d.ts` -> `src/runtime/index.ts` */
function entrySourcePath(coreDir, subpath, typesPath) {
  const normalized = typesPath.replace(/^\.\//, '');
  if (!normalized.startsWith('dist/') || !normalized.endsWith('.d.ts')) {
    failLoud(join(coreDir, 'package.json'),
      `exports["${subpath}"].types = ${JSON.stringify(typesPath)} is not a ./dist/*.d.ts path; `
      + 'this gate cannot map it to the source file it freezes.');
  }
  const srcRel = `src/${normalized.slice('dist/'.length).replace(/\.d\.ts$/, '.ts')}`;
  const abs = join(coreDir, srcRel);
  if (!existsSync(abs)) failLoud(join(coreDir, 'package.json'),
    `exports["${subpath}"] maps to ${srcRel}, which does not exist.`);
  return { srcRel: srcRel.replaceAll('\\', '/'), abs };
}

export function collectSurface(repoRoot = DEFAULT_REPO_ROOT) {
  const coreDir = join(repoRoot, CORE_REL);
  const entries = {};
  const subpaths = [];

  for (const { subpath, typesPath } of readPackageExports(coreDir)) {
    const { srcRel, abs } = entrySourcePath(coreDir, subpath, typesPath);
    entries[subpath] = { source: srcRel, symbols: extractEntrySymbols(abs, readFileSync(abs, 'utf-8')) };
    subpaths.push(subpath);
  }

  return { subpaths: subpaths.sort(), entries };
}

// ── Admission rules ──────────────────────────────────────────────────────────

const KIND_VALUES = new Set(['value', 'type', 'subpath']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function admissionProblems(record, repoRoot, today) {
  const problems = [];
  if (!isNonEmptyString(record.entry)) problems.push('`entry` must be a subpath string (e.g. "./runtime")');
  if (!isNonEmptyString(record.symbol)) problems.push('`symbol` must be the exported name');
  if (!KIND_VALUES.has(record.kind)) problems.push('`kind` must be one of "value" | "type" | "subpath"');
  if (!PRI_RE.test(record.addedIn ?? '')) problems.push('`addedIn` must match PRI-<number> (e.g. "PRI-1234")');

  if (!Array.isArray(record.consumers) || record.consumers.length === 0) {
    problems.push('`consumers` must list at least one production path that imports this symbol');
  } else {
    for (const consumer of record.consumers) {
      if (!isNonEmptyString(consumer)) {
        problems.push('`consumers` entries must be non-empty file paths');
      } else if (TEST_PATH_RE.test(consumer)) {
        problems.push(`\`consumers\` entry ${JSON.stringify(consumer)} is a test path; `
          + 'test-only usage does not justify widening the public API');
      } else if (!existsSync(join(repoRoot, consumer))) {
        problems.push(`\`consumers\` entry ${JSON.stringify(consumer)} does not exist in the repo`);
      }
    }
  }

  if (typeof record.whyNotInternal !== 'string' || record.whyNotInternal.trim().length < MIN_WHY_NOT_INTERNAL) {
    problems.push(`\`whyNotInternal\` must explain why the symbol cannot stay internal `
      + `(>= ${MIN_WHY_NOT_INTERNAL} characters)`);
  }
  if (typeof record.alternativeConsidered !== 'string'
    || record.alternativeConsidered.trim().length < MIN_ALTERNATIVE_CONSIDERED) {
    problems.push(`\`alternativeConsidered\` must name the narrower option that was rejected `
      + `(>= ${MIN_ALTERNATIVE_CONSIDERED} characters)`);
  }

  if (record.exception !== undefined) {
    const exception = record.exception;
    if (!isNonEmptyString(exception.approvedBy)) problems.push('`exception.approvedBy` is required');
    if (!isNonEmptyString(exception.reason)) problems.push('`exception.reason` is required');
    if (!PRI_RE.test(exception.ticket ?? '')) problems.push('`exception.ticket` must match PRI-<number>');
    if (!DATE_RE.test(exception.expiresAt ?? '')) {
      problems.push('`exception.expiresAt` must be a YYYY-MM-DD date; an exception without an '
        + 'expiry is how a permanent hole gets created');
    } else if (exception.expiresAt < today) {
      problems.push(`exception expired on ${exception.expiresAt} (today is ${today}); `
        + 're-justify the export or narrow it — expiry is enforced, not remembered');
    }
  }

  return problems;
}

function removalProblems(record, repoRoot) {
  const problems = [];
  if (!isNonEmptyString(record.entry)) problems.push('`entry` must be a subpath string');
  if (!isNonEmptyString(record.symbol)) problems.push('`symbol` must be the removed name');
  if (!PRI_RE.test(record.removedIn ?? '')) problems.push('`removedIn` must match PRI-<number>');
  if (!isNonEmptyString(record.changeset)) {
    problems.push('`changeset` must point at the .changeset/*.md file that announces the removal');
  } else if (!existsSync(join(repoRoot, record.changeset))) {
    problems.push(`changeset ${JSON.stringify(record.changeset)} does not exist; removals need a `
      + 'release note, not just a deleted line');
  }
  return problems;
}

function indentRecord(record) {
  return JSON.stringify(record, null, 2).split('\n').map((line) => `      ${line}`).join('\n');
}

function addedExportMessage(entry, symbol) {
  return [
    `[added-export] ${entry} :: ${symbol}`,
    `  ${symbol} is not in the frozen baseline for ${entry} and has no admission record.`,
    '  Add this to packages/principles-core/src/runtime/__tests__/fixtures/export-admissions.json:',
    indentRecord({
      entry,
      symbol,
      kind: 'value',
      addedIn: 'PRI-1234',
      consumers: ['packages/<consumer>/src/<file>.ts'],
      whyNotInternal: '<why this cannot stay a core-internal symbol: >= 40 chars>',
      alternativeConsidered: '<narrower subpath / type-only export that was rejected: >= 20 chars>',
    }),
    '  If the only consumers are other packages in this repo, prefer a core-internal relative',
    '  import or a narrow subpath (see ./trajectory-types) instead of widening the barrel.',
  ].join('\n');
}

function removedExportMessage(entry, symbol) {
  return [
    `[removed-export] ${entry} :: ${symbol}`,
    `  ${symbol} was in the frozen baseline for ${entry} but is gone.`,
    '  Removals are breaking for npm consumers: record them under "removals" in',
    '  packages/principles-core/src/runtime/__tests__/fixtures/export-admissions.json',
    '  with `removedIn`, the removed name and the `.changeset/*.md` path that announces it.',
    '  A rename is "removal + admission", never a silent edit.',
  ].join('\n');
}

export function evaluateSurface({ surface, baseline, admissions, repoRoot = DEFAULT_REPO_ROOT, today }) {
  const errors = [];
  const warnings = [];
  const seen = new Set();

  const baselineEntries = new Map(baseline.entries.map((e) => [e.entry, e]));
  const baselineSubpaths = new Set(baseline.subpaths ?? []);
  const currentSubpaths = new Set(surface.subpaths);

  const admissionList = Array.isArray(admissions.admissions) ? admissions.admissions : [];
  const removalList = Array.isArray(admissions.removals) ? admissions.removals : [];

  // Every record is validated on every run: an expired exception must fail the
  // gate even on a PR that does not touch the export surface.
  const admissionKeys = new Set();
  for (const record of admissionList) {
    const key = `${record.entry}\u0000${record.symbol}\u0000${record.kind}`;
    if (admissionKeys.has(key)) {
      errors.push(`[admission] duplicate admission record for ${record.entry} :: ${record.symbol} (${record.kind})`);
    }
    admissionKeys.add(key);
    const problems = admissionProblems(record, repoRoot, today);
    if (problems.length > 0) {
      errors.push([
        `[admission] ${record.entry ?? '<missing entry>'} :: ${record.symbol ?? '<missing symbol>'}`,
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'));
    }
    if (isNonEmptyString(record.entry) && record.kind !== 'subpath'
      && !currentSubpaths.has(record.entry) && !baselineSubpaths.has(record.entry)) {
      errors.push(`[admission] ${record.entry} :: ${record.symbol}: entry does not exist in `
        + 'package.json#exports. Delete the stale record or fix the subpath.');
    }
  }
  for (const record of removalList) {
    const problems = removalProblems(record, repoRoot);
    if (problems.length > 0) {
      errors.push([
        `[removal] ${record.entry ?? '<missing entry>'} :: ${record.symbol ?? '<missing symbol>'}`,
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'));
    }
  }

  // Subpath freeze: `package.json#exports` is a contract, not an internal map.
  for (const subpath of currentSubpaths) {
    if (baselineSubpaths.has(subpath)) continue;
    const admitted = admissionList.some((r) => r.kind === 'subpath' && r.entry === subpath);
    if (!admitted) {
      errors.push([
        `[new-subpath] ${subpath}`,
        '  A new public entry point appeared in packages/principles-core/package.json#exports.',
        '  Add a `kind: "subpath"` admission (entry and symbol both set to the subpath) and have the',
        '  owner approve it; every new subpath is a permanent compatibility promise.',
      ].join('\n'));
    }
  }
  for (const subpath of baselineSubpaths) {
    if (currentSubpaths.has(subpath)) continue;
    const recorded = removalList.some((r) => r.entry === subpath && r.symbol === subpath);
    if (!recorded) {
      errors.push([
        `[removed-subpath] ${subpath}`,
        '  A public entry point disappeared from package.json#exports.',
        '  Record it under "removals" (entry and symbol both set to the subpath) with a changeset;',
        '  downstream pins resolve subpaths, so a vanished subpath breaks them loudly.',
      ].join('\n'));
    }
  }

  // Symbol freeze per existing entry.
  for (const [entry, current] of Object.entries(surface.entries)) {
    const frozen = baselineEntries.get(entry);
    if (!frozen) continue; // new subpath: covered by the subpath admission above

    const frozenNames = new Set(frozen.symbols);
    const currentNames = new Set(current.symbols);

    for (const symbol of current.symbols) {
      if (frozenNames.has(symbol) || seen.has(`${entry}\u0000${symbol}`)) continue;
      const admitted = admissionList.some(
        (r) => r.kind !== 'subpath' && r.entry === entry && r.symbol === symbol,
      );
      if (!admitted) {
        seen.add(`${entry}\u0000${symbol}`);
        errors.push(addedExportMessage(entry, symbol));
      } else {
        warnings.push(`${entry} :: ${symbol} is admitted but not yet in the baseline; `
          + 'run `node scripts/check-core-export-surface.mjs --write` in the same PR.');
      }
    }

    for (const symbol of frozen.symbols) {
      if (currentNames.has(symbol) || seen.has(`${entry}\u0000${symbol}`)) continue;
      const recorded = removalList.some((r) => r.entry === entry && r.symbol === symbol);
      if (!recorded) {
        seen.add(`${entry}\u0000${symbol}`);
        errors.push(removedExportMessage(entry, symbol));
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Baseline file ────────────────────────────────────────────────────────────

export function buildBaseline(surface) {
  return {
    schemaVersion: 1,
    generatedBy: 'node scripts/check-core-export-surface.mjs --write',
    subpaths: surface.subpaths,
    entries: Object.entries(surface.entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([entry, value]) => ({
        entry,
        source: value.source,
        count: value.symbols.length,
        symbols: value.symbols,
      })),
  };
}

function baselineSelfCheck(baseline) {
  const problems = [];
  const seenEntries = new Set();
  for (const entry of baseline.entries) {
    if (seenEntries.has(entry.entry)) problems.push(`duplicate baseline entry ${entry.entry}`);
    seenEntries.add(entry.entry);
    if (entry.count !== entry.symbols.length) {
      problems.push(`${entry.entry}: "count" (${entry.count}) != symbols.length (${entry.symbols.length}); regenerate with --write`);
    }
    const sorted = [...entry.symbols].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(entry.symbols)) {
      problems.push(`${entry.entry}: symbols are not sorted; regenerate with --write`);
    }
    if (new Set(entry.symbols).size !== entry.symbols.length) {
      problems.push(`${entry.entry}: duplicate symbols in baseline`);
    }
  }
  return problems;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    write: false,
    repoRoot: DEFAULT_REPO_ROOT,
    baselinePath: null,
    admissionsPath: null,
    today: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--repo-root') opts.repoRoot = resolve(argv[++i]);
    else if (arg === '--baseline') opts.baselinePath = resolve(argv[++i]);
    else if (arg === '--admissions') opts.admissionsPath = resolve(argv[++i]);
    else if (arg === '--today') opts.today = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  const fixtureDir = join(opts.repoRoot, CORE_REL, FIXTURE_REL);
  opts.baselinePath ??= join(fixtureDir, 'export-surface-baseline.json');
  opts.admissionsPath ??= join(fixtureDir, 'export-admissions.json');
  return opts;
}

function summarize(surface) {
  const all = new Set();
  let total = 0;
  for (const value of Object.values(surface.entries)) {
    total += value.symbols.length;
    for (const symbol of value.symbols) all.add(symbol);
  }
  return { entryCount: surface.subpaths.length, total, unique: all.size };
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('usage: node scripts/check-core-export-surface.mjs [--write] [--baseline <file>] '
      + '[--admissions <file>] [--repo-root <dir>] [--today YYYY-MM-DD]');
    return 0;
  }

  const surface = collectSurface(opts.repoRoot);
  const stats = summarize(surface);

  if (opts.write) {
    const baseline = buildBaseline(surface);
    writeFileSync(opts.baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
    console.log(`wrote ${opts.baselinePath}`);
    console.log(`  ${stats.entryCount} entry points, ${stats.total} symbol slots, ${stats.unique} unique symbols`);
    for (const entry of baseline.entries) {
      console.log(`  ${entry.entry.padEnd(48)} ${String(entry.count).padStart(5)}  ${entry.source}`);
    }
    return 0;
  }

  if (!existsSync(opts.baselinePath)) {
    console.error(`core export surface: baseline ${opts.baselinePath} is missing. `
      + 'Run `node scripts/check-core-export-surface.mjs --write` and commit the result.');
    return 1;
  }
  if (!existsSync(opts.admissionsPath)) {
    console.error(`core export surface: admissions file ${opts.admissionsPath} is missing.`);
    return 1;
  }

  const baseline = JSON.parse(readFileSync(opts.baselinePath, 'utf-8'));
  const admissions = JSON.parse(readFileSync(opts.admissionsPath, 'utf-8'));

  const selfCheck = baselineSelfCheck(baseline);
  if (selfCheck.length > 0) {
    console.error('core export surface: baseline file is malformed:');
    for (const problem of selfCheck) console.error(`  - ${problem}`);
    return 1;
  }

  const result = evaluateSurface({
    surface,
    baseline,
    admissions,
    repoRoot: opts.repoRoot,
    today: opts.today,
  });

  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  if (!result.ok) {
    console.error(`core export surface: ${result.errors.length} blocking issue(s)\n`);
    for (const error of result.errors) console.error(error);
    console.error('\nRule: packages/principles-core public symbols are frozen. New symbols need an '
      + 'admission record; removals need a removal record + changeset; new subpaths need owner '
      + 'approval. See docs/reports/PD_CORE_EXPORT_SURFACE_RULE_DRAFT_20261112.md.');
    return 1;
  }

  console.log(`core export surface: ${stats.entryCount} entry points, ${stats.total} symbol slots, `
    + `${stats.unique} unique symbols — matches the frozen baseline (0 added, 0 removed).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
