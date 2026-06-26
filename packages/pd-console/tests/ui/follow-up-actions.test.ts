/**
 * PRI-471: FollowUpActions component source-code contract tests.
 *
 * The vitest config in this package uses the `node` environment, so we cannot
 * render React components. Instead, we read the TSX source file and assert on
 * structural patterns — following the project's existing pattern (see
 * principle-review.test.ts, focus-page.test.ts).
 *
 * These tests verify the SPEC §22.1.4 contract:
 * - `observe` / `dismiss` decisions render no follow-up actions
 * - `confirm_drift` / `promote_to_principle` render the link-candidate UI
 * - `promote_to_rulehost` renders the CLI guidance UI
 * - `revise_intent` renders the read-only patch proposal UI
 * - All user-visible strings come from i18n keys (en + zh-CN)
 * - Accessibility: status messages use role="status" / role="alert"
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const UI_SRC = path.join(PKG_ROOT, 'src', 'ui');

let painPageSrc: string;
let apiSrc: string;
let validatorsSrc: string;
let enJson: Record<string, unknown>;
let zhJson: Record<string, unknown>;

beforeAll(() => {
  painPageSrc = fs.readFileSync(
    path.join(UI_SRC, 'pages', 'pain', 'PainPage.tsx'),
    'utf-8',
  );
  apiSrc = fs.readFileSync(path.join(UI_SRC, 'api.ts'), 'utf-8');
  validatorsSrc = fs.readFileSync(path.join(UI_SRC, 'utils', 'validators.ts'), 'utf-8');
  enJson = JSON.parse(fs.readFileSync(path.join(UI_SRC, 'i18n', 'en.json'), 'utf-8'));
  zhJson = JSON.parse(fs.readFileSync(path.join(UI_SRC, 'i18n', 'zh-CN.json'), 'utf-8'));
});

// ── Helper ──────────────────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function getPagesKey(key: string): unknown {
  return getNestedValue(enJson, 'pages.' + key);
}

function getPagesKeyZh(key: string): unknown {
  return getNestedValue(zhJson, 'pages.' + key);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. FollowUpActions component structure
// ════════════════════════════════════════════════════════════════════════════

describe('FollowUpActions component structure', () => {
  it('PainPage.tsx defines a FollowUpActions function component', () => {
    expect(painPageSrc).toMatch(/function FollowUpActions\s*\(/);
  });

  it('imports dispatchFollowUp from the api module', () => {
    // The import may be multi-line; just check dispatchFollowUp appears in an import from api
    expect(painPageSrc).toMatch(/import\s+\{[^}]*dispatchFollowUp[^}]*\}\s+from\s+['"][^'"]*api/);
  });

  it('imports FollowUpResponseData type for the response state', () => {
    expect(painPageSrc).toMatch(/FollowUpResponseData/);
  });

  it('FollowUpActions accepts the SPEC §22.1.4 props (decision, linkedCandidateId, onDecisionUpdated, t)', () => {
    // Match the props interface declaration
    expect(painPageSrc).toMatch(/interface FollowUpActionsProps/);
    expect(painPageSrc).toMatch(/decision:\s*IntentDecisionRecordData/);
    expect(painPageSrc).toMatch(/linkedCandidateId\?:\s*string/);
    expect(painPageSrc).toMatch(/onDecisionUpdated:\s*\(updated:\s*IntentDecisionRecordData\)\s*=>\s*void/);
    expect(painPageSrc).toMatch(/t:\s*\(key:\s*string\)\s*=>\s*string/);
  });

  it('reads the latest decision via existingDecisions[0] in OwnerDecisionPanel', () => {
    // PRI-471: the most recent decision drives which follow-up actions are shown
    expect(painPageSrc).toMatch(/latestDecision\s*=\s*existingDecisions\[0\]/);
  });

  it('renders FollowUpActions only when showFollowUp && latestDecision', () => {
    expect(painPageSrc).toMatch(/showFollowUp\s*&&\s*latestDecision/);
    expect(painPageSrc).toMatch(/<FollowUpActions/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. SPEC §22.1.4 — ownerAction routing
// ════════════════════════════════════════════════════════════════════════════

describe('FollowUpActions — SPEC §22.1.4 ownerAction routing', () => {
  it('returns null for observe (no follow-up actions)', () => {
    // Look for the early return guard
    expect(painPageSrc).toMatch(/ownerAction\s*===\s*['"]observe['"]\s*\|\|\s*ownerAction\s*===\s*['"]dismiss['"]/);
    expect(painPageSrc).toMatch(/return\s+null/);
  });

  it('returns null for dismiss (no follow-up actions)', () => {
    // Already covered by the combined check above, but explicitly assert dismiss
    expect(painPageSrc).toMatch(/['"]dismiss['"]/);
  });

  it('renders link-candidate UI for confirm_drift', () => {
    expect(painPageSrc).toMatch(/ownerAction\s*===\s*['"]confirm_drift['"]/);
    expect(painPageSrc).toMatch(/handleDispatch\(['"]link_candidate['"]\)/);
  });

  it('renders CLI guidance UI for promote_to_rulehost', () => {
    expect(painPageSrc).toMatch(/ownerAction\s*===\s*['"]promote_to_rulehost['"]/);
    expect(painPageSrc).toMatch(/handleDispatch\(['"]guide_rulehost['"]\)/);
  });

  it('renders read-only patch proposal UI for revise_intent', () => {
    expect(painPageSrc).toMatch(/ownerAction\s*===\s*['"]revise_intent['"]/);
    expect(painPageSrc).toMatch(/handleDispatch\(['"]generate_patch_proposal['"]\)/);
  });

  it('renders link-candidate UI for promote_to_principle (same chain as confirm_drift)', () => {
    // SPEC §22.1.4: promote_to_principle follows the same candidate/approval chain
    expect(painPageSrc).toMatch(/ownerAction\s*===\s*['"]promote_to_principle['"]/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. SPEC §22.1.4 — boundaries (no auto-apply, no new activation channel)
// ════════════════════════════════════════════════════════════════════════════

describe('FollowUpActions — SPEC §22.1.4 boundaries', () => {
  it('does not auto-apply the patch proposal (read-only display)', () => {
    // The patch proposal response is shown in a <pre> with a "Display only" badge
    expect(painPageSrc).toMatch(/response\.patchProposal\.markdown/);
    // There should be no code that writes to .principles/INTENT.md from the component
    expect(painPageSrc).not.toMatch(/writeFile.*INTENT\.md/);
    expect(painPageSrc).not.toMatch(/fs\.write.*INTENT/);
  });

  it('does not create a rule directly (guide_rulehost returns CLI command only)', () => {
    // The guide_rulehost branch should not contain any rule creation calls
    expect(painPageSrc).toMatch(/response\.cliCommand/);
    // No direct call to createRule or similar — only dispatchFollowUp
    expect(painPageSrc).not.toMatch(/createRule\(/);
    expect(painPageSrc).not.toMatch(/createApproval\(/);
  });

  it('link_candidate only records an audit link (no candidate creation)', () => {
    // The link_candidate branch should call dispatchFollowUp with type: 'link_candidate'
    // and not contain any candidate creation logic
    expect(painPageSrc).toMatch(/type:\s*['"]link_candidate['"]/);
    expect(painPageSrc).not.toMatch(/createCandidate\(/);
  });

  it('onDecisionUpdated propagates the updated record up (no direct state mutation)', () => {
    // The callback replaces the updated decision in the list
    expect(painPageSrc).toMatch(/onDecisionUpdated\(result\.data\.record\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Accessibility (EP-09)
// ════════════════════════════════════════════════════════════════════════════

describe('FollowUpActions — accessibility', () => {
  it('uses role="status" for success messages', () => {
    expect(painPageSrc).toMatch(/role="status"/);
  });

  it('uses role="alert" or aria-live for error messages', () => {
    // Either role="alert" on the error container, or aria-live="assertive"
    const hasAlert = painPageSrc.includes('role="alert"') || painPageSrc.includes('aria-live');
    expect(hasAlert).toBe(true);
  });

  it('candidateId input has an aria-label', () => {
    expect(painPageSrc).toMatch(/aria-label=\{t\(['"]pages\.pain\.followUpCandidateIdAriaLabel['"]\)\}/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. i18n — all user-visible strings come from i18n keys (EP-09)
// ════════════════════════════════════════════════════════════════════════════

describe('FollowUpActions — i18n keys present in en.json and zh-CN.json', () => {
  const REQUIRED_KEYS = [
    'followUpActionsTitle',
    'followUpDispatching',
    'followUpDispatchFailed',
    'followUpLinkCandidateDescription',
    'followUpLinkCandidateButton',
    'followUpCandidateIdPlaceholder',
    'followUpCandidateIdAriaLabel',
    'followUpPrefilledFromEvidenceChain',
    'followUpLinkedSuccess',
    'followUpGuideRulehostDescription',
    'followUpGuideRulehostButton',
    'followUpCliCommandLabel',
    'followUpPatchProposalDescription',
    'followUpViewPatchProposalButton',
    'followUpPatchProposalLabel',
    'followUpPatchProposalReadOnlyBadge',
    'followUpPatchProposalWarning',
    'followUpPromoteToPrincipleDescription',
  ];

  for (const key of REQUIRED_KEYS) {
    it(`en.json has pages.pain.${key}`, () => {
      const value = getPagesKey(`pain.${key}`);
      expect(value, `en.json missing pages.pain.${key}`).toBeDefined();
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    });

    it(`zh-CN.json has pages.pain.${key}`, () => {
      const value = getPagesKeyZh(`pain.${key}`);
      expect(value, `zh-CN.json missing pages.pain.${key}`).toBeDefined();
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    });
  }

  it('zh-CN strings do not contain bare "Owner" (governance: use 拥有者)', () => {
    // The zh-CN governance rule prohibits bare "Owner" — must use 拥有者
    const warning = getPagesKeyZh('pain.followUpPatchProposalWarning');
    expect(warning).toBeDefined();
    // The warning explicitly mentions 拥有者
    expect(warning as string).toContain('拥有者');
    expect(warning as string).not.toMatch(/\bOwner\b/);
  });

  it('zh-CN strings do not contain bare "Agent" (governance: use 智能体)', () => {
    const desc = getPagesKeyZh('pain.followUpGuideRulehostDescription');
    if (typeof desc === 'string' && desc.length > 0) {
      expect(desc).not.toMatch(/\bAgent\b/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. API client — dispatchFollowUp is exported and wired correctly
// ════════════════════════════════════════════════════════════════════════════

describe('dispatchFollowUp API client', () => {
  it('api.ts exports dispatchFollowUp', () => {
    // The function is declared as `async function dispatchFollowUp` (no `export`
    // prefix) and re-exported via a separate `export { ... }` block — both are
    // asserted separately to match the actual source structure in api.ts.
    expect(apiSrc).toMatch(/async\s+function\s+dispatchFollowUp/);
    // Also re-exported in the exports block
    expect(apiSrc).toMatch(/^\s*dispatchFollowUp,\s*$/m);
  });

  it('dispatchFollowUp calls POST /api/v1/intent-decisions/:id/follow-up', () => {
    expect(apiSrc).toMatch(/\/api\/v1\/intent-decisions\/\$\{encodeURIComponent\(decisionId\)\}\/follow-up/);
    expect(apiSrc).toMatch(/method:\s*['"]POST['"]/);
  });

  it('dispatchFollowUp uses validateFollowUpResponse as the validator', () => {
    expect(apiSrc).toMatch(/validateFollowUpResponse/);
  });

  it('FollowUpPayload type is exported with the three allowed types', () => {
    expect(apiSrc).toMatch(/export interface FollowUpPayload/);
    // The `type` field uses separately-quoted union members:
    //   type: 'link_candidate' | 'guide_rulehost' | 'generate_patch_proposal';
    expect(apiSrc).toMatch(/type:\s*'link_candidate'\s*\|\s*'guide_rulehost'\s*\|\s*'generate_patch_proposal'/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Validators — validateFollowUpResponse is exported and structured
// ════════════════════════════════════════════════════════════════════════════

describe('validateFollowUpResponse validator', () => {
  it('validators.ts exports validateFollowUpResponse', () => {
    expect(validatorsSrc).toMatch(/export function validateFollowUpResponse/);
  });

  it('exports the three discriminated union response data types', () => {
    expect(validatorsSrc).toMatch(/export interface LinkCandidateFollowUpData/);
    expect(validatorsSrc).toMatch(/export interface GuideRulehostFollowUpData/);
    expect(validatorsSrc).toMatch(/export interface GeneratePatchProposalFollowUpData/);
  });

  it('FollowUpResponseData is a union of the three types', () => {
    expect(validatorsSrc).toMatch(/export type FollowUpResponseData\s*=/);
    expect(validatorsSrc).toMatch(/LinkCandidateFollowUpData/);
    expect(validatorsSrc).toMatch(/GuideRulehostFollowUpData/);
    expect(validatorsSrc).toMatch(/GeneratePatchProposalFollowUpData/);
  });

  it('FOLLOW_UP_RESPONSE_TYPES set contains the three allowed values', () => {
    expect(validatorsSrc).toMatch(/FOLLOW_UP_RESPONSE_TYPES/);
    expect(validatorsSrc).toMatch(/'link_candidate'/);
    expect(validatorsSrc).toMatch(/'guide_rulehost'/);
    expect(validatorsSrc).toMatch(/'generate_patch_proposal'/);
  });
});
