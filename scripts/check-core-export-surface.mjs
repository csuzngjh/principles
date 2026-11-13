#!/usr/bin/env node
/**
 * Core export-surface admission gate (P0: freeze the surface, block increments).
 *
 * WHY THIS EXISTS
 * `packages/principles-core` publishes 27 `package.json#exports` subpaths. The
 * names behind those subpaths are the package's public API, and they were
 * growing faster than real demand (audit: docs/reports/PD_CORE_EXPORT_SURFACE_RULE_DRAFT_20261112.md).
 * PRI-775 froze only two barrels via a regex extractor; it cannot see the other
 * 25 entries and it silently misses `export type X = ...`.
 *
 * THE REFERENCE IS GIT, NOT THE WORKING COPY
 * The baseline JSON lives in the same commit as the code it describes, so a
 * gate that compares "source vs baseline file" can be satisfied by editing the
 * baseline (`--write`) in the same PR. That is self-certification, not a gate.
 * The reference surface is therefore read from the base commit
 * (`git merge-base origin/main HEAD`), and every diff against it needs an
 * admission or a removal record:
 *
 *   surface(worktree) == surface(base) + admitted additions - recorded removals
 *
 * The checked-in baseline is kept as the human-readable record and as the seed
 * for the commit that introduces it (no base baseline exists yet); it is never
 * the authority on its own.
 *
 * NO BACKDOORS
 * The CLI exposes only `--check` (default) and `--write`. There is deliberately
 * no way to substitute the reference from the command line: no `--anchor-ref`
 * to an arbitrary commit, no `--anchor-baseline` file, no `--today`, no
 * environment-variable opt-in. `--anchor-ref` accepts exactly the base ref
 * (origin/main) and is refused in CI together with `--write`.
 * CI detection does not trust `GITHUB_ACTIONS` alone: any of
 * GITHUB_WORKFLOW / GITHUB_RUN_ID / GITHUB_SHA / GITHUB_ACTIONS / CI marks the
 * process as CI, so unsetting one variable changes nothing.
 * Failure-path tests call the exported functions below in-process with
 * constructed objects; nothing in the test path can be replayed through argv.
 *
 * WHAT IT BLOCKS
 * - a public symbol that is new relative to the base                    -> needs an admission
 * - a public symbol that disappeared relative to the base               -> needs a removal + changeset
 * - a new `package.json#exports` subpath                                -> needs a subpath admission
 *                                                                          AND one admission per exported symbol
 * - `export *` / default export on an entry                             -> fail loud, surface unprovable
 * - an admission that predates its symbol (split-PR pre-placement)      -> rejected
 * - an admission whose `consumers` import but never use the symbol      -> rejected
 * - an admission without `expiresAt`, or past it                        -> rejected
 * - a removal whose changeset already existed at the base commit        -> rejected
 *
 * CONSUMER USAGE POINTS (PRI-1197)
 * A named import is evidence only when its local binding is read somewhere in
 * the same file; type positions count, aliases are resolved to the local name.
 * Re-exports remain direct evidence (they forward the symbol), namespace
 * imports are proven via `ns.X` access. Test paths are rejected as consumers,
 * and dynamic `import()` / `require()` cannot statically prove a named symbol,
 * so neither is accepted. The false-positive / false-negative trade-off list
 * lives in docs/reports/PD_CORE_EXPORT_CONSUMER_USAGE_TRADEOFFS_20261113.md.
 *
 * WHY AST, NOT REGEX
 * Entry files that are not barrels (e.g. `./trajectory-types`, 31 symbols)
 * declare names with `export type X = ...`, which the PRI-775 regex does not
 * match. AST also fails loud on `export *` / default export, where a name-set
 * snapshot cannot prove anything.
 *
 * WHY THIS RUNS INSIDE THE EXISTING CORE TEST JOB
 * `Test principles-core` already runs vitest over `src/runtime/__tests__` and
 * is a required check on main. A separate CI process would add a checkout and
 * install for a check that takes well under a second.
 *
 * USAGE
 *   node scripts/check-core-export-surface.mjs                  # check (exit 1 on drift)
 *   node scripts/check-core-export-surface.mjs --write          # re-record an approved surface
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CORE_REL = join('packages', 'principles-core');
const BASELINE_REL = 'packages/principles-core/src/runtime/__tests__/fixtures/export-surface-baseline.json';
const ADMISSIONS_REL = 'packages/principles-core/src/runtime/__tests__/fixtures/export-admissions.json';
const BASELINE_PATH = join(REPO_ROOT, BASELINE_REL);
const ADMISSIONS_PATH = join(REPO_ROOT, ADMISSIONS_REL);

const BASE_REF = 'origin/main';
const BASE_REF_ALIASES = new Set([BASE_REF, `refs/remotes/${BASE_REF}`]);
const CI_MARKERS = ['GITHUB_WORKFLOW', 'GITHUB_RUN_ID', 'GITHUB_SHA', 'GITHUB_ACTIONS', 'CI'];

const MIN_WHY_NOT_INTERNAL = 40;
const MIN_ALTERNATIVE_CONSIDERED = 20;
const TEST_PATH_RE = /(^|\/)(tests|__tests__)(\/|$)/;
const PRI_RE = /^PRI-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ADMISSIONS_SCHEMA_VERSION = 2;

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

export function collectSurface(repoRoot = REPO_ROOT) {
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

// ── Consumer proof ───────────────────────────────────────────────────────────

/** `@@principles/core` specifier for an entry: '.' -> '@principles/core'. */
export function entrySpecifier(entry) {
  return entry === '.' ? '@principles/core' : `@principles/core${entry.slice(1)}`;
}

function moduleImports(repoRoot, consumerPath, specifier) {
  const abs = join(repoRoot, consumerPath);
  const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Exported name -> local binding name. `import { X as Y }` is used as `Y`,
  // so a usage-point check must look for the LOCAL name, not the exported one.
  const imported = new Map();
  // Re-exports stay direct evidence: they forward the symbol rather than read
  // it, so a usage-point check does not apply (pre-existing contract, PRI-1197).
  const reExported = new Set();
  const namespaces = new Set();
  let anyFromSpecifier = false;

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.moduleSpecifier.text !== specifier) continue;
      anyFromSpecifier = true;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          imported.set((el.propertyName ?? el.name).text, el.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier?.text === specifier) {
      anyFromSpecifier = true;
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) reExported.add((el.propertyName ?? el.name).text);
      }
    }
  }

  return { imported, reExported, namespaces, anyFromSpecifier, sourceFile: sf };
}

/**
 * Whether `localName` is read at least once anywhere in `sourceFile`.
 *
 * Type positions COUNT: a type-only export is consumed in a type reference,
 * and `kind: 'type'` admissions exist for exactly that. What does not count is
 * a binding or a label — the import/export specifier that declares the name,
 * an object key, a property access name, or a local declaration of the same
 * name. Those are names being introduced, not the imported symbol being used.
 */
function hasUsagePoint(sourceFile, localName) {
  const isBindingOrKey = (node) => {
    const p = node.parent;
    if (!p) return true;
    if (ts.isImportDeclaration(p) || ts.isImportClause(p) || ts.isImportSpecifier(p)
      || ts.isNamespaceImport(p) || ts.isExportDeclaration(p) || ts.isExportSpecifier(p)) return true;
    if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === node) return true;
    if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p))
      && p.name === node) return true;
    if ((ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isBindingElement(p)
      || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)
      || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p)) && p.name === node) return true;
    return false;
  };

  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === localName && !isBindingOrKey(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function consumerProof(repoRoot, consumerPath, symbol, entry) {
  const specifier = entrySpecifier(entry);
  const { imported, reExported, namespaces, anyFromSpecifier, sourceFile } =
    moduleImports(repoRoot, consumerPath, specifier);

  if (reExported.has(symbol)) return { ok: true };

  if (imported.has(symbol)) {
    return hasUsagePoint(sourceFile, imported.get(symbol))
      ? { ok: true }
      : { ok: false, anyFromSpecifier, specifier, importedButUnused: true };
  }

  for (const namespace of namespaces) {
    let used = false;
    const visit = (node) => {
      if (used) return;
      if (
        ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === namespace
        && node.name.text === symbol
      ) {
        used = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (used) return { ok: true };
  }

  return { ok: false, anyFromSpecifier, specifier, importedButUnused: false };
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

  if (!DATE_RE.test(record.expiresAt ?? '')) {
    problems.push('`expiresAt` must be a YYYY-MM-DD date. Every admission expires: an export that '
      + 'cannot name a date at which it will be re-justified is a permanent hole.');
  } else if (record.expiresAt < today) {
    problems.push(`admission expired on ${record.expiresAt} (today is ${today}); re-justify the `
      + 'export or narrow it — expiry is enforced, not remembered');
  }

  if (!Array.isArray(record.consumers) || record.consumers.length === 0) {
    problems.push('`consumers` must list at least one production path that imports this symbol');
  } else {
    for (const consumer of record.consumers) {
      if (!isNonEmptyString(consumer)) {
        problems.push('`consumers` entries must be non-empty file paths');
        continue;
      }
      if (TEST_PATH_RE.test(consumer)) {
        problems.push(`\`consumers\` entry ${JSON.stringify(consumer)} is a test path; `
          + 'test-only usage does not justify widening the public API');
        continue;
      }
      if (!existsSync(join(repoRoot, consumer))) {
        problems.push(`\`consumers\` entry ${JSON.stringify(consumer)} does not exist in the repo`);
        continue;
      }
      if (record.kind === 'subpath' || !isNonEmptyString(record.symbol) || !isNonEmptyString(record.entry)) {
        continue;
      }
      const proof = consumerProof(repoRoot, consumer, record.symbol, record.entry);
      if (!proof.ok) {
        if (proof.importedButUnused) {
          problems.push(`\`consumers\` entry ${JSON.stringify(consumer)} imports `
            + `${JSON.stringify(record.symbol)} from ${JSON.stringify(proof.specifier)} but never uses it; `
            + 'an import with no usage point does not justify widening the public API');
        } else {
          problems.push(`\`consumers\` entry ${JSON.stringify(consumer)} does not import `
            + `${JSON.stringify(record.symbol)} from ${JSON.stringify(proof.specifier)}; `
            + (proof.anyFromSpecifier
              ? 'it imports from that entry but not this symbol'
              : 'it does not import from that entry at all'));
        }
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
    if (exception.expiresAt !== undefined && exception.expiresAt !== record.expiresAt) {
      problems.push('`exception.expiresAt` must equal the admission-level `expiresAt` '
        + '(one expiry per record, not two)');
    }
  }

  return problems;
}

function removalProblems(record, repoRoot, baseChangesets) {
  const problems = [];
  if (!isNonEmptyString(record.entry)) problems.push('`entry` must be a subpath string');
  if (!isNonEmptyString(record.symbol)) problems.push('`symbol` must be the removed name');
  if (!PRI_RE.test(record.removedIn ?? '')) problems.push('`removedIn` must match PRI-<number>');
  if (!isNonEmptyString(record.changeset)) {
    problems.push('`changeset` must point at the .changeset/*.md file that announces the removal');
  } else if (!existsSync(join(repoRoot, record.changeset))) {
    problems.push(`changeset ${JSON.stringify(record.changeset)} does not exist; removals need a `
      + 'release note, not just a deleted line');
  } else if (baseChangesets.has(record.changeset)) {
    problems.push(`changeset ${JSON.stringify(record.changeset)} already exists at the base commit; `
      + 'a removal needs a changeset that this PR adds, otherwise an unrelated old note can '
      + 'announce a breaking change it never described');
  }
  return problems;
}

function indentRecord(record) {
  return JSON.stringify(record, null, 2).split('\n').map((line) => `      ${line}`).join('\n');
}

function addedExportMessage(entry, symbol, anchorLabel) {
  return [
    `[added-export] ${entry} :: ${symbol}`,
    `  ${symbol} is public now but was not public in ${anchorLabel}, and no admission record covers it.`,
    '  Add this to packages/principles-core/src/runtime/__tests__/fixtures/export-admissions.json:',
    indentRecord({
      entry,
      symbol,
      kind: 'value',
      addedIn: 'PRI-1234',
      expiresAt: 'YYYY-MM-DD',
      consumers: ['packages/<consumer>/src/<file>.ts'],
      whyNotInternal: '<why this cannot stay a core-internal symbol: >= 40 chars>',
      alternativeConsidered: '<narrower subpath / type-only export that was rejected: >= 20 chars>',
    }),
    '  `consumers` must be files that import AND USE this symbol from this entry — they are parsed.',
    '  If the only consumers are other packages in this repo, prefer a core-internal relative',
    '  import or a narrow subpath (see ./trajectory-types) instead of widening the barrel.',
    '  Re-recording the checked-in baseline does not clear this: the reference is the base commit.',
  ].join('\n');
}

function removedExportMessage(entry, symbol) {
  return [
    `[removed-export] ${entry} :: ${symbol}`,
    `  ${symbol} is public in the base commit but is gone now.`,
    '  Removals are breaking for npm consumers: record them under "removals" in',
    '  packages/principles-core/src/runtime/__tests__/fixtures/export-admissions.json',
    '  with `removedIn`, the removed name and the `.changeset/*.md` path that announces it.',
    '  A rename is "removal + admission", never a silent edit.',
  ].join('\n');
}

export function evaluateSurface({
  surface,
  baseline,
  anchor,
  admissions,
  anchorAdmissions,
  anchorLabel,
  baseChangesets,
  repoRoot = REPO_ROOT,
  today = new Date().toISOString().slice(0, 10),
}) {
  const errors = [];
  const admitted = [];
  const removed = [];

  const anchorEntries = new Map(anchor.entries.map((e) => [e.entry, new Set(e.symbols)]));
  const anchorSubpaths = new Set(anchor.subpaths ?? []);
  const currentSubpaths = new Set(surface.subpaths);

  const admissionList = Array.isArray(admissions.admissions) ? admissions.admissions : [];
  const removalList = Array.isArray(admissions.removals) ? admissions.removals : [];
  const anchorAdmissionKeys = new Set(
    (Array.isArray(anchorAdmissions?.admissions) ? anchorAdmissions.admissions : [])
      .map((r) => `${r.entry}\u0000${r.symbol}\u0000${r.kind}`),
  );

  // Every record is validated on every run, so expiry does not wait for someone
  // to touch the export surface.
  const admissionKeys = new Set();
  for (const record of admissionList) {
    const key = `${record.entry}\u0000${record.symbol}\u0000${record.kind}`;
    if (admissionKeys.has(key)) {
      errors.push(`[admission] duplicate admission record for ${record.entry} :: ${record.symbol} (${record.kind})`);
    }
    admissionKeys.add(key);

    const problems = admissionProblems(record, repoRoot, today);

    // A record must point at something real. If the symbol was public in the
    // base and is public now, the record is historical and harmless.
    const symbolExistsNow = record.kind === 'subpath'
      ? currentSubpaths.has(record.entry)
      : surface.entries[record.entry]?.symbols.includes(record.symbol);
    const symbolExistedAtAnchor = record.kind === 'subpath'
      ? anchorSubpaths.has(record.entry)
      : anchorEntries.get(record.entry)?.has(record.symbol);

    // Pre-placement: the record already existed at the base commit while the
    // symbol did not. Allowing it would let a PR land an empty admission first
    // and the export later, which is the same bypass by another name. A
    // subpath record names the entry itself, so it must be checked against
    // `anchorSubpaths`; comparing it to the entry's symbol set is always false
    // and would reject every base-branch push.
    if (anchorAdmissionKeys.has(key) && !symbolExistedAtAnchor) {
      problems.push('this record already existed in the base commit while the symbol was not public '
        + 'there; an admission must land in the same PR that introduces the symbol');
    }
    if (!symbolExistsNow && !symbolExistedAtAnchor) {
      problems.push('the symbol exists neither at the base commit nor in the current surface; '
        + 'an admission must describe a symbol this PR actually makes public');
    }

    if (problems.length > 0) {
      errors.push([
        `[admission] ${record.entry ?? '<missing entry>'} :: ${record.symbol ?? '<missing symbol>'}`,
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'));
    }
  }
  for (const record of removalList) {
    const problems = removalProblems(record, repoRoot, baseChangesets);
    if (problems.length > 0) {
      errors.push([
        `[removal] ${record.entry ?? '<missing entry>'} :: ${record.symbol ?? '<missing symbol>'}`,
        ...problems.map((p) => `  - ${p}`),
      ].join('\n'));
    }
  }

  const admittedRecords = new Map(
    admissionList
      .filter((r) => r.kind !== 'subpath')
      .map((r) => [`${r.entry}\u0000${r.symbol}`, r]),
  );
  const subpathAdmissions = new Map(
    admissionList.filter((r) => r.kind === 'subpath').map((r) => [r.entry, r]),
  );

  // Subpath freeze: `package.json#exports` is a contract, not an internal map.
  for (const subpath of currentSubpaths) {
    if (anchorSubpaths.has(subpath)) continue;
    const approval = subpathAdmissions.get(subpath);
    if (!approval) {
      errors.push([
        `[new-subpath] ${subpath}`,
        `  A new public entry point appeared in packages/principles-core/package.json#exports.`,
        '  Add a `kind: "subpath"` admission (entry and symbol both set to the subpath) and have the',
        '  owner approve it; every new subpath is a permanent compatibility promise.',
        '  One subpath record is not enough on its own: every symbol it exposes also needs its own',
        '  admission, because a barrel pointing at a wide module would otherwise ship thousands of',
        '  public names behind a single line.',
      ].join('\n'));
      continue;
    }

    // A new subpath is itself a new public name, so the subpath approval and
    // every symbol behind it are reported through `admitted` — the summary must
    // name each delta item, not just count it.
    admitted.push({ entry: subpath, symbol: subpath, record: approval });
    for (const symbol of surface.entries[subpath].symbols) {
      const record = admittedRecords.get(`${subpath}\u0000${symbol}`);
      if (!record) {
        errors.push([
          `[new-subpath-symbol] ${subpath} :: ${symbol}`,
          `  ${subpath} is a new entry point, so ${symbol} becomes public through it.`,
          '  Add one value/type admission per exported symbol (entry = the new subpath). A single',
          '  subpath record is the owner approval, not the symbol inventory.',
        ].join('\n'));
      } else {
        admitted.push({ entry: subpath, symbol, record });
      }
    }
  }
  for (const subpath of anchorSubpaths) {
    if (currentSubpaths.has(subpath)) continue;
    const record = removalList.find((r) => r.entry === subpath && r.symbol === subpath);
    if (!record) {
      errors.push([
        `[removed-subpath] ${subpath}`,
        '  A public entry point disappeared from package.json#exports.',
        '  Record it under "removals" (entry and symbol both set to the subpath) with a changeset;',
        '  downstream pins resolve subpaths, so a vanished subpath breaks them loudly.',
      ].join('\n'));
    } else {
      removed.push({ entry: subpath, symbol: subpath, record });
    }
  }

  // Symbol freeze per entry that exists on both sides. New subpaths are handled
  // above; removed subpaths are covered by their removal record.
  for (const [entry, current] of Object.entries(surface.entries)) {
    const anchorNames = anchorEntries.get(entry);
    if (!anchorNames) continue;
    const currentNames = new Set(current.symbols);

    for (const symbol of current.symbols) {
      if (anchorNames.has(symbol)) continue;
      const record = admittedRecords.get(`${entry}\u0000${symbol}`);
      if (!record) {
        errors.push(addedExportMessage(entry, symbol, anchorLabel));
      } else {
        admitted.push({ entry, symbol, record });
      }
    }
    for (const symbol of anchorNames) {
      if (currentNames.has(symbol)) continue;
      const record = removalList.find((r) => r.entry === entry && r.symbol === symbol);
      if (!record) {
        errors.push(removedExportMessage(entry, symbol));
      } else {
        removed.push({ entry, symbol, record });
      }
    }
  }

  // The checked-in record must describe the current surface, otherwise it lies
  // to the next reader. This is a bookkeeping error, not an API decision.
  const drift = baselineDrift(baseline, surface);
  if (drift.length > 0) {
    errors.push([
      '[baseline] the checked-in baseline no longer matches the current surface:',
      ...drift.map((d) => `  - ${d}`),
      '  Run `node scripts/check-core-export-surface.mjs --write` once the admission/removal',
      '  records above are in place, so the record matches what the gate just approved.',
    ].join('\n'));
  }

  return {
    ok: errors.length === 0,
    errors,
    admitted,
    removed,
    delta: computeDelta(anchor, surface),
  };
}

function baselineDrift(baseline, surface) {
  const drift = [];
  const baselineEntries = new Map(baseline.entries.map((e) => [e.entry, new Set(e.symbols)]));
  const currentEntries = new Map(Object.entries(surface.entries).map(([e, v]) => [e, new Set(v.symbols)]));

  for (const [entry, symbols] of currentEntries) {
    const recorded = baselineEntries.get(entry);
    if (!recorded) {
      drift.push(`${entry} is missing from the baseline`);
      continue;
    }
    const missing = [...symbols].filter((s) => !recorded.has(s));
    const extra = [...recorded].filter((s) => !symbols.has(s));
    if (missing.length > 0) drift.push(`${entry}: baseline is missing ${missing.join(', ')}`);
    if (extra.length > 0) drift.push(`${entry}: baseline still lists ${extra.join(', ')}`);
  }
  for (const entry of baselineEntries.keys()) {
    if (!currentEntries.has(entry)) drift.push(`${entry} is in the baseline but no longer an entry point`);
  }
  return drift;
}

/**
 * The individual names that differ between the reference and the current
 * surface. Exported so the guard test can assert the invariant "exit 0 iff
 * every one of these is accounted for" instead of pinning a fixed string.
 */
export function surfaceDelta(anchor, surface) {
  const added = [];
  const removed = [];
  const anchorSubpaths = new Set(anchor.subpaths ?? []);

  for (const [entry, value] of Object.entries(surface.entries)) {
    const before = new Set(anchor.entries.find((e) => e.entry === entry)?.symbols ?? []);
    const now = new Set(value.symbols);
    for (const symbol of now) if (!before.has(symbol)) added.push({ entry, symbol });
    for (const symbol of before) if (!now.has(symbol)) removed.push({ entry, symbol });
  }
  for (const entry of Object.keys(surface.entries)) {
    if (!anchorSubpaths.has(entry)) added.push({ entry, symbol: entry }); // a new entry point is itself a new public name
  }
  for (const entry of anchorSubpaths) {
    if (!(entry in surface.entries)) removed.push({ entry, symbol: entry });
  }
  return { added, removed };
}

function computeDelta(anchor, surface) {
  const delta = surfaceDelta(anchor, surface);
  return { added: delta.added.length, removed: delta.removed.length };
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

// ── Git anchor ───────────────────────────────────────────────────────────────

function git(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function readAtCommit(repoRoot, commit, relPath) {
  const raw = git(repoRoot, ['show', `${commit}:${relPath}`]);
  return raw === null || raw === '' ? null : raw;
}

/** One `git cat-file --batch` for many blobs: 27 spawns would cost ~0.5 s on Windows. */
function readManyAtCommit(repoRoot, specs) {
  if (specs.length === 0) return new Map();
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input: specs.map((spec) => `${spec}\n`).join(''),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = new Map();
  let offset = 0;
  for (const spec of specs) {
    const newline = out.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = out.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (header.endsWith(' missing')) {
      result.set(spec, null);
      continue;
    }
    const size = Number(header.split(' ')[2]);
    result.set(spec, out.subarray(offset, offset + size).toString('utf8'));
    offset += size + 1;
  }
  return result;
}

/**
 * Surface as it existed at a commit. Used when the base commit predates the
 * baseline file: the reference must come from the base tree, never from the
 * working copy, or re-recording the baseline would be a bypass.
 */
export function surfaceAtCommit(repoRoot, commit) {
  const pkgSpec = `${commit}:packages/principles-core/package.json`;
  const pkgRaw = readManyAtCommit(repoRoot, [pkgSpec]).get(pkgSpec);
  if (!pkgRaw) return null;

  const pkg = JSON.parse(pkgRaw);
  const meta = [];
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (subpath === './package.json') continue;
    const typesPath = typeof target === 'string' ? target : target?.types;
    if (!typesPath) continue;
    const normalized = typesPath.replace(/^\.\//, '');
    if (!normalized.startsWith('dist/') || !normalized.endsWith('.d.ts')) continue;
    const srcRel = `src/${normalized.slice('dist/'.length).replace(/\.d\.ts$/, '.ts')}`;
    meta.push({ subpath, source: srcRel, spec: `${commit}:packages/principles-core/${srcRel}` });
  }

  const blobs = readManyAtCommit(repoRoot, meta.map((m) => m.spec));
  const entries = [];
  for (const item of meta) {
    const source = blobs.get(item.spec);
    if (source === null || source === undefined) {
      failLoud(`${commit}:packages/principles-core/${item.source}`,
        'entry point existed at the base commit but its source file is missing; '
        + 'the reference surface cannot be computed.');
    }
    const symbols = extractEntrySymbols(item.spec, source);
    entries.push({ entry: item.subpath, source: item.source, count: symbols.length, symbols });
  }

  return {
    subpaths: meta.map((m) => m.subpath).sort(),
    entries: entries.sort((a, b) => a.entry.localeCompare(b.entry)),
  };
}

/**
 * Resolve the reference commit.
 *
 * Only the base branch is accepted as an explicit ref: an arbitrary SHA —
 * including a SHA from the base branch's own history — is refused, because it
 * lets a PR pick the comparison point that makes its own additions disappear.
 * The default is always `origin/main`.
 */
export function resolveAnchor(repoRoot, explicitRef = BASE_REF) {
  if (!BASE_REF_ALIASES.has(explicitRef)) {
    return {
      error: `core export surface: --anchor-ref ${JSON.stringify(explicitRef)} is not allowed. `
        + `Only the base branch (${BASE_REF}) is a valid reference; arbitrary commits — including `
        + 'SHAs taken from the base branch history — let a PR choose a comparison point that '
        + 'hides its own additions.',
    };
  }

  const tip = git(repoRoot, ['rev-parse', '--verify', `${BASE_REF}^{commit}`]);
  if (!tip) {
    return {
      error: [
        `core export surface: cannot resolve ${BASE_REF}.`,
        '  The gate compares against a ref the PR cannot rewrite; falling back to the',
        '  working-copy baseline would make --write a bypass.',
        '  Fetch the base first (`git fetch origin main`).',
      ].join('\n'),
    };
  }

  const head = git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head) return { error: 'core export surface: cannot resolve HEAD.' };

  if (head === tip) {
    // Push build on the base branch: the worktree IS the base tip, so the
    // comparison is real (surface vs itself) and the baseline drift check still
    // runs. This is not a self-graded PR diff.
    return { ref: BASE_REF, commit: head, onBaseBranch: true };
  }

  const base = git(repoRoot, ['merge-base', BASE_REF, 'HEAD']);
  if (!base) return { error: `core export surface: cannot compute merge-base(${BASE_REF}, HEAD).` };
  if (base === head) {
    return {
      error: [
        'core export surface: the anchor resolves to HEAD.',
        `  ${BASE_REF} is ${tip.slice(0, 8)} and HEAD is ${head.slice(0, 8)}, but their merge-base`,
        '  is HEAD itself: this branch has no unmerged history, so comparing against the base',
        '  would grade the commit it is trying to check. Rebase or add the commits you mean to test.',
      ].join('\n'),
    };
  }

  return { ref: BASE_REF, commit: base, onBaseBranch: false };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function isCi(env = process.env) {
  return CI_MARKERS.some((marker) => Boolean(env[marker]));
}

function parseArgs(argv, env) {
  const opts = { write: false, anchorRef: BASE_REF, anchorRefProvided: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--anchor-ref') {
      opts.anchorRef = argv[++i];
      opts.anchorRefProvided = true;
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}. The gate accepts only `
      + '--write and (outside CI) --anchor-ref origin/main; there is no way to supply a '
      + 'reference or a clock from the command line.');
  }
  if (isCi(env)) {
    const offenders = [
      opts.write && '--write',
      opts.anchorRefProvided && '--anchor-ref',
    ].filter(Boolean);
    if (offenders.length > 0) {
      throw new Error(`core export surface: ${offenders.join(' / ')} not allowed in CI. `
        + 'CI must use the base commit and the real clock; a PR must not be able to hand the '
        + 'gate a reference it wrote itself.');
    }
  }
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

/** `.changeset/*.md` files that already exist at the base commit. */
function baseChangesetSet(repoRoot, commit) {
  const raw = git(repoRoot, ['ls-tree', '-r', '--name-only', commit, '--', '.changeset']);
  if (raw === null) return null;
  return new Set(raw.split('\n').map((line) => line.trim()).filter(Boolean));
}

export function loadReference(repoRoot, commit) {
  const rawBaseline = readAtCommit(repoRoot, commit, BASELINE_REL);
  const rawAdmissions = readAtCommit(repoRoot, commit, ADMISSIONS_REL);
  const anchorAdmissions = rawAdmissions ? JSON.parse(rawAdmissions) : { admissions: [], removals: [] };

  if (rawBaseline === null) {
    // The base commit predates the baseline file. Compute its surface from the
    // base tree so `--write` in this PR cannot act as the reference.
    const surface = surfaceAtCommit(repoRoot, commit);
    if (!surface) {
      return { error: `core export surface: ${commit} has no packages/principles-core/package.json; `
        + 'cannot compute the reference surface.' };
    }
    return { anchor: surface, anchorAdmissions };
  }

  return { anchor: JSON.parse(rawBaseline), anchorAdmissions };
}

export function main(argv = process.argv.slice(2), env = process.env, repoRoot = REPO_ROOT) {
  const opts = parseArgs(argv, env);
  if (opts.help) {
    console.log('usage: node scripts/check-core-export-surface.mjs [--write] '
      + '[--anchor-ref origin/main]');
    return 0;
  }

  const surface = collectSurface(repoRoot);
  const stats = summarize(surface);

  if (opts.write) {
    const baseline = buildBaseline(surface);
    writeFileSync(join(repoRoot, BASELINE_REL), `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
    console.log(`wrote ${join(repoRoot, BASELINE_REL)}`);
    console.log(`  ${stats.entryCount} entry points, ${stats.total} symbol slots, ${stats.unique} unique symbols`);
    console.log('  Note: --write only re-records a surface the gate already approved; it does not');
    console.log('  authorise a new export (the reference is the base commit, not this file).');
    return 0;
  }

  if (!existsSync(join(repoRoot, BASELINE_REL))) {
    console.error(`core export surface: baseline ${join(repoRoot, BASELINE_REL)} is missing. `
      + 'Run `node scripts/check-core-export-surface.mjs --write` and commit the result.');
    return 1;
  }
  if (!existsSync(join(repoRoot, ADMISSIONS_REL))) {
    console.error(`core export surface: admissions file ${join(repoRoot, ADMISSIONS_REL)} is missing.`);
    return 1;
  }

  const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_REL), 'utf-8'));
  const admissions = JSON.parse(readFileSync(join(repoRoot, ADMISSIONS_REL), 'utf-8'));

  if (admissions.schemaVersion !== ADMISSIONS_SCHEMA_VERSION) {
    console.error(`core export surface: ${ADMISSIONS_REL} has schemaVersion `
      + `${JSON.stringify(admissions.schemaVersion)}, expected ${ADMISSIONS_SCHEMA_VERSION}. `
      + 'Every admission now carries `expiresAt`; see scripts/check-core-export-surface.mjs.');
    return 1;
  }

  const selfCheck = baselineSelfCheck(baseline);
  if (selfCheck.length > 0) {
    console.error('core export surface: baseline file is malformed:');
    for (const problem of selfCheck) console.error(`  - ${problem}`);
    return 1;
  }

  const resolved = resolveAnchor(repoRoot, opts.anchorRef);
  if (resolved.error) {
    console.error(resolved.error);
    return 1;
  }

  const baseChangesets = baseChangesetSet(repoRoot, resolved.commit);
  if (baseChangesets === null) {
    console.error('core export surface: cannot list the base commit changesets; a removal record '
      + 'must point at a changeset this PR adds, and that cannot be verified.');
    return 1;
  }

  const reference = loadReference(repoRoot, resolved.commit);
  if (reference.error) {
    console.error(reference.error);
    return 1;
  }

  const anchorLabel = resolved.onBaseBranch
    ? `${BASE_REF}@${resolved.commit.slice(0, 8)} (base branch tip)`
    : `${BASE_REF}@${resolved.commit.slice(0, 8)}`;

  const result = evaluateSurface({
    surface,
    baseline,
    anchor: reference.anchor,
    admissions,
    anchorAdmissions: reference.anchorAdmissions,
    anchorLabel,
    baseChangesets,
    repoRoot,
    today: new Date().toISOString().slice(0, 10),
  });

  if (!result.ok) {
    console.error(`core export surface: ${result.errors.length} blocking issue(s)\n`);
    for (const error of result.errors) console.error(error);
    console.error('\nRule: packages/principles-core public symbols are frozen against the base commit. '
      + 'New symbols need an admission record; removals need a removal record + changeset; new '
      + 'subpaths need owner approval plus one record per symbol. '
      + 'See docs/reports/PD_CORE_EXPORT_SURFACE_RULE_DRAFT_20261112.md.');
    return 1;
  }

  const { added, removed } = result.delta;
  const head = `core export surface: ${stats.entryCount} entry points, ${stats.total} symbol slots, `
    + `${stats.unique} unique symbols`;
  if (result.admitted.length === 0 && result.removed.length === 0 && added === 0 && removed === 0) {
    console.log(`${head} — no change vs ${anchorLabel} (0 added, 0 removed).`);
    return 0;
  }

  console.log(`${head} — +${added} / -${removed} vs ${anchorLabel}.`);
  if (result.admitted.length > 0 || result.removed.length > 0) {
    console.log('this change relaxes the surface:');
    for (const item of result.admitted) {
      console.log(`  + ${item.entry} :: ${item.symbol} — admitted ${item.record.addedIn}, `
        + `expires ${item.record.expiresAt}`);
    }
    for (const item of result.removed) {
      console.log(`  - ${item.entry} :: ${item.symbol} — removal ${item.record.removedIn}, `
        + `changeset ${item.record.changeset}`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
