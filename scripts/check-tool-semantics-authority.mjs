#!/usr/bin/env node
// B5 anti-regression guards for the tool-semantics contract (B series).
//
// TWO INVARIANTS, ONE GATE:
//
//  Guard A — tool semantics have ONE authority.
//    A raw tool name may only be interpreted by the per-host declaration files
//    (`*_TOOL_SEMANTIC_MAPPINGS`) feeding `buildToolSemanticRegistry`. Any other
//    production source that compares a `toolName` against a string literal, or
//    hand-writes a tool-name set, is a competing classification authority. That
//    is the exact defect the B series removed twice (two `apply_patch` parsers,
//    hook vs replay disagreement).
//
//  Guard B — RuleHostResult has ONE reading.
//    A consumer that receives raw rule output (`.evaluate(...)`) must route it
//    through `normalizeRuleHostResult` (`evaluateRuleHostImplementations`) so an
//    unreadable result fails closed instead of silently vanishing. Core owns the
//    contract and its activation/evaluation internals, so core is exempt; every
//    other package must normalize or appear below with a verified reason.
//
// Both scans use the PROVEN repository pattern (scripts/check-runtime-writers.mjs):
// whole-tree static scan, one SSoT allowlist, and a TWO-WAY check — an unlisted
// hit fails and a stale entry fails (ERR-146). Allowlist entries are per SITE
// (file + literal), not per file, so adding a new competing literal to an
// already-allowlisted file still reddens.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The declaration authority. Literal tool names belong here by design, so these
 * files are EXEMPT rather than allowlisted: a declaration file that stops
 * containing a particular literal is still a legitimate declaration file.
 */
export const DECLARATION_FILES = new Set([
  'packages/openclaw-plugin/src/constants/tools.ts',
  'packages/openclaw-plugin/src/constants/tool-semantics.ts',
  'packages/codex-adapter/src/tool-semantics.ts',
  'packages/workbuddy-adapter/src/tool-semantics.ts',
]);

/** `x.toolName === 'write'` / `tool_name !== "bash"` comparison against a literal. */
export const TOOL_NAME_LITERAL = /\btool_?name\b\s*(?:===|!==|==|!=)\s*(['"])([^'"\n]+)\1/gi;

/**
 * `typeof x.toolName === 'string'` is a type guard, not a classification. A JS
 * primitive type name is never a real tool name, so excluding them removes the
 * whole false-positive family without any host knowledge.
 */
const PRIMITIVE_TYPE_NAMES = new Set([
  'string', 'number', 'boolean', 'object', 'function', 'symbol', 'bigint', 'undefined',
]);

/** Declared raw tool names, read from the declaration files themselves (no second list). */
const RAW_TOOL_NAME_DECLARATION = /rawToolName\s*:\s*(['"])([^'"\n]+)\1/g;
/** Declared canonical kinds, same source. */
const CANONICAL_KIND_DECLARATION = /canonicalKind\s*:\s*(['"])([^'"\n]+)\1/g;

/** `new Set([...])` / `new Set<string>([...])` bodies. */
const SET_LITERAL = /new\s+Set\s*(?:<[^>]*>)?\s*\(\s*\[([\s\S]{0,600}?)\]\s*\)/g;

/** Raw rule output entering a consumer. */
export const RULE_EVALUATE_CALL = /\.evaluate\s*\(/;
/** Mentions the contract type at all (import, annotation, comment). */
export const RULE_RESULT_CONTRACT = /\bRuleHostResult\b/;
/** The ONE authorized reading of raw rule output. */
export const RULE_RESULT_AUTHORITY = /\b(?:normalizeRuleHostResult|evaluateRuleHostImplementations)\b/;

/** Core owns the contract and its evaluation internals (plan §6.1). */
export const CORE_PREFIX = 'packages/principles-core/src/';

/**
 * Competing tool-name classification sites that predate this guard.
 *
 * Each entry is a SITE (file + literal), verified to trip the predicate today.
 * A new literal in the same file still fails; removing the last occurrence
 * makes the entry stale and fails too.
 */
export const ALLOWED_TOOL_NAME_LITERALS = [
  {
    file: 'packages/host-runtime/src/codex-rule-context-provider.ts',
    literal: 'apply_patch',
    reason: 'Codex-only refinement: only a Codex apply_patch payload carries "*** Add/Update/Delete File:" headers, so patchTargets() is gated on it AFTER the registry already decided targetKind === write. The classification itself still comes from the declaration registry; this literal only selects the payload parser.',
  },
  {
    file: 'packages/principles-core/src/runtime/risk/risk-calculator-policy.ts',
    literal: 'write_file',
    reason: 'Legacy cross-host line-change estimate (write/edit/patch/delete families) predating the registry. It estimates size, it does not decide tool semantics or enforcement. Follow-up candidate: derive this family list from ToolSemanticRegistry.',
  },
  {
    file: 'packages/principles-core/src/runtime/risk/risk-calculator-policy.ts',
    literal: 'write',
    reason: 'Same legacy estimate: recognises the generic vocabulary write_file/write/replace/edit/apply_patch/patch/delete_file. Not an enforcement authority; follow-up candidate as above.',
  },
  {
    file: 'packages/principles-core/src/runtime/risk/risk-calculator-policy.ts',
    literal: 'replace',
    reason: 'Same legacy estimate: recognises the generic vocabulary write_file/write/replace/edit/apply_patch/patch/delete_file. Not an enforcement authority; follow-up candidate as above.',
  },
  {
    file: 'packages/principles-core/src/runtime/risk/risk-calculator-policy.ts',
    literal: 'edit',
    reason: 'Same legacy estimate: recognises the generic vocabulary write_file/write/replace/edit/apply_patch/patch/delete_file. Not an enforcement authority; follow-up candidate as above.',
  },
  {
    file: 'packages/principles-core/src/runtime/risk/risk-calculator-policy.ts',
    literal: 'apply_patch',
    reason: 'Same legacy estimate: recognises the generic vocabulary write_file/write/replace/edit/apply_patch/patch/delete_file. Not an enforcement authority; follow-up candidate as above.',
  },
  {
    file: 'packages/principles-core/src/runtime/risk/risk-calculator-policy.ts',
    literal: 'patch',
    reason: 'Same legacy estimate: recognises the generic vocabulary write_file/write/replace/edit/apply_patch/patch/delete_file. Not an enforcement authority; follow-up candidate as above.',
  },
  {
    file: 'packages/principles-core/src/runtime/risk/risk-calculator-policy.ts',
    literal: 'delete_file',
    reason: 'Same legacy estimate: recognises the generic vocabulary write_file/write/replace/edit/apply_patch/patch/delete_file. Not an enforcement authority; follow-up candidate as above.',
  },
  {
    file: 'packages/principles-core/src/runtime/evidence-triage/observation-resolver.ts',
    literal: 'pain',
    reason: 'Observation-source routing sentinel for the manual pain tool, not tool semantics: it decides whether an observation was agent-reported vs owner-reported. No registry mapping is involved.',
  },
  {
    file: 'packages/principles-core/src/runtime/evidence-triage/observation-resolver.ts',
    literal: 'skill:pain',
    reason: 'Same observation-source routing sentinel (the skill-face spelling of the manual pain tool).',
  },
  {
    file: 'packages/openclaw-plugin/src/index.ts',
    literal: 'pain',
    reason: 'OpenClaw dispatch sentinel: routes the manual pain tool before the rule-host path. Host routing, not semantic classification.',
  },
  {
    file: 'packages/openclaw-plugin/src/index.ts',
    literal: 'skill:pain',
    reason: 'OpenClaw dispatch sentinel (skill-face spelling of the manual pain tool).',
  },
  {
    file: 'packages/openclaw-plugin/src/hooks/pain.ts',
    literal: 'pain',
    reason: 'Manual pain intervention entry point. Host routing, not semantic classification.',
  },
  {
    file: 'packages/openclaw-plugin/src/hooks/pain.ts',
    literal: 'skill:pain',
    reason: 'Manual pain intervention entry point (skill-face spelling).',
  },
  {
    file: 'packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts',
    literal: 'memory_store',
    reason: 'Post-call memory bookkeeping handler selection for one OpenClaw tool. It does not classify the tool for rule enforcement; no registry mapping is involved.',
  },
];

/**
 * Raw `RuleHostResult` consumers outside core that do not name
 * `normalizeRuleHostResult`, verified individually.
 */
export const ALLOWED_RAW_RULE_RESULT_CONSUMERS = [
  {
    file: 'packages/openclaw-plugin/src/hooks/gate.ts',
    reason: 'Calls the legacy RuleHost class, whose evaluate() already normalizes every implementation result internally (core/rule-host.ts imports normalizeRuleHostResult). The gate sees an already-normalized value; re-normalizing would be a second reading of the same contract.',
  },
];

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_PATH = /\.test\.|[/\\]__tests__[/\\]|[/\\]tests[/\\]/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

/**
 * Production source files in scope, as repo-relative '/' paths.
 * `packages/<name>/src/**` only: guards, adapters and tooling live outside the
 * runtime surface this contract protects.
 */
export function collectScopeFiles(repoRoot) {
  const packagesDir = join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) return [];
  const files = [];
  for (const abs of walk(packagesDir)) {
    const rel = relative(repoRoot, abs).split(sep).join('/');
    if (!SOURCE_EXT.test(rel)) continue;
    if (!/^packages\/[^/]+\/src\//.test(rel)) continue;
    if (TEST_PATH.test(rel)) continue;
    files.push(rel);
  }
  return files.sort();
}

function siteKey(entry) {
  return `${entry.file}\u0000${entry.literal}`;
}

function hitKey(hit) {
  return `${hit.file}\u0000${hit.literal}`;
}

/** Tool-name literals and hand-written tool-name sets per production file. */
export function scanToolNameLiterals(repoRoot) {
  const scope = collectScopeFiles(repoRoot);
  const declaredNames = collectDeclaredRawToolNames(repoRoot);
  const kinds = collectDeclaredCanonicalKinds(repoRoot);
  const hits = [];
  for (const rel of scope) {
    if (DECLARATION_FILES.has(rel)) continue;
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const literals = new Set();

    const comparison = new RegExp(TOOL_NAME_LITERAL.source, TOOL_NAME_LITERAL.flags);
    for (const match of text.matchAll(comparison)) {
      if (PRIMITIVE_TYPE_NAMES.has(match[2])) continue;
      literals.add(match[2]);
    }

    // A hand-written set competes with the registry only when it re-declares
    // names the host declarations own. Names that are also canonical kinds are
    // left alone: `new Set(['read', 'write'])` is the kind vocabulary, not a
    // tool-name table (the literal-comparison guard still covers those).
    for (const match of text.matchAll(SET_LITERAL)) {
      const declared = [...match[1].matchAll(/(['"])([^'"\n]+)\1/g)]
        .map((m) => m[2].toLowerCase())
        .filter((name) => declaredNames.has(name) && !kinds.has(name));
      if (new Set(declared).size >= 2) literals.add('<tool-name-set>');
    }

    for (const literal of literals) hits.push({ file: rel, literal });
  }
  return { scanned: scope.length, hits };
}

/** Raw tool names the host declarations own — the only vocabulary a set may use. */
export function collectDeclaredRawToolNames(repoRoot) {
  return collectDeclarationVocabulary(repoRoot, RAW_TOOL_NAME_DECLARATION);
}

/** Canonical kinds the declarations use. */
export function collectDeclaredCanonicalKinds(repoRoot) {
  return collectDeclarationVocabulary(repoRoot, CANONICAL_KIND_DECLARATION);
}

function collectDeclarationVocabulary(repoRoot, pattern) {
  const values = new Set();
  for (const rel of DECLARATION_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    for (const match of readFileSync(abs, 'utf8').matchAll(pattern)) {
      values.add(match[2].toLowerCase());
    }
  }
  return values;
}

/** Compare the tool-name scan against the SSoT allowlist (both directions). */
export function evaluateToolNameAuthority(repoRoot, allowlist = ALLOWED_TOOL_NAME_LITERALS) {
  const { scanned, hits } = scanToolNameLiterals(repoRoot);
  const allowed = new Set(allowlist.map(siteKey));
  const seen = new Set(hits.map(hitKey));
  return {
    scanned,
    hits,
    unauthorized: hits.filter((hit) => !allowed.has(hitKey(hit))),
    stale: allowlist.filter((entry) => !seen.has(siteKey(entry))),
  };
}

/** Production files outside core that read raw rule output without normalizing. */
export function scanRawRuleResultConsumers(repoRoot) {
  const scope = collectScopeFiles(repoRoot);
  const flagged = [];
  for (const rel of scope) {
    if (rel.startsWith(CORE_PREFIX)) continue;
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    if (!RULE_RESULT_CONTRACT.test(text)) continue;
    if (!RULE_EVALUATE_CALL.test(text)) continue;
    if (RULE_RESULT_AUTHORITY.test(text)) continue;
    flagged.push(rel);
  }
  return { scanned: scope.length, flagged };
}

/** Compare the raw-consumer scan against its allowlist (both directions). */
export function evaluateRawRuleResultConsumers(
  repoRoot,
  allowlist = ALLOWED_RAW_RULE_RESULT_CONSUMERS,
) {
  const { scanned, flagged } = scanRawRuleResultConsumers(repoRoot);
  const allowed = new Set(allowlist.map((entry) => entry.file));
  const flaggedSet = new Set(flagged);
  return {
    scanned,
    flagged,
    unauthorized: flagged.filter((file) => !allowed.has(file)),
    stale: allowlist.filter((entry) => !flaggedSet.has(entry.file)).map((entry) => entry.file),
  };
}

const NEXT_ACTION_TOOL_NAMES = [
  'nextAction:',
  '  Tool semantics must come from the host declaration, not from a literal in a',
  '  consumer. Add/change the mapping in the host declaration file',
  '  (packages/<host>/src/**tool-semantics.ts or constants/tools.ts) and resolve it',
  '  through buildToolSemanticRegistry / resolveHostToolSemanticsForHook.',
  '  Only if the comparison is genuinely NOT tool semantics (host routing,',
  '  bookkeeping) add a SITE entry to ALLOWED_TOOL_NAME_LITERALS in',
  '  scripts/check-tool-semantics-authority.mjs with the evidence.',
].join('\n');

const NEXT_ACTION_RULE_RESULT = [
  'nextAction:',
  '  Raw rule output must be read through normalizeRuleHostResult (or the shared',
  '  evaluator that calls it). If this consumer receives an already-normalized',
  '  RuleHostResult, add it to ALLOWED_RAW_RULE_RESULT_CONSUMERS in',
  '  scripts/check-tool-semantics-authority.mjs with the reason.',
].join('\n');

function main() {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  const tool = evaluateToolNameAuthority(repoRoot);
  const rule = evaluateRawRuleResultConsumers(repoRoot);

  if (tool.unauthorized.length === 0 && tool.stale.length === 0) {
    console.log('Tool semantics authority PASS');
    console.log(`scanned:\n  ${tool.scanned} first-party production files`);
    console.log(`allowlisted competing sites:\n  ${tool.hits.length}`);
  } else {
    console.error('Tool semantics authority FAIL');
    console.error(`scanned:\n  ${tool.scanned} first-party production files`);
    for (const hit of tool.unauthorized) {
      console.error(`\n${hit.file}\n  literal: ${hit.literal}\n\nreason:\n  classifies tool behaviour with a literal outside the host declaration\n\n${NEXT_ACTION_TOOL_NAMES}`);
    }
    for (const entry of tool.stale) {
      console.error(`\n${entry.file}\n  literal: ${entry.literal}\n\nreason:\n  stale ALLOWED_TOOL_NAME_LITERALS entry — the site no longer trips the predicate.\n\nnextAction:\n  Remove the entry from scripts/check-tool-semantics-authority.mjs.`);
    }
  }

  if (rule.unauthorized.length === 0 && rule.stale.length === 0) {
    console.log('Rule result authority PASS');
    console.log(`raw-result consumers (all allowlisted with reason):\n  ${rule.flagged.length}`);
  } else {
    console.error('Rule result authority FAIL');
    for (const file of rule.unauthorized) {
      console.error(`\n${file}\n\nreason:\n  reads raw RuleHostResult output without normalizeRuleHostResult\n\n${NEXT_ACTION_RULE_RESULT}`);
    }
    for (const file of rule.stale) {
      console.error(`\n${file}\n\nreason:\n  stale ALLOWED_RAW_RULE_RESULT_CONSUMERS entry — the file no longer trips the predicate.\n\nnextAction:\n  Remove the entry from scripts/check-tool-semantics-authority.mjs.`);
    }
  }

  if (tool.unauthorized.length > 0 || tool.stale.length > 0
    || rule.unauthorized.length > 0 || rule.stale.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
