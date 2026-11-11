// SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.6.4 — source display tiers (real UI)
//
// This is the "actually render EvidenceChainCard" test that the pure-function
// suite cannot provide: the package has no jsdom / @testing-library, so the
// only way to assert what the Owner sees is the real browser + the real
// /api/evidence-chain read model.
//
// Seeded by scripts/e2e-seed.ts:
// - pain-e2e-mcp-authorized  mcp_agent_assisted + agent_reported_owner_approved
// - pain-e2e-mcp-unverified  mcp_agent_assisted + no provenance
// - pain-e2e-1               manual + no provenance (historical record)
//
// The "diagnostic_json cannot be parsed" path cannot be seeded through SQLite
// (the tasks table rejects malformed JSON), so it is covered in
// evidence-chain-provenance.test.ts and evidence-chain-console-model.test.ts.
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = `http://127.0.0.1:${process.env.PD_CONSOLE_E2E_PORT ?? '3101'}`;

interface EvidenceRecordShape {
  id: string;
  canonicalPainId: string;
  sourceKind?: string;
  provenance?: string;
  state?: string;
}

const INTERNAL_ENUM_LITERALS = [
  'mcp_agent_assisted',
  'agent_reported_owner_approved',
  'host_context_bound',
  'owner_reported_no_host_trace',
  'automatic_hook',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = Object.getOwnPropertyDescriptor(source, key)?.value;
  return typeof value === 'string' ? value : undefined;
}

async function fetchRecordsByCanonicalPainId(): Promise<Map<string, EvidenceRecordShape>> {
  const resp = await fetch(`${BASE_URL}/api/evidence-chain`);
  expect(resp.status, 'GET /api/evidence-chain should succeed').toBe(200);
  const payload: unknown = await resp.json();
  expect(isRecord(payload), 'evidence-chain response should be an object').toBe(true);
  if (!isRecord(payload)) return new Map();

  const data = Object.getOwnPropertyDescriptor(payload, 'data')?.value;
  const records = isRecord(data) ? Object.getOwnPropertyDescriptor(data, 'records')?.value : undefined;
  expect(Array.isArray(records), 'evidence-chain data.records should be an array').toBe(true);

  const map = new Map<string, EvidenceRecordShape>();
  for (const raw of Array.isArray(records) ? records : []) {
    if (!isRecord(raw)) continue;
    const id = readString(raw, 'id');
    const canonicalPainId = readString(raw, 'canonicalPainId');
    if (!id || !canonicalPainId) continue;
    map.set(canonicalPainId, {
      id,
      canonicalPainId,
      sourceKind: readString(raw, 'sourceKind'),
      provenance: readString(raw, 'provenance'),
      state: readString(raw, 'state'),
    });
  }
  return map;
}

function requireRecord(map: Map<string, EvidenceRecordShape>, canonicalPainId: string): EvidenceRecordShape {
  const record = map.get(canonicalPainId);
  if (!record) throw new Error(`[e2e] seeded pain record missing: ${canonicalPainId}`);
  return record;
}

async function openPainPage(page: Page, lang: 'zh-CN' | 'en'): Promise<void> {
  await page.addInitScript((value: string) => {
    localStorage.setItem('pd-language', value);
  }, lang);
  await page.goto('/#/pain');
  await page.waitForLoadState('networkidle');
  await page.locator('[data-testid^="pain-provenance-"]').first().waitFor();
}

test.describe('PainPage — provenance / source display tiers', () => {
  test('zh-CN: verified, unverified and legacy records render distinct neutral wording', async ({ page }) => {
    const records = await fetchRecordsByCanonicalPainId();
    const authorized = requireRecord(records, 'pain-e2e-mcp-authorized');
    const unverified = requireRecord(records, 'pain-e2e-mcp-unverified');
    const historical = requireRecord(records, 'pain-e2e-1');
    const manualSubmission = requireRecord(records, 'pain-e2e-design-gate');

    // Preconditions from the read model itself (not from the helper).
    expect(authorized.provenance).toBe('agent_reported_owner_approved');
    expect(authorized.sourceKind).toBe('mcp_agent_assisted');
    expect(unverified.sourceKind).toBe('mcp_agent_assisted');
    expect(unverified.provenance).toBeUndefined();
    expect(historical.sourceKind).toBe('manual');
    expect(historical.provenance).toBeUndefined();
    expect(manualSubmission.sourceKind).toBe('manual');
    expect(manualSubmission.provenance).toBeUndefined();

    await openPainPage(page, 'zh-CN');

    const authorizedBadge = page.locator(`[data-testid="pain-provenance-${authorized.id}"]`);
    await expect(authorizedBadge).toHaveAttribute('data-provenance-kind', 'authorized_agent_report');
    await expect(authorizedBadge).toHaveText('智能体报告，拥有者已授权');

    const unverifiedBadge = page.locator(`[data-testid="pain-provenance-${unverified.id}"]`);
    await expect(unverifiedBadge).toHaveAttribute('data-provenance-kind', 'unverified_agent_report');
    await expect(unverifiedBadge).toHaveText('智能体报告（授权信息不可验证）');
    // Missing provenance must never be labelled as Owner authorization.
    await expect(unverifiedBadge).not.toContainText('已授权');

    // Historical manual record keeps its pre-existing label.
    const historicalBadge = page.locator(`[data-testid="pain-provenance-${historical.id}"]`);
    await expect(historicalBadge).toHaveAttribute('data-provenance-kind', 'source_kind');
    await expect(historicalBadge).toHaveText('手动触发');

    // Ordinary Owner-submitted pain keeps its pre-existing label too.
    const manualBadge = page.locator(`[data-testid="pain-provenance-${manualSubmission.id}"]`);
    await expect(manualBadge).toHaveAttribute('data-provenance-kind', 'source_kind');
    await expect(manualBadge).toHaveText('手动触发');

    // No internal enum literal reaches the Owner, and no agent report is
    // presented as the Owner's own observation.
    const bodyText = await page.locator('body').innerText();
    for (const literal of INTERNAL_ENUM_LITERALS) {
      expect(bodyText, `internal enum leaked into the page: ${literal}`).not.toContain(literal);
    }
    expect(bodyText).not.toContain('拥有者亲自观察');
    expect(bodyText).not.toContain('拥有者观察');
  });

  test('en: the same tiers render English wording without enums', async ({ page }) => {
    const records = await fetchRecordsByCanonicalPainId();
    const authorized = requireRecord(records, 'pain-e2e-mcp-authorized');
    const unverified = requireRecord(records, 'pain-e2e-mcp-unverified');
    const historical = requireRecord(records, 'pain-e2e-1');

    await openPainPage(page, 'en');

    const authorizedBadge = page.locator(`[data-testid="pain-provenance-${authorized.id}"]`);
    await expect(authorizedBadge).toHaveAttribute('data-provenance-kind', 'authorized_agent_report');
    await expect(authorizedBadge).toHaveText('Reported by an agent, authorized by the Owner');

    const unverifiedBadge = page.locator(`[data-testid="pain-provenance-${unverified.id}"]`);
    await expect(unverifiedBadge).toHaveAttribute('data-provenance-kind', 'unverified_agent_report');
    await expect(unverifiedBadge).toHaveText('Agent-reported (authorization unverified)');
    await expect(unverifiedBadge).not.toContainText('authorized by the Owner');

    // Pre-existing behavior: the local enum map is zh-only, so `manual` keeps
    // its Chinese label in English UI. This PR must not change it.
    const historicalBadge = page.locator(`[data-testid="pain-provenance-${historical.id}"]`);
    await expect(historicalBadge).toHaveAttribute('data-provenance-kind', 'source_kind');
    await expect(historicalBadge).toHaveText('手动触发');

    const bodyText = await page.locator('body').innerText();
    for (const literal of INTERNAL_ENUM_LITERALS) {
      expect(bodyText, `internal enum leaked into the page: ${literal}`).not.toContain(literal);
    }
    expect(bodyText.toLowerCase()).not.toContain('owner observed');
  });

  test('expanding technical details shows the safe source label, never the raw enum', async ({ page }) => {
    const records = await fetchRecordsByCanonicalPainId();
    const authorized = requireRecord(records, 'pain-e2e-mcp-authorized');
    const historical = requireRecord(records, 'pain-e2e-1');

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openPainPage(page, 'zh-CN');

    const expandedLabels: Array<[EvidenceRecordShape, string]> = [
      [authorized, '智能体报告，拥有者已授权'],
      [historical, '手动触发'],
    ];

    for (const [record, expectedLabel] of expandedLabels) {
      const details = page.locator(`[data-testid="pain-tech-details-${record.id}"]`);
      await expect(details).toHaveCount(0);
      await page.locator(`[data-testid="pain-expand-${record.id}"]`).click();
      await expect(details).toBeVisible();
      await expect(details).toContainText('来源类型');
      // Layer 3 is Owner-facing too (SPEC §6.6.4): it must show the same safe
      // label as Layer 1, not the internal source kind enum.
      await expect(details).toContainText(expectedLabel);
      const detailsText = await details.innerText();
      for (const literal of INTERNAL_ENUM_LITERALS) {
        expect(detailsText, `internal enum leaked into technical details: ${literal}`).not.toContain(literal);
      }
      await page.locator(`[data-testid="pain-expand-${record.id}"]`).click();
      await expect(details).toHaveCount(0);
    }

    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('copying the debug summary never leaks the raw source kind', async ({ page }) => {
    const records = await fetchRecordsByCanonicalPainId();
    const authorized = requireRecord(records, 'pain-e2e-mcp-authorized');
    const unverified = requireRecord(records, 'pain-e2e-mcp-unverified');

    // Capture clipboard writes instead of touching the real clipboard.
    await page.addInitScript(() => {
      const captured: string[] = [];
      Object.defineProperty(window, '__pdCopied', { value: captured });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            captured.push(text);
          },
        },
      });
    });

    await openPainPage(page, 'zh-CN');

    const copiedRecords = [authorized, unverified];

    for (const record of copiedRecords) {
      // The copy button is the first button in the Layer 3 action row.
      const copyButton = page
        .locator(`[data-testid="pain-expand-${record.id}"]`)
        .locator('xpath=..')
        .getByRole('button')
        .first();
      await copyButton.click();
    }

    const copied = await page.evaluate(
      () => (window as unknown as { __pdCopied: string[] }).__pdCopied,
    );
    expect(copied).toHaveLength(2);

    const [authorizedCopy, unverifiedCopy] = copied;
    expect(authorizedCopy).toContain('source_kind: 智能体报告，拥有者已授权');
    expect(unverifiedCopy).toContain('source_kind: 智能体报告（授权信息不可验证）');
    for (const text of copied) {
      for (const literal of INTERNAL_ENUM_LITERALS) {
        expect(text, `internal enum leaked into the copied debug summary: ${literal}`).not.toContain(literal);
      }
    }
  });
});
