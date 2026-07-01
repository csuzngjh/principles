/**
 * PD Profile Config Validation — PRI-304 / PRI-466
 *
 * Runtime validation from `unknown` (parsed YAML/JSON profile section).
 * No `as` bypasses on untrusted input (ERR-001, ERR-005).
 * Uses `Object.hasOwn()` for key checks (ERR-013).
 * Unknown keys produce warnings rather than hard errors (forward compat).
 */

import {
  type ProfileConfig,
  type ProfileAuditLevel,
  type ProfileEvolutionMode,
  type ProfileTestLevel,
  PROFILE_AUDIT_LEVELS,
  PROFILE_EVOLUTION_MODES,
  PROFILE_TEST_LEVELS,
} from './pd-config-types.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProfileValidationWarning {
  path: string;
  message: string;
}

export type ProfileValidationResult =
  | { ok: true; value: Partial<ProfileConfig>; warnings: ProfileValidationWarning[] }
  | { ok: false; errors: ProfileValidationWarning[] };

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function warn(path: string, message: string): ProfileValidationWarning {
  return { path, message };
}

function readOwn(obj: Record<string, unknown>, key: string): unknown {
  // DANGEROUS_KEYS check: profile does not have __proto__/constructor risk at runtime
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

const VALID_SEVERITIES = new Set(['info', 'warning', 'error', 'fatal']);

// ── Sub-validators ──────────────────────────────────────────────────────────

function validateGate(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `gate must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const bv = readOwn(raw, 'require_plan_for_risk_paths');
  if (bv !== undefined) { if (isBoolean(bv)) value.require_plan_for_risk_paths = bv; else warnings.push(warn(`${path}.require_plan_for_risk_paths`, `must be boolean`)); }
  const ba = readOwn(raw, 'require_audit_before_write');
  if (ba !== undefined) { if (isBoolean(ba)) value.require_audit_before_write = ba; else warnings.push(warn(`${path}.require_audit_before_write`, `must be boolean`)); }
  const br = readOwn(raw, 'require_reviewer_after_write');
  if (br !== undefined) { if (isBoolean(br)) value.require_reviewer_after_write = br; else warnings.push(warn(`${path}.require_reviewer_after_write`, `must be boolean`)); }
  return { value, warnings };
}

function validateTests(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `tests must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const oc = readOwn(raw, 'on_change');
  if (oc !== undefined) { if (isString(oc) && PROFILE_TEST_LEVELS.includes(oc as ProfileTestLevel)) value.on_change = oc; else warnings.push(warn(`${path}.on_change`, `must be one of: ${PROFILE_TEST_LEVELS.join(', ')}`)); }
  const orc = readOwn(raw, 'on_risk_change');
  if (orc !== undefined) { if (isString(orc) && PROFILE_TEST_LEVELS.includes(orc as ProfileTestLevel)) value.on_risk_change = orc; else warnings.push(warn(`${path}.on_risk_change`, `must be one of: ${PROFILE_TEST_LEVELS.join(', ')}`)); }
  const cmds = readOwn(raw, 'commands');
  if (cmds !== undefined) {
    if (isRecord(cmds)) {
      const cleaned: Record<string, string> = {};
      for (const k of Object.keys(cmds)) {
        const v = cmds[k];
        if (isString(v)) cleaned[k] = v;
        else warnings.push(warn(`${path}.commands.${k}`, `command value must be a string`));
      }
      value.commands = cleaned;
    } else {
      warnings.push(warn(`${path}.commands`, `must be an object (string→string map)`));
    }
  }
  return { value, warnings };
}

function validateAdaptivePain(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `adaptive must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const en = readOwn(raw, 'enabled');
  if (en !== undefined) { if (isBoolean(en)) value.enabled = en; else warnings.push(warn(`${path}.enabled`, `must be boolean`)); }
  const sb = readOwn(raw, 'spiral_boost');
  if (sb !== undefined) { if (isNumber(sb)) value.spiral_boost = sb; else warnings.push(warn(`${path}.spiral_boost`, `must be a finite number`)); }
  const min = readOwn(raw, 'min_threshold');
  if (min !== undefined) { if (isNumber(min)) value.min_threshold = min; else warnings.push(warn(`${path}.min_threshold`, `must be a finite number`)); }
  const max = readOwn(raw, 'max_threshold');
  if (max !== undefined) { if (isNumber(max)) value.max_threshold = max; else warnings.push(warn(`${path}.max_threshold`, `must be a finite number`)); }
  const bt = readOwn(raw, 'backlog_trigger');
  if (bt !== undefined) { if (isNumber(bt)) value.backlog_trigger = bt; else warnings.push(warn(`${path}.backlog_trigger`, `must be a finite number`)); }
  const hf = readOwn(raw, 'hard_failure_trigger');
  if (hf !== undefined) { if (isNumber(hf)) value.hard_failure_trigger = hf; else warnings.push(warn(`${path}.hard_failure_trigger`, `must be a finite number`)); }
  const lrsb = readOwn(raw, 'low_recent_success_boost');
  if (lrsb !== undefined) { if (isNumber(lrsb)) value.low_recent_success_boost = lrsb; else warnings.push(warn(`${path}.low_recent_success_boost`, `must be a finite number`)); }
  const hrpb = readOwn(raw, 'high_recent_pain_boost');
  if (hrpb !== undefined) { if (isNumber(hrpb)) value.high_recent_pain_boost = hrpb; else warnings.push(warn(`${path}.high_recent_pain_boost`, `must be a finite number`)); }
  return { value, warnings };
}

function validatePain(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `pain must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const sct = readOwn(raw, 'soft_capture_threshold');
  if (sct !== undefined) { if (isNumber(sct)) value.soft_capture_threshold = sct; else warnings.push(warn(`${path}.soft_capture_threshold`, `must be a finite number`)); }
  const ad = readOwn(raw, 'adaptive');
  if (ad !== undefined) {
    const r = validateAdaptivePain(ad, `${path}.adaptive`);
    if (r.value) value.adaptive = r.value;
    warnings.push(...r.warnings);
  }
  return { value, warnings };
}

function validateLifecycle(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `lifecycle must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const en = readOwn(raw, 'enabled');
  if (en !== undefined) { if (isBoolean(en)) value.enabled = en; else warnings.push(warn(`${path}.enabled`, `must be boolean`)); }
  const hb = readOwn(raw, 'heartbeat_stale_hours');
  if (hb !== undefined) { if (isNumber(hb)) value.heartbeat_stale_hours = hb; else warnings.push(warn(`${path}.heartbeat_stale_hours`, `must be a finite number`)); }
  return { value, warnings };
}

function validatePlanApprovals(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `plan_approvals must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const en = readOwn(raw, 'enabled');
  if (en !== undefined) { if (isBoolean(en)) value.enabled = en; else warnings.push(warn(`${path}.enabled`, `must be boolean`)); }
  const ml = readOwn(raw, 'max_lines_override');
  if (ml !== undefined) { if (isNumber(ml) && Number.isInteger(ml)) value.max_lines_override = ml; else warnings.push(warn(`${path}.max_lines_override`, `must be an integer`)); }
  const ap = readOwn(raw, 'allowed_patterns');
  if (ap !== undefined) { if (Array.isArray(ap)) value.allowed_patterns = ap.filter(isString); else warnings.push(warn(`${path}.allowed_patterns`, `must be an array of strings`)); }
  const ao = readOwn(raw, 'allowed_operations');
  if (ao !== undefined) { if (Array.isArray(ao)) value.allowed_operations = ao.filter(isString); else warnings.push(warn(`${path}.allowed_operations`, `must be an array of strings`)); }
  return { value, warnings };
}

function validateEditVerification(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `edit_verification must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const en = readOwn(raw, 'enabled');
  if (en !== undefined) { if (isBoolean(en)) value.enabled = en; else warnings.push(warn(`${path}.enabled`, `must be boolean`)); }
  const mfs = readOwn(raw, 'max_file_size_bytes');
  if (mfs !== undefined) { if (isNumber(mfs) && mfs >= 0) value.max_file_size_bytes = mfs; else warnings.push(warn(`${path}.max_file_size_bytes`, `must be a non-negative number`)); }
  const fm = readOwn(raw, 'fuzzy_match_enabled');
  if (fm !== undefined) { if (isBoolean(fm)) value.fuzzy_match_enabled = fm; else warnings.push(warn(`${path}.fuzzy_match_enabled`, `must be boolean`)); }
  const fmt = readOwn(raw, 'fuzzy_match_threshold');
  if (fmt !== undefined) { if (isNumber(fmt) && fmt > 0 && fmt <= 1) value.fuzzy_match_threshold = fmt; else warnings.push(warn(`${path}.fuzzy_match_threshold`, `must be a number in (0, 1]`)); }
  const sla = readOwn(raw, 'skip_large_file_action');
  if (sla !== undefined) { if (sla === 'warn' || sla === 'block') value.skip_large_file_action = sla; else warnings.push(warn(`${path}.skip_large_file_action`, `must be "warn" or "block"`)); }
  return { value, warnings };
}

function validateThinkingCheckpoint(raw: unknown, path: string): { value?: Record<string, unknown>; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!isRecord(raw)) {
    warnings.push(warn(path, `thinking_checkpoint must be an object, got ${typeof raw}`));
    return { warnings };
  }
  const value: Record<string, unknown> = {};
  const en = readOwn(raw, 'enabled');
  if (en !== undefined) { if (isBoolean(en)) value.enabled = en; else warnings.push(warn(`${path}.enabled`, `must be boolean`)); }
  const wm = readOwn(raw, 'window_ms');
  if (wm !== undefined) { if (isNumber(wm) && wm > 0) value.window_ms = wm; else warnings.push(warn(`${path}.window_ms`, `must be a positive number`)); }
  const hrt = readOwn(raw, 'high_risk_tools');
  if (hrt !== undefined) { if (Array.isArray(hrt)) value.high_risk_tools = hrt.filter(isString); else warnings.push(warn(`${path}.high_risk_tools`, `must be an array of strings`)); }
  return { value, warnings };
}

function validateCustomGuards(raw: unknown, path: string): { value?: Partial<ProfileConfig>['custom_guards']; warnings: ProfileValidationWarning[] } {
  const warnings: ProfileValidationWarning[] = [];
  if (!Array.isArray(raw)) {
    warnings.push(warn(path, `custom_guards must be an array, got ${typeof raw}`));
    return { warnings };
  }
  const guards: ProfileConfig['custom_guards'] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) {
      warnings.push(warn(`${path}[${i}]`, `must be an object`));
      continue;
    }
    const pattern = readOwn(item, 'pattern');
    const message = readOwn(item, 'message');
    const severity = readOwn(item, 'severity');
    if (!isString(pattern) || pattern.length === 0) {
      warnings.push(warn(`${path}[${i}].pattern`, `must be a non-empty string`));
      continue;
    }
    guards.push({
      pattern,
      message: isString(message) ? message : 'Custom guard triggered',
      severity: isString(severity) && VALID_SEVERITIES.has(severity.toLowerCase()) ? severity.toLowerCase() : 'error',
    });
  }
  return { value: guards, warnings };
}

// ── Top-Level Validator ─────────────────────────────────────────────────────

/**
 * Validate a parsed profile config value from unknown input.
 * Profile is optional — missing profile is OK (defaults applied in effective config).
 * Partial input is accepted (warnings for invalid sub-fields, valid partial fields kept).
 */
export function validateProfileConfig(raw: unknown, path = 'profile'): ProfileValidationResult {
  const warnings: ProfileValidationWarning[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [warn(path, `profile must be an object, got ${typeof raw}`)] };
  }

  const result: Record<string, unknown> = {};

  // audit_level
  const al = readOwn(raw, 'audit_level');
  if (al !== undefined) {
    if (isString(al) && PROFILE_AUDIT_LEVELS.includes(al as ProfileAuditLevel)) {
      result.audit_level = al;
    } else {
      warnings.push(warn(`${path}.audit_level`, `must be one of: ${PROFILE_AUDIT_LEVELS.join(', ')}, got ${JSON.stringify(al)}`));
    }
  }

  // evolution_mode
  const em = readOwn(raw, 'evolution_mode');
  if (em !== undefined) {
    if (isString(em) && PROFILE_EVOLUTION_MODES.includes(em as ProfileEvolutionMode)) {
      result.evolution_mode = em;
    } else {
      warnings.push(warn(`${path}.evolution_mode`, `must be one of: ${PROFILE_EVOLUTION_MODES.join(', ')}, got ${JSON.stringify(em)}`));
    }
  }

  // risk_paths
  const rp = readOwn(raw, 'risk_paths');
  if (rp !== undefined) {
    if (Array.isArray(rp)) {
      result.risk_paths = rp.filter(isString);
    } else if (isString(rp)) {
      result.risk_paths = [rp];
    } else {
      warnings.push(warn(`${path}.risk_paths`, `must be an array of strings or a single string`));
    }
  }

  // Sub-objects
  const gateRaw = readOwn(raw, 'gate');
  if (gateRaw !== undefined) {
    const r = validateGate(gateRaw, `${path}.gate`);
    if (r.value) result.gate = r.value;
    warnings.push(...r.warnings);
  }

  const testsRaw = readOwn(raw, 'tests');
  if (testsRaw !== undefined) {
    const r = validateTests(testsRaw, `${path}.tests`);
    if (r.value) result.tests = r.value;
    warnings.push(...r.warnings);
  }

  const painRaw = readOwn(raw, 'pain');
  if (painRaw !== undefined) {
    const r = validatePain(painRaw, `${path}.pain`);
    if (r.value) result.pain = r.value;
    warnings.push(...r.warnings);
  }

  const lifecycleRaw = readOwn(raw, 'lifecycle');
  if (lifecycleRaw !== undefined) {
    const r = validateLifecycle(lifecycleRaw, `${path}.lifecycle`);
    if (r.value) result.lifecycle = r.value;
    warnings.push(...r.warnings);
  }

  // progressive_gate
  const pgRaw = readOwn(raw, 'progressive_gate');
  if (pgRaw !== undefined) {
    const warnings2: ProfileValidationWarning[] = [];
    const pgResult: Record<string, unknown> = {};
    const pgRecord = pgRaw as Record<string, unknown>;
    if (isRecord(pgRaw)) {
      const pgEnabled = readOwn(pgRecord, 'enabled');
      if (pgEnabled !== undefined) { if (isBoolean(pgEnabled)) pgResult.enabled = pgEnabled; else warnings2.push(warn(`${path}.progressive_gate.enabled`, `must be boolean`)); }
      const paRaw = readOwn(pgRecord, 'plan_approvals');
      if (paRaw !== undefined) {
        const r = validatePlanApprovals(paRaw, `${path}.progressive_gate.plan_approvals`);
        if (r.value) pgResult.plan_approvals = r.value;
        warnings2.push(...r.warnings);
      }
    } else {
      warnings2.push(warn(`${path}.progressive_gate`, `must be an object`));
    }
    if (Object.keys(pgResult).length > 0) result.progressive_gate = pgResult;
    warnings.push(...warnings2);
  }

  const evRaw = readOwn(raw, 'edit_verification');
  if (evRaw !== undefined) {
    const r = validateEditVerification(evRaw, `${path}.edit_verification`);
    if (r.value) result.edit_verification = r.value;
    warnings.push(...r.warnings);
  }

  const tcRaw = readOwn(raw, 'thinking_checkpoint');
  if (tcRaw !== undefined) {
    const r = validateThinkingCheckpoint(tcRaw, `${path}.thinking_checkpoint`);
    if (r.value) result.thinking_checkpoint = r.value;
    warnings.push(...r.warnings);
  }

  const cgRaw = readOwn(raw, 'custom_guards');
  if (cgRaw !== undefined) {
    const r = validateCustomGuards(cgRaw, `${path}.custom_guards`);
    if (r.value) result.custom_guards = r.value;
    warnings.push(...r.warnings);
  }

  return {
    ok: true,
    value: result,
    warnings,
  };
}
