#!/usr/bin/env node
/**
 * check-console-i18n — locale parity + literal-key existence.
 *
 * Why this exists (SPEC-PD-UIUX-002 §3.6, §1A): the console shipped
 * `PAGES.SIDEBAR.DEBT` to the Owner because a literal key was misspelled
 * (`pages.sidebar.debt`) and i18next falls back to echoing the key. TypeScript
 * cannot see inside a string literal used as a key, so this script can.
 *
 * Two checks:
 *   1. zh-CN.json and en.json must have the SAME key set (catches half-translated
 *      features and keys that only exist in one locale).
 *   2. Every static `t("a.b.c")` literal in src/ui must exist in both locales
 *      (catches B-1-class typos before they reach a screenshot).
 *
 * Intentional exceptions live in ALLOWED_MISSING below, each with a reason.
 * Run: node scripts/check-console-i18n.mjs [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'src', 'ui');
const LOCALES = ['zh-CN', 'en'];

/**
 * Keys that are intentionally resolved at runtime (dynamic segments) or that
 * pages pass with a `defaultValue`. Keep this empty unless you can explain why.
 */
const ALLOWED_MISSING = new Map([
  // Template-literal keys: `pages.focus.stateLabel.${state}` and friends cannot
  // be enumerated statically. Their concrete values are covered by the enum test.
]);

function flatten(value, prefix = '', out = new Map()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

/**
 * i18next is initialised with three namespaces (src/ui/i18n/index.ts):
 *   common      -> the whole JSON document (default)
 *   pages       -> json.pages
 *   components  -> json.components
 * A key is only "found" when it exists in the namespace the call site resolves
 * to, so we keep one index per namespace instead of one flat "anything goes" map.
 */
function indexNamespaces(document) {
  return new Map([
    ['common', flatten(document)],
    ['pages', flatten(document.pages ?? {})],
    ['components', flatten(document.components ?? {})],
  ]);
}

const locales = new Map();
for (const locale of LOCALES) {
  const path = join(UI_DIR, 'i18n', `${locale}.json`);
  locales.set(locale, indexNamespaces(JSON.parse(readFileSync(path, 'utf8'))));
}

const errors = [];
const [zhNs, enNs] = [locales.get('zh-CN'), locales.get('en')];
const [zhCommon, enCommon] = [zhNs.get('common'), enNs.get('common')];

for (const key of zhCommon.keys()) {
  if (!enCommon.has(key)) errors.push({ type: 'locale-parity', key, message: `missing in en.json` });
}
for (const key of enCommon.keys()) {
  if (!zhCommon.has(key)) errors.push({ type: 'locale-parity', key, message: `missing in zh-CN.json` });
}

/**
 * Resolve the namespaces a `t()` call inside `source` can see. `useTranslation("pages")`
 * switches the default namespace for that module; without an argument it stays `common`.
 */
function namespacesFor(source) {
  const found = new Set();
  for (const match of source.matchAll(/useTranslation\(\s*(?:\[\s*)?['"]([^'"]+)['"]/g)) {
    found.add(match[1]);
  }
  return found.size > 0 ? found : new Set(['common']);
}

function hasKey(localeIndex, namespaces, key) {
  const separator = key.indexOf(':');
  if (separator !== -1) {
    const explicit = key.slice(0, separator);
    const rest = key.slice(separator + 1);
    const index = localeIndex.get(explicit);
    return index ? index.has(rest) : false;
  }
  for (const ns of namespaces) {
    const index = localeIndex.get(ns);
    if (index && index.has(key)) return true;
  }
  return false;
}

const reported = new Set();

// Static single/double-quoted `t('...')` call sites only. Template literals are
// resolved at runtime and are covered by the enum/resolver tests instead.
const T_CALL = /\bt\(\s*(['"])([^'"]+)\1/g;

for (const file of walk(UI_DIR)) {
  const source = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const namespaces = namespacesFor(source);
  for (const match of source.matchAll(T_CALL)) {
    const key = match[2];
    // Skip things that are clearly not keys (spaces usually mean a sentence).
    if (key.includes(' ') || key.length === 0) continue;
    if (!key.includes('.')) continue;
    // Dynamic prefix built by concatenation: `t("a.b." + x)` or `t("a.b" + x)`.
    const rest = source.slice((match.index ?? 0) + match[0].length);
    if (/^\s*\+/.test(rest)) continue;
    if (key.endsWith('.') || key.startsWith('.')) continue;
    if (ALLOWED_MISSING.has(key)) continue;
    if (!hasKey(zhNs, namespaces, key)) {
      const id = `zh-CN|${key}`;
      if (!reported.has(id)) {
        reported.add(id);
        errors.push({ type: 'missing-key', key, file: rel, message: 'not in zh-CN.json' });
      }
    }
    if (!hasKey(enNs, namespaces, key)) {
      const id = `en|${key}`;
      if (!reported.has(id)) {
        reported.add(id);
        errors.push({ type: 'missing-key', key, file: rel, message: 'not in en.json' });
      }
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
} else if (errors.length === 0) {
  console.log(`[console-i18n] OK — ${zhCommon.size} keys in parity, all static t() keys resolve.`);
} else {
  console.error(`[console-i18n] ${errors.length} problem(s):`);
  for (const error of errors) {
    console.error(`  ${error.type}: ${error.key}${error.file ? ` (${error.file})` : ''} — ${error.message}`);
  }
}

process.exit(errors.length === 0 ? 0 : 1);
