// PRI-1118 — host tool-policy audit (the "effective permission" layer).
//
// Owner requirement (2026-11-06): a tool gate has three layers —
//   1. exposure audit   — record the COMPLETE tool definitions the model saw;
//   2. effective permission — prove the fixed meta tools (`dispatch_action`,
//      `tool_describe`, `tool_search`) cannot reach any capability outside the
//      declared allowlist;
//   3. actual invocation — the only call that happened was one `read`.
//
// Meta tools may legitimately appear in the definitions: the host injects
// tool-search controls regardless of `tools.allow`. They must NOT be exempt
// from analysis merely because of their name. This module produces layer 2's
// evidence from the FROZEN host package:
//
//   a) the policy oracle — execute the host's own `isRuntimeToolAllowed`
//      against `toolsAllow` and prove the meta tools are denied;
//   b) the dispatch chain — prove `dispatch_action` resolves ids only against
//      the run's catalog, and the catalog is built from the effective tool
//      surface with meta/control tools excluded.
//
// The audit is static + pure-module execution only. It never starts a host
// turn, never opens a network connection and never writes runtime state.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256File } from './host-profile.mjs';

export const TOOL_POLICY_AUDIT_SCHEMA = 'pd-aa-tool-policy-audit/v1';

/** The host's fixed meta/tool-search controls, observed in every arm. */
export const FIXED_META_TOOLS = Object.freeze(['dispatch_action', 'tool_describe', 'tool_search']);

/** Capabilities that must stay unreachable when `tools.allow` is `["read"]`. */
const DENIED_PROBE_NAMES = Object.freeze([
  'dispatch_action',
  'tool_describe',
  'tool_search',
  'tool_call',
  'exec',
  'write',
  'message',
  'browser',
  'sessions_spawn',
]);

function listDist(distDir, prefix) {
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.mjs'))
    .map((name) => join(distDir, name));
}

function readSource(path) {
  return { path, text: readFileSync(path, 'utf8'), sha256: sha256File(path) };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Find `pattern` (a RegExp or a literal) in the first candidate file that has
 * it. Evidence records the file, sha256, line and a bounded excerpt, so the
 * claim can be re-checked against the exact frozen bundle.
 */
function collectEvidence(fixtures, pattern, id) {
  const matcher = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const fixture of fixtures) {
    const match = matcher.exec(fixture.text);
    if (match) {
      const start = Math.max(0, match.index - 160);
      const end = Math.min(fixture.text.length, match.index + match[0].length + 160);
      return {
        id,
        present: true,
        file: fixture.path,
        fileSha256: fixture.sha256,
        line: lineOf(fixture.text, match.index),
        excerpt: fixture.text.slice(start, end).trim(),
      };
    }
  }
  return { id, present: false, file: null, fileSha256: null, line: null, excerpt: null };
}

/**
 * Discover the host's runtime allowlist predicate from the pure policy module.
 * The bundle's export aliases are minified, so the function is identified by
 * behavior: `read` allowed and `exec` denied under `["read"]`. Any other
 * exported function (e.g. `createRuntimeToolMatcher`, which returns a function)
 * fails that predicate and is skipped.
 */
function discoverMatcher(moduleNamespace, toolsAllow) {
  const functions = Object.values(moduleNamespace).filter((value) => typeof value === 'function');
  for (const fn of functions) {
    try {
      if (fn('read', [...toolsAllow]) === true && fn('exec', [...toolsAllow]) === false) return fn;
    } catch {
      // Not the predicate; keep looking.
    }
  }
  return null;
}

/**
 * Run the effective-permission audit against the frozen host package.
 *
 * Returns structured evidence; `ok` is false when the oracle cannot be
 * established or any dispatch-chain fact is missing. A missing fact is a hard
 * P0 failure, never a silent pass.
 */
export async function auditHostToolPolicy({ packageDir, toolsAllow, toolName }) {
  const result = {
    schemaVersion: TOOL_POLICY_AUDIT_SCHEMA,
    ok: false,
    packageDir,
    policyAllow: Array.isArray(toolsAllow) ? [...toolsAllow] : null,
    toolName,
    metaTools: [...FIXED_META_TOOLS],
    oracle: null,
    dispatch: { catalogOnly: false, evidence: [] },
    violations: [],
  };

  if (typeof packageDir !== 'string' || !existsSync(packageDir)) {
    result.violations.push('host package directory is missing');
    return result;
  }
  if (!Array.isArray(toolsAllow) || toolsAllow.length === 0) {
    result.violations.push('toolsAllow is empty');
    return result;
  }

  const distDir = join(packageDir, 'dist');
  const matchFiles = listDist(distDir, 'tool-policy-match-');
  if (matchFiles.length === 0) {
    result.violations.push('no tool-policy-match bundle found');
    return result;
  }

  // A bundle may re-export the predicate from an implementation bundle (a
  // barrel), so the same function object can be reached through several files.
  // Deduplicate by function identity: exactly one DISTINCT predicate is
  // required. Two distinct predicates would make the oracle ambiguous and must
  // fail, never silently pick the first file.
  const matchers = new Set();
  const predicateFiles = [];
  for (const file of matchFiles) {
    let namespace;
    try {
      namespace = await import(pathToFileURL(file).href);
    } catch (error) {
      result.violations.push(`tool-policy-match bundle is not importable (${file}): ${String(error?.message ?? error)}`);
      continue;
    }
    const matcher = discoverMatcher(namespace, toolsAllow);
    if (!matcher) continue;
    matchers.add(matcher);
    predicateFiles.push({ file, fileSha256: sha256File(file) });
  }
  if (matchers.size === 0) {
    result.violations.push('could not establish the host runtime tool-policy predicate');
    return result;
  }
  if (matchers.size > 1) {
    result.violations.push(`ambiguous host runtime tool-policy predicate: ${matchers.size} distinct implementations`);
    return result;
  }
  const matcher = [...matchers][0];

  const probeNames = [...new Set([toolName, ...DENIED_PROBE_NAMES, ...FIXED_META_TOOLS])];
  const evaluations = probeNames.map((name) => ({ name, allowed: matcher(name, [...toolsAllow]) === true }));
  const metaEvaluations = evaluations.filter((entry) => FIXED_META_TOOLS.includes(entry.name));
  const allowedMeta = metaEvaluations.filter((entry) => entry.allowed).map((entry) => entry.name);
  result.oracle = {
    predicateFile: predicateFiles[0]?.file ?? null,
    predicateFileSha256: predicateFiles[0]?.fileSha256 ?? null,
    predicateFiles,
    toolsAllow: [...toolsAllow],
    evaluations,
    readAllowed: evaluations.find((entry) => entry.name === toolName)?.allowed === true,
    allowedMetaTools: allowedMeta,
    metaToolsDenied: allowedMeta.length === 0,
  };
  if (!result.oracle.readAllowed) result.violations.push(`allowlisted tool ${toolName} is denied by the host policy`);
  if (!result.oracle.metaToolsDenied) result.violations.push(`meta tool(s) allowed by the host policy: ${allowedMeta.join(', ')}`);

  const toolSearchFiles = listDist(distDir, 'tool-search-');
  const builtinFiles = listDist(distDir, 'builtin-openclaw-');
  const availabilityFiles = listDist(distDir, 'agent-tool-availability-');

  const evidence = [
    collectEvidence(toolSearchFiles.map(readSource), /const TOOL_SEARCH_CONTROL_TOOL_NAMES = [\s\S]*?new Set\(\[[\s\S]*?TOOL_CALL_RAW_TOOL_NAME[\s\S]*?\]\);/, 'control-tool-set'),
    collectEvidence(toolSearchFiles.map(readSource), /const TOOL_CALL_RAW_TOOL_NAME = "dispatch_action";/, 'dispatch-raw-name'),
    collectEvidence(toolSearchFiles.map(readSource), /function shouldCatalogTool\(tool\) \{\s*return !TOOL_SEARCH_CONTROL_TOOL_NAMES\.has\(tool\.name\)/, 'catalog-excludes-control-tools'),
    collectEvidence(toolSearchFiles.map(readSource), /if \(TOOL_SEARCH_CONTROL_TOOL_NAMES\.has\(tool\.name\)\) continue;/, 'catalog-loop-skips-control-tools'),
    collectEvidence(toolSearchFiles.map(readSource), /this\.call = async \(id, input, options\) => \{\s*const catalog = resolveCatalog\(this\.ctx\);\s*return await this\.callEntry\(findEntry\(catalog, id/, 'dispatch-resolves-only-catalog'),
    collectEvidence(toolSearchFiles.map(readSource), /if \(!namedEntry\) throw new ToolInputError\(formatUnknownToolIdError/, 'dispatch-unknown-id-refused'),
    collectEvidence(toolSearchFiles.map(readSource), /function findEntry\(catalog, id[\s\S]*?const entries = .*catalog\.entries/, 'find-entry-reads-catalog-entries'),
    collectEvidence(builtinFiles.map(readSource), /compactTools\(effectiveTools,/, 'catalog-built-from-effective-surface'),
    collectEvidence(builtinFiles.map(readSource), /gateToolExecution\(uncompactedEffectiveTools, attempt\.toolExecutionAllow\)/, 'non-allowed-tools-execute-gated'),
    collectEvidence(availabilityFiles.map(readSource), /gateAgentToolExecution/, 'gated-execution-wrapper'),
    collectEvidence(availabilityFiles.map(readSource), /markAgentToolExecutionUnavailable/, 'denied-execution-cannot-be-revived'),
    // Honest evidence that the name-based gate DOES exempt control tools: the
    // proof therefore rests on catalog-only dispatch, not on a name exemption.
    collectEvidence(builtinFiles.map(readSource), /executionAllowed\(tool\.name\) \|\| TOOL_SEARCH_CONTROL_TOOL_NAMES\.has\(tool\.name\)/, 'control-tool-name-gate-exemption'),
  ];
  result.dispatch.evidence = evidence;
  const missing = evidence.filter((item) => !item.present).map((item) => item.id);
  if (missing.length > 0) result.violations.push(`dispatch-chain evidence missing: ${missing.join(', ')}`);

  // The conclusion is a composition of the recorded facts, and it is stated in
  // one place so the gate does not have to re-interpret prose:
  //   effective surface -> catalog -> dispatch ids -> no out-of-surface tool.
  result.dispatch.catalogOnly = missing.length === 0 && result.oracle.metaToolsDenied && result.oracle.readAllowed;
  result.dispatch.derivation = [
    'the catalog is built from the effective tool surface (compactTools(effectiveTools))',
    'control/meta tools are excluded from catalog entries (shouldCatalogTool / loop skip)',
    'dispatch_action resolves ids only through findEntry over catalog.entries and refuses unknown ids',
    'non-allowlisted tools are execute-gated, and the denied state cannot be revived',
    'the host policy predicate denies dispatch_action/tool_call under tools.allow=[read]',
  ];

  result.ok = result.violations.length === 0 && result.dispatch.catalogOnly === true;
  return result;
}
