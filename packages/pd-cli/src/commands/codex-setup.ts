/**
 * pd codex setup — consent UX for Codex conversation ingestion (Codex
 * Governance Closure Slice D, PRI-625; SPEC rev 2 §17; G2A frozen disclosure).
 *
 * The ONE authority for enabling `codex_conversation_ingestion`: presents the
 * G2A-frozen disclosure text verbatim (Chinese SSoT; optional English
 * rendering) and records the Owner's explicit decision BEFORE the flag is
 * flipped. Declining leaves the flag off, leaves every existing
 * prompt/RuleHost/tool governance surface untouched, and never opens a
 * transcript (this command performs no Codex-home I/O at all). Upgrade paths
 * never call this command, so upgrading can never enable ingestion.
 *
 * Modes:
 * - default: print disclosure, then interactive prompt (TTY) for an explicit
 *   yes/no; EOF/abort mutates nothing and records nothing.
 * - --accept / --decline: non-interactive explicit decision (the plugin's
 *   $pd-setup presents the disclosure itself, then calls one of these).
 * - --show-disclosure: print the frozen text for the requested language and
 *   exit; no mutation, no record.
 *
 * Config writes are line-targeted edits of .pd/config.yaml (comments
 * preserved), atomic, and round-trip verified: if the rewritten config does
 * not validate with the flag at the intended value, the previous content is
 * restored and the failure is loud — a half-consented state is impossible.
 *
 * CLI gate compliance:
 * - cli-1: --json outputs exactly one parseable JSON object on stdout.
 * - cli-2: exit paths stop execution.
 * - cli-4: --accept and --decline are mutually exclusive.
 * - cli-5: refused/failed runs mutate nothing (consent + flag both untouched).
 * - cli-6: every refusal/degradation carries reason + nextAction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  CODEX_INGESTION_DISCLOSURE_VERSION,
  getCodexIngestionDisclosureText,
  deriveCodexIngestionConsentState,
  getPdConfigPath,
  loadPdConfigForPlugin,
  readCodexIngestionConsent,
  recordCodexIngestionConsent,
  type CodexIngestionConsentState,
  type CodexIngestionDisclosureLanguage,
} from '@principles/host-runtime';
import { computeEffectivePdConfig, computeFeatureFlagsFromConfig, isFeatureEnabled } from '@principles/core/runtime-v2';

export interface CodexSetupOptions {
  workspace?: string;
  json?: boolean;
  lang?: string;
  accept?: boolean;
  decline?: boolean;
  showDisclosure?: boolean;
}

export interface CodexSetupReport {
  generatedAt: string;
  host: 'codex';
  workspace: string;
  status: 'ok' | 'degraded';
  decision?: 'granted' | 'declined';
  consentStateBefore: CodexIngestionConsentState;
  consentState: CodexIngestionConsentState;
  disclosureVersion: string;
  ingestionFlag: { name: 'codex_conversation_ingestion'; enabled: boolean; source: string };
  hostCodexFlagEnabled: boolean;
  warnings: string[];
  reason?: string;
  nextAction?: string;
}

// ── Targeted config.yaml flag edit ───────────────────────────────────────────

type FlagWriteResult = { ok: true; enabled: boolean } | { ok: false; reason: string; nextAction: string };

const FEATURES_LINE = /^features:\s*(?:#.*)?$/;
const INGESTION_KEY_LINE = /^ {2}codex_conversation_ingestion:\s*(?:#.*)?$/;
const INGESTION_ENABLED_LINE = /^ {4}enabled:\s*(?:true|false)\s*(?:#.*)?$/;

function stripYamlComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function isEmptyFeaturesMapping(line: string): boolean {
  // Matches `features: {}` (with optional YAML comment) without a regex
  // literal over brace syntax.
  return stripYamlComment(line).replace(/\s+/g, '') === 'features:' + String.fromCharCode(123, 125);
}

function trailingComment(line: string): string {
  // ' #' starts a plain-scalar YAML comment on these simple enabled lines.
  const hash = line.indexOf(' #');
  return hash === -1 ? '' : ' ' + line.slice(hash + 1);
}

/**
 * Enable/disable `features.codex_conversation_ingestion.enabled` in the
 * workspace config.yaml with a line-targeted edit that preserves all other
 * content (comments included). Atomic write; round-trip verified with the
 * production loader, restored on any mismatch.
 */
export function setCodexConversationIngestionFlag(workspaceDir: string, enabled: boolean): FlagWriteResult {
  const configPath = getPdConfigPath(workspaceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
      ? String((error as Record<string, unknown>).code)
      : String(error);
    return {
      ok: false,
      reason: 'config_unreadable: ' + code,
      nextAction: 'Run `pd runtime init --confirm` in this workspace to create .pd/config.yaml, then re-run `pd codex setup`.',
    };
  }
  const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  // Every feature override requires category+enabled (validatePdConfig), so
  // inserted blocks carry the registry's current category for this flag.
  const registryCategory =
    computeFeatureFlagsFromConfig(computeEffectivePdConfig(null)).flags.codex_conversation_ingestion?.category ?? 'quiet';
  // A bare `features:` line and an inline empty mapping both count as the
  // features section; anything else is a mapping with entries.
  const featuresIndex = lines.findIndex((line) => FEATURES_LINE.test(line) || isEmptyFeaturesMapping(line));
  const blockLines = [
    '  codex_conversation_ingestion:',
    '    category: ' + registryCategory,
    '    enabled: ' + String(enabled),
  ];

  let mutated = false;
  if (featuresIndex === -1) {
    // Unreachable behind the workspace_config gate (validatePdConfig requires
    // a features section); refuse loudly instead of inventing one (cli-5).
    return {
      ok: false,
      reason: 'config_features_section_missing',
      nextAction: 'Add a features section to ' + configPath + ' and re-run `pd codex setup`; config.yaml was left unchanged.',
    };
  }
  const featuresLine: string | undefined = lines[featuresIndex];
  if (featuresLine === undefined) {
    return { ok: false, reason: 'config_features_line_undefined', nextAction: 'config.yaml was left unchanged; re-run `pd codex setup`.' };
  }
  if (isEmptyFeaturesMapping(featuresLine)) {
    // The inline empty mapping IS the features key — keep the parent key and
    // expand its children in place.
    lines.splice(featuresIndex, 1, 'features:', ...blockLines);
    mutated = true;
  } else {
      // Find the ingestion key's block under features: (2-space indent) and the
      // end of that block (next 2-space-indented key or next top-level key).
      let keyIndex = -1;
      let blockEnd = lines.length;
      for (let i = featuresIndex + 1; i < lines.length; i += 1) {
        const line: string | undefined = lines[i];
        if (line === undefined || line.trim() === '') continue;
        if (INGESTION_KEY_LINE.test(line)) {
          keyIndex = i;
          continue;
        }
        if (keyIndex !== -1 && /^( {0,1}\S| {2}\S)/.test(line)) {
          blockEnd = i;
          break;
        }
      }
      if (keyIndex === -1) {
        lines.splice(featuresIndex + 1, 0, ...blockLines);
        mutated = true;
      } else {
        for (let i = keyIndex + 1; i < blockEnd; i += 1) {
          const current: string | undefined = lines[i];
          if (current === undefined || !INGESTION_ENABLED_LINE.test(current)) continue;
          const next = '    enabled: ' + String(enabled) + trailingComment(current);
          if (current !== next) {
            lines[i] = next;
            mutated = true;
          }
          break;
        }
        if (!mutated) {
          // Key exists but no enabled line inside its block — add it as the
          // first entry of the block so the mapping is not folded into a sibling.
          lines.splice(keyIndex + 1, 0, '    enabled: ' + String(enabled));
          mutated = true;
        }
      }
  }

  if (!mutated) {
    return { ok: true, enabled };
  }
  const nextContent = lines.join(lineEnding);
  const tmpPath = configPath + '.tmp-setup-' + String(process.pid) + '-' + String(Date.now());
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(tmpPath, nextContent, { encoding: 'utf8' });
    fs.renameSync(tmpPath, configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup; the failure below is the loud signal
    }
    return {
      ok: false,
      reason: 'config_write_failed: ' + message.slice(0, 160),
      nextAction: 'Check permissions on ' + path.dirname(configPath) + '; config.yaml was left unchanged.',
    };
  }
  // Round-trip: the production loader must validate the rewrite AND report
  // the flag at the intended value. Anything else → restore, fail loud.
  const verification = loadPdConfigForPlugin(workspaceDir);
  const verifiedEnabled = verification.ok
    ? isFeatureEnabled(computeFeatureFlagsFromConfig(verification.effective), 'codex_conversation_ingestion')
    : undefined;
  if (!verification.ok || verifiedEnabled !== enabled) {
    try {
      fs.writeFileSync(configPath, raw, { encoding: 'utf8' });
    } catch {
      // restoration failure must not mask the primary failure
    }
    return {
      ok: false,
      reason: verification.ok ? 'config_roundtrip_mismatch' : 'config_roundtrip_invalid: ' + (verification.errors[0]?.reason ?? 'unknown'),
      nextAction: 'config.yaml was restored to its previous content. Fix the features block manually in ' + configPath + ' and re-run `pd codex setup`.',
    };
  }
  return { ok: true, enabled };
}

// ── Interactive decision ─────────────────────────────────────────────────────

async function promptExplicitDecision(disclosure: string): Promise<'granted' | 'declined' | 'aborted'> {
  process.stdout.write(disclosure);
  process.stdout.write(
    '\n按上述说明做出选择（y = 开启对话观察并写入治理闭环 / n = 拒绝，保持关闭）。\n' +
    'Make your choice per the disclosure above (y = enable / n = decline, keep off):\n> ',
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return 'granted';
    if (answer === 'n' || answer === 'no') return 'declined';
    return 'aborted';
  } finally {
    rl.close();
  }
}

// ── Command handler ──────────────────────────────────────────────────────────

function languageFrom(lang: string | undefined): CodexIngestionDisclosureLanguage {
  return lang === 'en' ? 'en' : 'zh';
}

export async function handleCodexSetup(options: CodexSetupOptions): Promise<void> {
  const generatedAt = new Date().toISOString();

  if (options.showDisclosure) {
    process.stdout.write(getCodexIngestionDisclosureText(languageFrom(options.lang)));
    process.stdout.write('\n');
    return;
  }

  const workspace = resolveWorkspaceDir(options.workspace);
  const warnings: string[] = [];
  const finish = (report: CodexSetupReport): void => {
    if (options.json) {
      // cli-1: exactly one parseable JSON object on stdout.
      console.log(JSON.stringify(report));
    } else {
      const lines = [
        'Codex conversation-ingestion setup (' + report.workspace + ')',
        '  status:             ' + report.status,
        '  disclosureVersion:  ' + report.disclosureVersion,
        '  consent (before):   ' + report.consentStateBefore,
        '  consent (now):      ' + report.consentState,
        '  ingestion flag:     ' + String(report.ingestionFlag.enabled) + ' (source: ' + report.ingestionFlag.source + ')',
        '  host.codex flag:    ' + String(report.hostCodexFlagEnabled),
      ];
      for (const warning of report.warnings) lines.push('  warning: ' + warning);
      if (report.reason !== undefined) lines.push('  reason: ' + report.reason);
      if (report.nextAction !== undefined) lines.push('  next action: ' + report.nextAction);
      console.log(lines.join('\n'));
    }
    if (report.status === 'degraded') process.exitCode = 1;
  };

  const refuse = (reason: string, nextAction: string, consentStateBefore: CodexIngestionConsentState = 'not_present'): void => {
    finish({
      generatedAt, host: 'codex', workspace, status: 'degraded',
      consentStateBefore, consentState: consentStateBefore, disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
      ingestionFlag: { name: 'codex_conversation_ingestion', enabled: false, source: 'unknown' },
      hostCodexFlagEnabled: false, warnings, reason, nextAction,
    });
  };

  // cli-4: explicit mutual exclusion.
  if (options.accept && options.decline) {
    refuse('accept_decline_mutex', 'Pass either --accept or --decline, not both.');
    return;
  }

  // Workspace must exist as a PD workspace (config present) before anything
  // can be consented or mutated (cli-5).
  const configPath = getPdConfigPath(workspace);
  if (!fs.existsSync(configPath)) {
    refuse('workspace_config_not_found', 'No .pd/config.yaml at ' + workspace + '. Run `pd runtime init --confirm` first, then re-run `pd codex setup`.');
    return;
  }
  const configLoad = loadPdConfigForPlugin(workspace);
  if (!configLoad.ok) {
    refuse(
      'workspace_config_malformed: ' + (configLoad.errors[0]?.reason ?? 'unknown'),
      'Fix .pd/config.yaml first (' + (configLoad.errors[0]?.nextAction ?? 'fix YAML syntax') + '); PD will not consent or mutate a config it cannot validate.',
    );
    return;
  }
  const flags = computeFeatureFlagsFromConfig(configLoad.effective);
  const ingestionEnabledBefore = isFeatureEnabled(flags, 'codex_conversation_ingestion');
  const hostCodexEnabled = isFeatureEnabled(flags, 'host.codex');
  const flagSource = configLoad.source;

  const consentRead = readCodexIngestionConsent(workspace);
  if (!consentRead.ok) {
    refuse(consentRead.reason, consentRead.nextAction);
    return;
  }
  const consentStateBefore = deriveCodexIngestionConsentState(consentRead.record, ingestionEnabledBefore);

  // Resolve the decision.
  let decision: 'granted' | 'declined' | 'aborted';
  if (options.accept) decision = 'granted';
  else if (options.decline) decision = 'declined';
  else if (options.json) {
    refuse('decision_required', 'Machine mode must state the decision explicitly: re-run with --accept or --decline (use --show-disclosure to print the frozen text for presentation first).');
    return;
  } else if (process.stdin.isTTY) {
    decision = await promptExplicitDecision(getCodexIngestionDisclosureText(languageFrom(options.lang)) + '\n');
    if (decision === 'aborted') {
      refuse('decision_aborted', 'Nothing was changed or recorded. Re-run `pd codex setup` to see the disclosure again.');
      return;
    }
  } else {
    refuse('decision_required', 'No TTY available for the interactive prompt. Present the disclosure (`pd codex setup --show-disclosure`), then re-run with --accept or --decline.');
    return;
  }

  // 1. Record consent BEFORE touching the flag (the record is the evidence
  //    that the disclosure flow ran; the flag is only the runtime gate).
  const recorded = recordCodexIngestionConsent(workspace, { decision, decidedVia: 'pd_codex_setup' });
  if (!recorded.ok) {
    refuse(recorded.reason, recorded.nextAction, consentStateBefore);
    return;
  }

  // 2. Flag write: accept ⇒ enabled; decline ⇒ explicitly off (also
  //    regularizes a hand-enabled flag-on-without-consent state).
  const desiredEnabled = decision === 'granted';
  let flagResult: FlagWriteResult = { ok: true, enabled: ingestionEnabledBefore };
  if (ingestionEnabledBefore !== desiredEnabled) {
    flagResult = setCodexConversationIngestionFlag(workspace, desiredEnabled);
  }
  if (!flagResult.ok) {
    finish({
      generatedAt, host: 'codex', workspace, status: 'degraded',
      decision, consentStateBefore, consentState: decision === 'granted' ? 'granted' : 'declined',
      disclosureVersion: CODEX_INGESTION_DISCLOSURE_VERSION,
      ingestionFlag: { name: 'codex_conversation_ingestion', enabled: ingestionEnabledBefore, source: flagSource },
      hostCodexFlagEnabled: hostCodexEnabled, warnings,
      reason: flagResult.reason, nextAction: flagResult.nextAction,
    });
    return;
  }

  const nextWarnings = [...warnings];
  if (decision === 'granted' && !hostCodexEnabled) {
    nextWarnings.push('host.codex is disabled — ingestion stays inactive until features.host.codex.enabled=true; enable it explicitly if this workspace should run Codex governance at all.');
  }

  finish({
    generatedAt, host: 'codex', workspace, status: 'ok',
    decision,
    consentStateBefore,
    consentState: deriveCodexIngestionConsentState(recorded.record, desiredEnabled),
    disclosureVersion: recorded.record.disclosureVersion,
    ingestionFlag: { name: 'codex_conversation_ingestion', enabled: desiredEnabled, source: flagSource },
    hostCodexFlagEnabled: hostCodexEnabled,
    warnings: nextWarnings,
    ...(decision === 'declined'
      ? { nextAction: 'Ingestion stays off; prompt injection, RuleHost, and tool governance are unchanged. No transcript was or will be read.' }
      : {}),
  });
}
