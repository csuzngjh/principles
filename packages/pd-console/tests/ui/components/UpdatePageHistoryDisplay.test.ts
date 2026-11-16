/**
 * Update page history display + cleanup contracts.
 *
 * The vitest config uses the 'node' environment (no jsdom), so React
 * components cannot be mounted here. Following the established pattern
 * (see UpdatePageIdentityDivergence.test.ts), pure display logic is tested
 * through its real runtime export, and mount-time structure through
 * source-contract assertions on the page, the stylesheet, and BOTH locales
 * (ERR-106 family: Owner-facing copy must exist in every locale).
 *
 * Contracts pinned here (Owner request 2026-11-16):
 * - History renders NEWEST FIRST (the API/file order is append order).
 * - Only the newest 5 entries render until the Owner expands the list.
 * - A cleanup action exists, is gated above 5 entries, and confirms first.
 * - The page uses the "wide" PageShell column and the container-query paired
 *   columns so 4K spends extra width on a second column, not longer lines.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedRecord, parseJsonRecord } from '../i18n-test-helper.js';
import { sortHistoryDesc } from '../../../src/ui/pages/settings/UpdatePage.js';
import { validateUpdateHistoryPruneResult } from '../../../src/ui/utils/validators.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', '..', 'src', 'ui');

const PAGE_SOURCE = readFileSync(join(SRC_ROOT, 'pages', 'settings', 'UpdatePage.tsx'), 'utf-8');
const CSS_SOURCE = readFileSync(join(SRC_ROOT, 'styles', 'globals.css'), 'utf-8');

const EN = parseJsonRecord(readFileSync(join(SRC_ROOT, 'i18n', 'en.json'), 'utf-8'));
const ZH = parseJsonRecord(readFileSync(join(SRC_ROOT, 'i18n', 'zh-CN.json'), 'utf-8'));

const CLEANUP_I18N_KEYS = [
  'cleanupHistory',
  'confirmCleanupTitle',
  'confirmCleanupDesc',
  'cleanupSuccess',
  'cleanupFailed',
  'viewRemainingHistory',
  'collapseHistory',
];

function entry(id: string, timestamp: string) {
  return { id, timestamp, fromVersion: '2.2.0', toVersion: '2.3.0', success: true, kind: 'update' as const };
}

describe('sortHistoryDesc (runtime display-order contract)', () => {
  it('orders newest first regardless of input order, without mutating the input', () => {
    const input = [
      entry('old', '2026-10-01T10:00:00.000Z'),
      entry('new', '2026-10-07T10:00:00.000Z'),
      entry('mid', '2026-10-04T10:00:00.000Z'),
    ];
    const sorted = sortHistoryDesc(input as never[]);
    expect(sorted.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
    expect(input.map((e) => e.id)).toEqual(['old', 'new', 'mid']);
  });

  it('sorts unparseable timestamps stably at the oldest position (server factTimeMs parity)', () => {
    const sorted = sortHistoryDesc([
      entry('bad', 'not-a-date'),
      entry('new', '2026-10-07T10:00:00.000Z'),
    ] as never[]);
    expect(sorted.map((e) => e.id)).toEqual(['new', 'bad']);
  });
});

describe('validateUpdateHistoryPruneResult (runtime)', () => {
  it('accepts the server prune payload and keeps optional fields only when well-typed', () => {
    expect(validateUpdateHistoryPruneResult({ removed: 2, remaining: 5, prunedTransactionIds: [] })).toEqual({
      removed: 2,
      remaining: 5,
      prunedTransactionIds: [],
    });
    const full = validateUpdateHistoryPruneResult({
      removed: 2,
      remaining: 5,
      backupPath: 'C:/x/update-history.json.bak-prune',
      prunedTransactionIds: ['update-1-aaa'],
    });
    expect(full).toEqual({
      removed: 2,
      remaining: 5,
      backupPath: 'C:/x/update-history.json.bak-prune',
      prunedTransactionIds: ['update-1-aaa'],
    });
  });

  it('fails loud on missing counts, non-object shapes, and non-string ledger ids', () => {
    expect(validateUpdateHistoryPruneResult(null)).toBeNull();
    expect(validateUpdateHistoryPruneResult({ remaining: 5 })).toBeNull();
    expect(validateUpdateHistoryPruneResult({ removed: '2', remaining: 5 })).toBeNull();
    // rc-3: the ledger ids array is part of the contract — missing/malformed fails loud.
    expect(validateUpdateHistoryPruneResult({ removed: 1, remaining: 2 })).toBeNull();
    expect(validateUpdateHistoryPruneResult({ removed: 1, remaining: 2, prunedTransactionIds: 'none' })).toBeNull();
    expect(validateUpdateHistoryPruneResult({ removed: 1, remaining: 2, prunedTransactionIds: [42] })).toBeNull();
  });
});

describe('UpdatePage history display (source contract)', () => {
  it('renders the sorted, visibility-limited list — never the raw API order', () => {
    expect(PAGE_SOURCE).toContain('sortHistoryDesc(historyData.updates)');
    expect(PAGE_SOURCE).toContain('visibleHistory.map');
    expect(PAGE_SOURCE).not.toContain('historyData.updates.map');
    expect(PAGE_SOURCE).toContain('const COLLAPSED_HISTORY_LIMIT = 5;');
    expect(PAGE_SOURCE).toContain('sortedHistory.slice(0, COLLAPSED_HISTORY_LIMIT)');
  });

  it('the expand/collapse toggle is an accessible disclosure', () => {
    expect(PAGE_SOURCE).toContain('data-testid="update-history-toggle"');
    expect(PAGE_SOURCE).toContain('aria-expanded={showAllHistory}');
  });

  it('the cleanup action is gated above 5 entries and confirmed before mutating', () => {
    expect(PAGE_SOURCE).toContain('disabled={sortedHistory.length <= COLLAPSED_HISTORY_LIMIT || cleaningUp}');
    expect(PAGE_SOURCE).toContain('setShowCleanupDialog(true)');
    expect(PAGE_SOURCE).toContain('handleCleanupHistory');
    // The dialog copy reports how many entries will be deleted and derives the
    // retention number from the same constant as the logic (no hardcoded 5).
    expect(PAGE_SOURCE).toContain('confirmCleanupDesc", { count: hiddenHistoryCount, keep: COLLAPSED_HISTORY_LIMIT }');
    expect(PAGE_SOURCE).not.toMatch(/confirmCleanupDesc[^`]*最近 5|confirmCleanupDesc[^`]*the 5 most/);
  });

  it('uses the table PageShell column (the only cap that clears the 1312px paired threshold) — no default-width usage remains', () => {
    expect(PAGE_SOURCE).toContain('<PageShell width="table">');
    expect(PAGE_SOURCE).not.toContain('<PageShell>');
    expect(PAGE_SOURCE).toContain('update-reading-region');
    expect(PAGE_SOURCE).toContain('update-reading-columns');
  });

  it('the stylesheet pairs the columns by container query with the 640px reading floor', () => {
    expect(CSS_SOURCE).toContain('.update-reading-region');
    expect(CSS_SOURCE).toContain('.update-reading-columns');
    // Same threshold as .activation-reading-columns: 2 × 640px floor + gap.
    expect(CSS_SOURCE).toMatch(/@container \(min-width: 82rem\) \{\s*\.update-reading-columns/);
  });

  it('the cleanup copy exists in BOTH locales', () => {
    for (const locale of [EN, ZH]) {
      const update = getNestedRecord(locale, ['pages', 'update']);
      for (const key of CLEANUP_I18N_KEYS) {
        expect(Object.hasOwn(update, key)).toBe(true);
      }
    }
  });
});
