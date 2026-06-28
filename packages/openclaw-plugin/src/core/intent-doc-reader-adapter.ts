/**
 * PRI-468 — Plugin adapter implementing the core `IntentDocReader` port.
 *
 * Bridges the plugin-owned `safeReadIntentDoc()` I/O function to the
 * core-owned `IntentDocReader` interface so Stage A (in core) can read
 * INTENT.md without core performing any filesystem I/O.
 *
 * This adapter only MAPS types — it adds no new I/O, no new flag checks,
 * and no new telemetry. The underlying `safeReadIntentDoc()` already
 * performs the flag-first check (SPEC §12), TTL+mtime cache, and size cap.
 *
 * ERR checklist:
 *   EP-01 / ERR-001: never `as` — field-by-field mapping with typeof checks
 *   EP-02 / ERR-025: plugin I/O file, whitelisted in architecture-regression
 *   EP-03 / ERR-002: every degraded path flows through with reason + nextAction
 *
 * Architecture: this file is I/O (delegates to fs-reading safeReadIntentDoc).
 * It will be added to KNOWN_PLUGIN_CORE_FILES in architecture-regression.test.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeReadIntentDoc } from './intent-doc-reader.js';
import {
  getIntentFilename,
} from '@principles/core/runtime-v2';
import type {
  IntentDocReader,
  IntentDocReadResult,
  IntentDocReference,
  IntentLang,
} from '@principles/core/runtime-v2';

const INTENT_DIR = '.principles';

/**
 * Detect which language's INTENT file exists on disk.
 * Priority: zh-CN first, then en. Defaults to zh-CN if neither exists.
 *
 * This lets hooks avoid hardcoding a single language — the Owner may have
 * created either INTENT.zh-CN.md or INTENT.en.md.
 */
export function resolveIntentLang(workspaceDir: string): IntentLang {
  const zhPath = path.join(workspaceDir, INTENT_DIR, getIntentFilename('zh-CN'));
  if (fs.existsSync(zhPath)) return 'zh-CN';
  const enPath = path.join(workspaceDir, INTENT_DIR, getIntentFilename('en'));
  if (fs.existsSync(enPath)) return 'en';
  return 'zh-CN';
}

/**
 * Create an IntentDocReader bound to a specific workspace and language.
 *
 * The returned reader is stateless beyond the (workspace, lang) binding — each
 * `readIntentDoc()` call delegates to `safeReadIntentDoc()`, which owns
 * the TTL+mtime cache keyed by `${workspaceDir}:${lang}`.
 */
export function createIntentDocReader(workspaceDir: string, lang: IntentLang): IntentDocReader {
  return {
    readIntentDoc(): IntentDocReadResult {
      const result = safeReadIntentDoc(workspaceDir, lang);

      if (result.ok && result.doc) {
        const doc = result.doc;
        const reference: IntentDocReference = {
          raw: typeof doc.raw === 'string' ? doc.raw : '',
          contentHash: typeof doc.contentHash === 'string' ? doc.contentHash : '',
          path: typeof doc.path === 'string' ? doc.path : '',
        };
        return {
          ok: true,
          found: true,
          flagEnabled: true,
          doc: reference,
        };
      }

      // Degraded path — preserve structured reason + nextAction (EP-03 / ERR-002)
      return {
        ok: false,
        found: result.found,
        flagEnabled: result.flagEnabled,
        reason: result.reason,
        nextAction: result.nextAction,
      };
    },
  };
}
