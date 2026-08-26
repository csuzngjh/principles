import { describe, expect, it } from 'vitest';
import en from '../../src/ui/i18n/en.json';
import zhCN from '../../src/ui/i18n/zh-CN.json';

describe('Activation i18n key alignment', () => {
  it('has identical checks keys in en and zh-CN', () => {
    const enChecks = Object.keys(en.pages.activation.checks).sort();
    const zhChecks = Object.keys(zhCN.pages.activation.checks).sort();
    expect(zhChecks).toEqual(enChecks);
  });

  it('has identical checkStatus keys in en and zh-CN', () => {
    const enStatus = Object.keys(en.pages.activation.checkStatus).sort();
    const zhStatus = Object.keys(zhCN.pages.activation.checkStatus).sort();
    expect(zhStatus).toEqual(enStatus);
  });

  it('has identical reasonCodes keys in en and zh-CN', () => {
    const enReasonCodes = Object.keys(en.pages.activation.reasonCodes).sort();
    const zhReasonCodes = Object.keys(zhCN.pages.activation.reasonCodes).sort();
    expect(zhReasonCodes).toEqual(enReasonCodes);
  });

  it('has non-empty translations for all activation keys', () => {
    for (const [, value] of Object.entries(en.pages.activation.checks)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
    for (const [, value] of Object.entries(zhCN.pages.activation.checks)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
    for (const [, value] of Object.entries(en.pages.activation.reasonCodes)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
    for (const [, value] of Object.entries(zhCN.pages.activation.reasonCodes)) {
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  // Production reasonCodes statically emitted by principles-core promotion
  // paths: promotion-readiness-reader.ts, promotion-readiness-evaluator.ts,
  // openclaw-promotion-checks.ts, rulecode-owner-decision-service.ts.
  // Dynamic gate.reason values from RuleHostWriter.canActivate are not
  // enumerable here; unknown codes fall back to the raw identifier via the
  // t() defaultValue in ActivationPage.
  const PRODUCTION_REASON_CODES = [
    'activation_artifact_mismatch',
    'activation_not_unique',
    'active_shadow_activation_required',
    'artifact_digest_mismatch',
    'artifact_lineage_missing',
    'artifact_not_found',
    'cli_owner_note_required',
    'configured_owner_missing',
    'confirmation_required',
    'duplicate_check_result',
    'evidence_override_note_required',
    'evidence_override_reason_required',
    'explicit_affected_tools_required',
    'feature_not_enabled',
    'hard_check_failed',
    'host_liveness_contract_missing_invalid_or_unsupported',
    'neutral_probe_or_live_composition_failed',
    'out_of_band_controls_unavailable',
    'owner_authentication_required',
    'promotion_commit_failed',
    'promotion_readiness_unavailable',
    'promotion_request_invalid',
    'promotion_safety_gate_blocked',
    'promotion_snapshot_stale',
    'required_check_missing',
    'safety_controls_disabled',
    'safety_controls_unavailable',
    'shadow_telemetry_source_unavailable',
    'unresolved_shadow_unhealthy_evidence',
  ];

  it('covers every statically emitted production reasonCode in both locales', () => {
    for (const code of PRODUCTION_REASON_CODES) {
      expect(en.pages.activation.reasonCodes, `en missing ${code}`).toHaveProperty(code);
      expect(zhCN.pages.activation.reasonCodes, `zh-CN missing ${code}`).toHaveProperty(code);
    }
  });
});
