/**
 * Source scan: which child_process calls in a TypeScript tree hide their
 * console window on Windows.
 *
 * WHY THIS EXISTS (live machine, 2026-11-23)
 * An update is carried by the bootstrap executor, which the Console spawns
 * with `detached: true`. On Windows a detached process has NO console, so every
 * console program it starts without `windowsHide: true` gets a brand-new,
 * visible terminal window. One update popped a dozen of them, and the window of
 * the auto-launched Console server stayed open until that server was killed.
 * "A window is on the desktop" cannot be observed in CI, so the rule is
 * enforced on the source: every child_process call passes `windowsHide: true`
 * in every options literal it carries. The option is a no-op on POSIX and for a
 * child that inherits a real terminal, so the rule has no exception of its own;
 * a package may list call sites it can justify (see `scanTree` options).
 *
 * WHY AST, NOT REGEX
 * A regex over the raw text is defeated by the first re-wrapped call, and it
 * cannot tell `execFileSync('tar', ...)` from `db.exec(sql)` or see
 * `namespace.execFile(...)`. The scan follows what the import binds — through
 * `promisify`, through a fallback such as `options.spawnFn ?? spawn`, through a
 * namespace — and FAILS CLOSED where it cannot follow: a child_process function
 * handed around as a value (`registry.register(spawn)`), an import shape it
 * does not know. Those are reported, never waved through.
 *
 * HOW TO RUN IT
 * `node scripts/lib/child-process-window-scan.mjs <dir>...` scans directories
 * and exits 1 on any finding. The durable gates are the package tests that
 * import `scanTree` (packages/create-principles-disciple, packages/pd-cli), so
 * the check runs inside the test jobs those packages already have.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const CHILD_PROCESS_FUNCTIONS = new Set([
  'spawn', 'exec', 'execFile', 'execSync', 'execFileSync', 'spawnSync', 'fork',
]);

const CHILD_PROCESS_MODULE = /^(node:)?child_process$/;
const PROMISIFY = /^(?:util\.)?promisify$/;
const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
]);
const DETAIL = {
  missing: 'options literal has no windowsHide',
  'not-true': 'windowsHide is not `true` on every options literal',
  'no-options-literal': 'no options literal in the call (options omitted, or built outside the call)',
  'unrecognised-import': 'child_process import shape the scanner does not analyse',
  'function-escape': 'child_process function used as a value; the calls that reach it cannot be attributed',
};

/** `import('child_process')` / `require('child_process')`. */
function isChildProcessModuleLoad(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  if (!isImport && !isRequire) return false;
  const [specifier] = node.arguments;
  return node.arguments.length === 1 && specifier !== undefined
    && ts.isStringLiteral(specifier) && CHILD_PROCESS_MODULE.test(specifier.text);
}

/** The load of an `(await import('child_process')).fn` member expression. */
function moduleLoadBehindMember(node) {
  if (!ts.isPropertyAccessExpression(node)) return null;
  // `(await import('x')).fn` — the parenthesised await is the usual spelling.
  const parenthesized = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
  const object = ts.isAwaitExpression(parenthesized) ? parenthesized.expression : parenthesized;
  return isChildProcessModuleLoad(object) && CHILD_PROCESS_FUNCTIONS.has(node.name.text) ? object : null;
}

/** Every object literal that can be the options argument of a call. */
function optionLiterals(node, out) {
  if (ts.isObjectLiteralExpression(node)) {
    out.push(node);
    return;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    optionLiterals(node.expression, out);
    return;
  }
  // `process.platform === 'win32' ? {...} : {...}` — every branch is an options literal.
  if (ts.isConditionalExpression(node)) {
    optionLiterals(node.whenTrue, out);
    optionLiterals(node.whenFalse, out);
  }
}

function propertyKey(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : '';
}

function verdictFor(literals) {
  if (literals.length === 0) return 'no-options-literal';
  let presentSomewhere = false;
  let trueEverywhere = true;
  for (const literal of literals) {
    let present = false;
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property) || propertyKey(property.name) !== 'windowsHide') continue;
      present = true;
      if (property.initializer.kind !== ts.SyntaxKind.TrueKeyword) trueEverywhere = false;
    }
    if (present) presentSomewhere = true;
    else trueEverywhere = false;
  }
  if (!presentSomewhere) return 'missing';
  return trueEverywhere ? null : 'not-true';
}

/**
 * Scan one TypeScript source.
 * @param {string} relativeFile path as reported in findings
 * @param {string} text source text
 * @returns {{ findings: Finding[], callSites: number }}
 */
export function scanSource(relativeFile, text) {
  const source = ts.createSourceFile(relativeFile, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  let callSites = 0;

  const report = (node, fn, verdict, context = node) => {
    findings.push({
      file: relativeFile,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      fn,
      verdict,
      detail: DETAIL[verdict],
      // The offending expression, or — for a function escaping as a value —
      // the expression it escapes into, which is what an exception must name.
      call: context.getText(source).replace(/\s+/g, ' ').slice(0, 160),
    });
  };

  /** identifier -> child_process function it is (imported, or an alias of one) */
  const functionNames = new Map();
  /** identifier -> namespace import of child_process */
  const namespaceNames = new Set();
  /** variable declarations whose initializer is (or may fall back to) a child_process function */
  const aliasDeclarations = new Set();
  /** parameters whose default value is a child_process function (`spawnFn: typeof spawn = spawn`) */
  const aliasParameters = new Set();

  /**
   * The child_process function an expression evaluates to — possibly through a
   * fallback such as `options.spawnFn ?? spawn` — or null when it is none.
   */
  const resolvesToFunction = (node) => {
    if (node === undefined) return null;
    if (ts.isIdentifier(node)) return functionNames.get(node.text) ?? null;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) {
      return resolvesToFunction(node.expression);
    }
    if (ts.isConditionalExpression(node)) return resolvesToFunction(node.whenTrue) ?? resolvesToFunction(node.whenFalse);
    if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) {
      return resolvesToFunction(node.left) ?? resolvesToFunction(node.right);
    }
    // `(await import('node:child_process')).execFile`
    return moduleLoadBehindMember(node) === null ? null : node.name.text;
  };

  // Pass 1 — what the import binds.
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && CHILD_PROCESS_MODULE.test(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (clause?.isTypeOnly === true) {
        // `import type {...}` names no runtime function.
      } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          functionNames.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        namespaceNames.add(bindings.name.text);
      } else {
        report(node, '*', 'unrecognised-import');
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const initializer = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectBindingPattern(node.name)) {
        // `const { execFile } = await import('node:child_process')`
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const bound = (element.propertyName ?? element.name).getText(source);
          if (CHILD_PROCESS_FUNCTIONS.has(bound)) functionNames.set(element.name.text, bound);
        }
      } else if (ts.isIdentifier(node.name)) {
        const bound = resolvesToFunction(node.initializer)
          ?? (ts.isCallExpression(node.initializer) && PROMISIFY.test(node.initializer.expression.getText(source))
            ? resolvesToFunction(node.initializer.arguments[0]) : null);
        if (bound !== null) {
          functionNames.set(node.name.text, bound);
          aliasDeclarations.add(node);
        }
      }
    } else if (ts.isParameter(node) && node.initializer !== undefined && ts.isIdentifier(node.name)) {
      // `function spawnCli(entry, args, spawnFn: typeof spawn = spawn)`
      const bound = resolvesToFunction(node.initializer);
      if (bound !== null) {
        functionNames.set(node.name.text, bound);
        aliasParameters.add(node);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  /** Is `node` inside the default value of an alias parameter, or the
   *  initializer of an alias declaration? */
  const insideAliasValue = (node) => {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (ts.isParameter(current)) {
        return aliasParameters.has(current) && current.initializer !== undefined
          && current.initializer.pos <= node.pos && node.end <= current.initializer.end;
      }
      if (ts.isVariableDeclaration(current)) {
        const initializer = current.initializer;
        return aliasDeclarations.has(current) && initializer !== undefined
          && initializer.pos <= node.pos && node.end <= initializer.end;
      }
    }
    return false;
  };

  const analyseCall = (node, fn) => {
    callSites += 1;
    const literals = [];
    for (const argument of node.arguments) optionLiterals(argument, literals);
    const verdict = verdictFor(literals);
    if (verdict !== null) report(node, fn, verdict);
  };

  // Pass 2 — every call, and every use of a bound name that is not a call.
  const visit = (node) => {
    if (isChildProcessModuleLoad(node)) {
      const wrapped = ts.isAwaitExpression(node.parent) ? node.parent : node;
      // `(await import('x')).fn` and `const { fn } = await import('x')`.
      const member = ts.isParenthesizedExpression(wrapped.parent) ? wrapped.parent.parent : wrapped.parent;
      const destructured = ts.isVariableDeclaration(wrapped.parent) && ts.isObjectBindingPattern(wrapped.parent.name);
      if (!destructured && moduleLoadBehindMember(member) === null) report(node, '*', 'unrecognised-import');
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && functionNames.has(callee.text)) {
        analyseCall(node, functionNames.get(callee.text));
      } else if (ts.isPropertyAccessExpression(callee)) {
        const viaNamespace = ts.isIdentifier(callee.expression) && namespaceNames.has(callee.expression.text)
          && CHILD_PROCESS_FUNCTIONS.has(callee.name.text);
        if (viaNamespace || moduleLoadBehindMember(callee) !== null) analyseCall(node, callee.name.text);
      }
    } else if (ts.isIdentifier(node) && functionNames.has(node.text)) {
      const parent = node.parent;
      const isCallee = ts.isCallExpression(parent) && parent.expression === node;
      // `x.spawnFn` / `{ spawnFn: ... }` name a property, not the binding.
      const isPropertyName = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)
        || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent)
        || ts.isMethodDeclaration(parent)) && parent.name === node;
      const isDeclarationName = ts.isImportSpecifier(parent) || ts.isBindingElement(parent)
        || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node);
      // `typeof ns.fn` in a type annotation names a type member, not the binding.
      const isTypePosition = ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent);
      const declaration = ts.isVariableDeclaration(parent) && parent.name === node ? parent : null;
      // `export const launch = spawn` — VariableDeclaration → VariableDeclarationList → VariableStatement.
      const statement = declaration !== null && ts.isVariableDeclarationList(declaration.parent)
        ? declaration.parent.parent : undefined;
      const exported = statement !== undefined && ts.isVariableStatement(statement)
        && (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) {
        // The alias leaves this file; its callers cannot be scanned from here.
        report(node, functionNames.get(node.text), 'function-escape');
      } else if (!isCallee && !isPropertyName && !isDeclarationName && !isTypePosition && !insideAliasValue(node)) {
        report(node, functionNames.get(node.text), 'function-escape', node.parent);
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && namespaceNames.has(node.expression.text) && CHILD_PROCESS_FUNCTIONS.has(node.name.text)) {
      const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!isCallee) report(node, node.name.text, 'function-escape', node.parent);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, callSites };
}

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'tests', '__tests__'].includes(entry.name)) continue;
      listSourceFiles(full, out);
      continue;
    }
    const isTypeScript = /\.(ts|mts|cts)$/.test(entry.name);
    const isGeneratedOrTest = /\.d\.ts$/.test(entry.name) || /\.(test|spec)\.[cm]?ts$/.test(entry.name);
    if (isTypeScript && !isGeneratedOrTest) out.push(full);
  }
  return out;
}

/**
 * Scan every TypeScript source under `root`.
 *
 * `exceptions` are per call site — `{ file, fn, snippet, reason }`; a finding
 * is covered when file and function match and the call text contains `snippet`.
 * One exception covers one call site, so a justification is written for each
 * place it excuses and cannot be stretched over a second one by accident. An
 * exception that covers nothing any more is returned in `staleExceptions`:
 * the caller must fail on it, so a justification cannot outlive its call site.
 *
 * @param {string} root
 * @param {{ exceptions?: readonly Exception[] }} [options]
 * @returns {ScanResult}
 */
export function scanTree(root, options = {}) {
  const exceptions = [...(options.exceptions ?? [])];
  const findings = [];
  const files = [];
  let callSites = 0;
  const covered = new Set();
  for (const file of listSourceFiles(root).sort()) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const scanned = scanSource(relative, fs.readFileSync(file, 'utf8'));
    callSites += scanned.callSites;
    if (scanned.callSites > 0 || scanned.findings.length > 0) files.push(relative);
    for (const finding of scanned.findings) {
      const index = exceptions.findIndex((exception, position) => !covered.has(position)
        && exception.file === finding.file
        && exception.fn === finding.fn && finding.call.includes(exception.snippet));
      if (index === -1) {
        findings.push(finding);
        continue;
      }
      covered.add(index);
    }
  }
  const staleExceptions = exceptions.filter((_, index) => !covered.has(index));
  return { findings, files, callSites, staleExceptions };
}

function main(argv) {
  if (argv.length === 0) {
    console.log('usage: node scripts/lib/child-process-window-scan.mjs <source dir>...');
    return 2;
  }
  let failed = false;
  for (const dir of argv) {
    const result = scanTree(dir);
    for (const finding of result.findings) {
      failed = true;
      console.error(`${finding.file}:${finding.line} ${finding.fn} — ${finding.verdict}: ${finding.detail}`);
    }
    console.log(`${dir}: ${result.callSites} child_process call(s), ${result.findings.length} finding(s)`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
