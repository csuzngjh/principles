/**
 * P2-1 — the review card learns about a strategic fence from the server payload,
 * but only if the UI validator keeps it. The allowed-code list omitted
 * `strategic_conflict_unconfirmed`, so the block was silently dropped for EVERY
 * channel: the server refused the write while the card offered a working button.
 *
 * These cases pin both halves: the strategic code survives validation on all
 * three channels, and an unknown code is still dropped (the guard is not a
 * permissive passthrough).
 */
import { describe, expect, it } from 'vitest';
import { validateApprovalsGrouped } from '../../src/ui/utils/validators.js';
import en from '../../src/ui/i18n/en.json';
import zhCN from '../../src/ui/i18n/zh-CN.json';

const CHANNELS = ['prompt', 'code_tool_hook', 'defer_archive'] as const;

const BLOCK = {
  code: 'strategic_conflict_unconfirmed',
  reason: 'conflict_status_mismatch: declared confirmed but the list aggregates to potential',
  nextAction: 're-form the candidate so the server recomputes conflictStatus',
};

function payload(code: string): unknown {
  return {
    generatedAt: '2026-11-15T00:00:00.000Z',
    groups: [{
      principleId: 'principle-intent',
      principleTitle: 'Intent-conflict material',
      status: 'pending',
      records: CHANNELS.map((channel) => ({
        id: `apr-${channel}`,
        artifactId: `artifact-${channel}`,
        channel,
        createdAt: '2026-11-15T00:00:00.000Z',
        status: 'pending',
        approveBlock: { ...BLOCK, code },
        strategicConflict: {
          isV2: true,
          relevance: 'relevant',
          conflictStatus: 'confirmed',
          conflicts: [],
          resolved: false,
          blockCode: 'strategic_conflict_unconfirmed',
          reason: BLOCK.reason,
          nextAction: 're-form the candidate',
        },
      })),
    }],
  };
}

function recordsOf(validated: ReturnType<typeof validateApprovalsGrouped>) {
  return validated?.groups[0]?.records ?? [];
}

describe('approveBlock validation — strategic conflict survives every channel', () => {
  it.each(CHANNELS)('keeps the strategic fence for the %s channel', (channel) => {
    const records = recordsOf(validateApprovalsGrouped(payload(BLOCK.code)));
    const record = records.find((entry) => entry.channel === channel);
    expect(record?.approveBlock).toEqual(BLOCK);
  });

  it('still drops an unknown block code', () => {
    const records = recordsOf(validateApprovalsGrouped(payload('made_up_code')));
    expect(records.every((record) => record.approveBlock === undefined)).toBe(true);
  });
});

describe('strategic block copy — localized, never an i18next key', () => {
  const copy = (locale: typeof en, key: string): unknown => {
    const review = locale.pages?.review as Record<string, unknown> | undefined;
    const blocked = review?.approveBlocked as Record<string, unknown> | undefined;
    return blocked?.[key];
  };

  it.each([
    ['zh-CN', zhCN, '战略冲突', '任何已有决策都不能修复'],
    ['en', en, 'strategic conflict', 'no existing decision can repair'],
  ] as const)('%s explains the block and the integrity case', (_label, locale, blockedFragment, integrityFragment) => {
    const blocked = copy(locale, 'strategic_conflict_unconfirmed');
    const integrity = copy(locale, 'integrityConflict');
    expect(typeof blocked).toBe('string');
    expect(typeof integrity).toBe('string');
    expect(blocked as string).toContain(blockedFragment);
    expect(integrity as string).toContain(integrityFragment);
    // A missing key would surface as the key path itself.
    expect(blocked as string).not.toContain('pages.review');
    expect(integrity as string).not.toContain('approveBlocked');
  });
});
