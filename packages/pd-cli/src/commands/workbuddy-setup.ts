/**
 * pd workbuddy setup — the SUPPORTED entry point for WorkBuddy conversation
 * ingestion consent (PRI-1171 P2, tickets ⑤/⑥).
 *
 * "Supported" is a convention, not an enforced boundary: the consent ledger
 * (`<workspace>/.state/conversation-ingestion-consent.json`) and the workspace
 * config are ordinary files, and `recordConversationIngestionConsent` is a
 * public export — another tool could write the same durable facts. What this
 * command owns is the intended UX: present the disclosure, record the explicit
 * decision, and flip the flag in the order below.
 *
 * The two writes are ordered so a granted record can never precede a
 * successfully enabled flag, and a failed consent write rolls the flag back to
 * the exact bytes captured before this command's first mutation (atomic
 * tmp+rename, never an in-place truncate).
 *
 * The runtime (workbuddy-adapter/src/ingestion/ingestion.ts) READS this ledger
 * on every Stop hook — unlike the Codex path, which still hard-codes a grant
 * from its setup-flow invariant. Revocation therefore takes effect immediately.
 *
 * CLI gate compliance: cli-1 (--json is one JSON object), cli-2 (explicit
 * exit after refuse), cli-4 (--accept/--decline mutex), cli-5 (refused runs
 * mutate nothing), cli-6 (every refusal carries reason + nextAction).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import {
  deriveConversationIngestionConsentState,
  getPdConfigPath,
  loadPdConfigForPlugin,
  readConversationIngestionConsent,
  recordConversationIngestionConsent,
  type ConversationIngestionConsentState,
} from '@principles/host-runtime';
import { computeEffectivePdConfig, computeFeatureFlagsFromConfig, isFeatureEnabled } from '@principles/core/runtime';

export const WORKBUDDY_INGESTION_DISCLOSURE_VERSION = 'wb-2026-11-11';
const FLAG_ID = 'workbuddy_conversation_ingestion';
const SETUP_COMMAND = 'pd workbuddy setup';

export interface WorkbuddySetupOptions {
  workspace?: string;
  json?: boolean;
  accept?: boolean;
  decline?: boolean;
  showDisclosure?: boolean;
}

export interface WorkbuddySetupReport {
  generatedAt: string;
  host: 'workbuddy';
  workspace: string;
  status: 'ok' | 'degraded';
  decision?: 'granted' | 'revoked';
  consentStateBefore: ConversationIngestionConsentState;
  consentState: ConversationIngestionConsentState;
  disclosureVersion: string;
  ingestionFlag: { name: string; enabled: boolean };
  hostWorkbuddyFlagEnabled: boolean;
  warnings: string[];
  reason?: string;
  nextAction?: string;
}

export function getWorkbuddyIngestionDisclosureText(): string {
  return [
    'PD · WorkBuddy 会话采集授权（' + WORKBUDDY_INGESTION_DISCLOSURE_VERSION + '）',
    '',
    '开启后，PD 会在每次会话结束时读取 WorkBuddy 在本机写下的会话转录',
    '(~/.workbuddy/projects/<项目>/<会话ID>.jsonl)，并把以下内容写入本工作区的',
    'trajectory.db（governance_observations 表），供 Pain 诊断与原则内化的数据管道使用：',
    '  - 您本人输入的话语（仅 <user_query> 内的文本）',
    '  - 助手的可见回复、推理记录、工具调用名称与结果状态',
    '不会采集：宿主注入的 system-reminder 上下文（系统提示、身份文件、工具声明、',
    '连接器状态等）。解码器只从 <user_query> 结构化边界投影 Owner 原话；',
    '无法确认该边界时，该条记录标记为 partial 且不写入原文（fail-closed，宁缺毋滥）。',
    '',
    '采集受三道门约束：host.workbuddy + workbuddy_conversation_ingestion + 本同意记录',
    '(decision=granted)。默认关闭；任一门关闭时 PD 不会打开任何转录文件（零读取）。',
    '',
    '随时可用 `' + SETUP_COMMAND + ' --decline` 撤销；撤销只影响后续采集，',
    '已入库数据按既有的保留策略处理。',
  ].join('\n');
}

/**
 * `restored` is only meaningful on failure: it says whether the pre-mutation
 * bytes were successfully put back. A rollback whose calibration check fails
 * can still have restored the file, and the operator message must not claim
 * otherwise.
 */
type FlagWriteResult =
  | { ok: true }
  | { ok: false; reason: string; nextAction: string; restored?: boolean };

const FEATURES_LINE = /^features:\s*(?:#.*)?$/;
const KEY_LINE = /^ {2}workbuddy_conversation_ingestion:\s*(?:#.*)?$/;
const ENABLED_LINE = /^ {4}enabled:\s*(?:true|false)\s*(?:#.*)?$/;

/** Drop an inline `#` comment and surrounding whitespace from one YAML line. */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/** Runtime-contract guard (rc-1): a non-null, non-array object is the only trusted shape. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Options for {@link setWorkbuddyIngestionFlag}. */
export interface SetWorkbuddyIngestionFlagOptions {
  /**
   * Exact bytes captured BEFORE this command's first mutation. Used when the
   * round-trip verification fails: a restore must return the file to the last
   * state the Owner actually saw, not to whatever the current call just read
   * (a rollback call would otherwise "restore" the intermediate enabled bytes).
   */
  restoreBytes?: string;
}

/**
 * Line-targeted, atomic, round-trip-verified edit of
 * `features.workbuddy_conversation_ingestion.enabled`. Same shape as the
 * Codex setup's config edit (kept separate so the frozen Codex consent flow
 * is untouched); comments and every other key are preserved.
 */
export function setWorkbuddyIngestionFlag(workspaceDir: string, enabled: boolean, options: SetWorkbuddyIngestionFlagOptions = {}): FlagWriteResult {
  const configPath = getPdConfigPath(workspaceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && Object.hasOwn(error, 'code')
      ? String((error as Record<string, unknown>).code) : String(error);
    return { ok: false, reason: 'config_unreadable:' + code, nextAction: 'Run `pd runtime init --confirm` in this workspace, then re-run `' + SETUP_COMMAND + '`.' };
  }
  const registry = computeFeatureFlagsFromConfig(computeEffectivePdConfig(null)).flags as Record<string, { category?: string }>;
  const category = registry[FLAG_ID]?.category ?? 'quiet';

  const restoreBytes = options.restoreBytes ?? raw;
  let tmpSequence = 0;
  /**
   * Every mutation — forward write AND restore — goes through tmp+rename.
   * An in-place `writeFileSync(configPath, ...)` can leave a truncated
   * config.yaml if the process dies mid-write, which is exactly the state the
   * restore path exists to prevent. Returns the failure message, or null.
   */
  const atomicWrite = (content: string): string | null => {
    tmpSequence += 1;
    const tmpPath = configPath + '.tmp-wbsetup-' + String(process.pid) + '-' + String(Date.now()) + '-' + String(tmpSequence);
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
      fs.renameSync(tmpPath, configPath);
      return null;
    } catch (error) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      return error instanceof Error ? error.message : String(error);
    }
  };

  /**
   * Shared commit: atomic write, production-loader round-trip verification and
   * an atomic restore of the pre-mutation bytes on any mismatch, so a failed
   * run leaves the file as the Owner last saw it.
   */
  const commit = (nextContent: string): FlagWriteResult => {
    const writeFailure = atomicWrite(nextContent);
    if (writeFailure !== null) {
      return { ok: false, reason: 'config_write_failed:' + writeFailure.slice(0, 160), nextAction: 'Check permissions on ' + path.dirname(configPath) + '; config.yaml was left unchanged.' };
    }
    const verification = loadPdConfigForPlugin(workspaceDir);
    const verified = verification.ok ? isFeatureEnabled(computeFeatureFlagsFromConfig(verification.effective), FLAG_ID) : undefined;
    if (!verification.ok || verified !== enabled) {
      const restoreFailure = atomicWrite(restoreBytes);
      return {
        ok: false,
        reason: verification.ok ? 'config_roundtrip_mismatch' : 'config_roundtrip_invalid:' + (verification.errors[0]?.reason ?? 'unknown'),
        restored: restoreFailure === null,
        nextAction: restoreFailure === null
          ? 'config.yaml was restored to its pre-command bytes. Fix the features block in ' + configPath + ' and re-run `' + SETUP_COMMAND + '`.'
          : 'WARNING: config.yaml could not be restored (' + restoreFailure.slice(0, 120) + '); repair ' + configPath + ' manually before re-running `' + SETUP_COMMAND + '`.',
      };
    }
    return { ok: true };
  };

  // JSON is a valid YAML subset and is what some installers/fixtures write.
  // A line-targeted edit cannot see a `features:` line there, so update the
  // parsed object instead — every other key is preserved verbatim.
  if (raw.trim().startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { return { ok: false, reason: 'config_json_invalid', nextAction: 'Repair ' + configPath + ' (it is neither valid JSON nor YAML), then re-run `' + SETUP_COMMAND + '`.' }; }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.features)) {
      return { ok: false, reason: 'config_features_section_missing', nextAction: 'Add a features mapping to ' + configPath + ', then re-run `' + SETUP_COMMAND + '`.' };
    }
    const features: Record<string, unknown> = parsed.features;
    const existing = features[FLAG_ID];
    features[FLAG_ID] = { ...(isPlainObject(existing) ? existing : {}), category, enabled };
    return commit(JSON.stringify(parsed));
  }

  const lineEnding = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const block = ['  ' + FLAG_ID + ':', '    category: ' + category, '    enabled: ' + String(enabled)];

  const featuresIndex = lines.findIndex((line) => FEATURES_LINE.test(line) || stripComment(line).replace(/\s+/g, '') === 'features:{}');
  if (featuresIndex === -1) {
    return { ok: false, reason: 'config_features_section_missing', nextAction: 'Add a features section to ' + configPath + ', then re-run `' + SETUP_COMMAND + '`.' };
  }
  const featuresLine: string | undefined = lines[featuresIndex];
  if (featuresLine === undefined) {
    return { ok: false, reason: 'config_features_line_undefined', nextAction: 'config.yaml was left unchanged; re-run `' + SETUP_COMMAND + '`.' };
  }
  let mutated = false;
  if (stripComment(featuresLine).replace(/\s+/g, '') === 'features:{}') {
    lines.splice(featuresIndex, 1, 'features:', ...block);
    mutated = true;
  } else {
    let keyIndex = -1;
    let blockEnd = lines.length;
    for (let i = featuresIndex + 1; i < lines.length; i += 1) {
      const line: string | undefined = lines[i];
      if (line === undefined || line.trim() === '') continue;
      if (KEY_LINE.test(line)) { keyIndex = i; continue; }
      if (keyIndex !== -1 && /^( {0,1}\S| {2}\S)/.test(line)) { blockEnd = i; break; }
    }
    if (keyIndex === -1) {
      lines.splice(featuresIndex + 1, 0, ...block);
      mutated = true;
    } else {
      let enabledFound = false;
      for (let i = keyIndex + 1; i < blockEnd; i += 1) {
        const current: string | undefined = lines[i];
        if (current === undefined || !ENABLED_LINE.test(current)) continue;
        enabledFound = true;
        const comment = current.indexOf(' #');
        const next = '    enabled: ' + String(enabled) + (comment === -1 ? '' : ' ' + current.slice(comment + 1));
        if (current !== next) { lines[i] = next; mutated = true; }
        break;
      }
      if (!enabledFound) { lines.splice(keyIndex + 1, 0, '    enabled: ' + String(enabled)); mutated = true; }
    }
  }
  if (!mutated) return { ok: true };

  return commit(lines.join(lineEnding));
}

function consentInput(decision: 'granted' | 'revoked', evidenceRef: string) {
  return {
    decision,
    decidedVia: 'owner_directive' as const,
    disclosureVersion: WORKBUDDY_INGESTION_DISCLOSURE_VERSION,
    evidenceRef,
  };
}

/**
 * `pd workbuddy setup` entry point: read the current consent/flag state, then
 * grant or revoke WorkBuddy ingestion and report what changed.
 *
 * Emits exactly one machine-readable JSON object under `--json` (cli-1) and
 * sets exit code 1 only for a degraded outcome.
 */
export async function handleWorkbuddySetup(options: WorkbuddySetupOptions): Promise<void> {
  const generatedAt = new Date().toISOString();
  // OD-07 / SPEC §4.1: the WorkBuddy runtime (Stop hook AND worker) reads a
  // single user-level governance workspace. Defaulting to the generic CLI
  // workspace here would write consent somewhere the hook never reads, so the
  // default must use the SAME resolution; an explicit --workspace still wins.
  const workspace = options.workspace !== undefined && options.workspace.trim().length > 0
    ? resolveWorkspaceDir(options.workspace)
    : getWorkbuddyWorkspaceDir(os.homedir());
  /** Print the final report (JSON or human) and set the process exit code. */
  const finish = (report: WorkbuddySetupReport): void => {
    if (options.json === true) {
      console.log(JSON.stringify(report));
    } else {
      const lines = [
        'WorkBuddy conversation-ingestion setup (' + report.workspace + ')',
        '  status:             ' + report.status,
        '  disclosureVersion:  ' + report.disclosureVersion,
        '  consent (before):   ' + report.consentStateBefore,
        '  consent (now):      ' + report.consentState,
        '  ingestion flag:     ' + String(report.ingestionFlag.enabled),
        '  host.workbuddy:     ' + String(report.hostWorkbuddyFlagEnabled),
      ];
      for (const warning of report.warnings) lines.push('  warning: ' + warning);
      if (report.reason !== undefined) lines.push('  reason: ' + report.reason);
      if (report.nextAction !== undefined) lines.push('  next action: ' + report.nextAction);
      console.log(lines.join('\n'));
    }
    if (report.status === 'degraded') process.exitCode = 1;
  };
  const refuse = (
    reason: string,
    nextAction: string,
    detail: {
      consentStateBefore?: ConversationIngestionConsentState;
      actualFlags?: { ingestionFlagEnabled: boolean; hostWorkbuddyFlagEnabled: boolean };
    } = {},
  ): void => {
    const { consentStateBefore: before, actualFlags } = detail;
    const consentStateBefore = before ?? 'not_present';
    finish({
      generatedAt, host: 'workbuddy', workspace, status: 'degraded',
      consentStateBefore, consentState: consentStateBefore,
      disclosureVersion: WORKBUDDY_INGESTION_DISCLOSURE_VERSION,
      // A rolled-back failure can leave the flag ON (rollback itself failed).
      // Report the state we actually know, never a comforting `false`.
      ingestionFlag: { name: FLAG_ID, enabled: actualFlags?.ingestionFlagEnabled ?? false },
      hostWorkbuddyFlagEnabled: actualFlags?.hostWorkbuddyFlagEnabled ?? false,
      warnings: [], reason, nextAction,
    });
  };

  // cli-1/cli-5 (P2 review): `--show-disclosure` is a read-only early exit and
  // cannot honour a decision or the JSON contract. Silently printing text made
  // `--show-disclosure --accept` exit 0 without recording consent, and made
  // `--show-disclosure --json` emit non-JSON. Reject the combinations instead.
  if (options.showDisclosure === true && (options.accept === true || options.decline === true || options.json === true)) {
    refuse(
      'show_disclosure_conflicts_with_decision',
      '--show-disclosure only prints the disclosure. Drop --accept/--decline/--json, or run `pd workbuddy setup --accept|--decline [--json]` to record a decision.',
    );
    return;
  }
  if (options.showDisclosure === true) {
    console.log(getWorkbuddyIngestionDisclosureText());
    return;
  }
  if (options.accept === true && options.decline === true) {
    refuse('accept_decline_mutex', 'Pass either --accept or --decline, not both.');
    return;
  }
  if (options.json === true && options.accept !== true && options.decline !== true) {
    refuse('decision_not_explicit', 'With --json a decision must be explicit: pass --accept or --decline.');
    return;
  }
  if (options.accept === true) {
    // Accepting must never skip the disclosure: print it before any mutation.
    // `--json` keeps stdout machine-readable (cli-1), so there it goes to
    // stderr — the same split the Codex setup uses for its human channel.
    const disclosure = getWorkbuddyIngestionDisclosureText();
    if (options.json === true) console.error(disclosure);
    else console.log(disclosure);
  }

  const configPath = getPdConfigPath(workspace);
  if (!fs.existsSync(configPath)) {
    refuse('workspace_config_not_found', 'No .pd/config.yaml at ' + workspace + '. Run `pd runtime init --confirm` first.');
    return;
  }
  const configLoad = loadPdConfigForPlugin(workspace);
  if (!configLoad.ok) {
    refuse('workspace_config_malformed:' + (configLoad.errors[0]?.reason ?? 'unknown'), 'Fix .pd/config.yaml before granting consent; nothing was mutated.');
    return;
  }
  const flags = computeFeatureFlagsFromConfig(configLoad.effective);
  const flagEnabledBefore = isFeatureEnabled(flags, FLAG_ID);
  const hostEnabled = isFeatureEnabled(flags, 'host.workbuddy');

  const consentRead = readConversationIngestionConsent(workspace, 'workbuddy');
  if (!consentRead.ok) { refuse(consentRead.reason, consentRead.nextAction); return; }
  const stateBefore = deriveConversationIngestionConsentState(consentRead.record, flagEnabledBefore);

  // No explicit decision: report-only, never mutate (cli-5).
  if (options.accept !== true && options.decline !== true) {
    console.log(getWorkbuddyIngestionDisclosureText());
    finish({
      generatedAt, host: 'workbuddy', workspace, status: 'ok',
      consentStateBefore: stateBefore, consentState: stateBefore,
      disclosureVersion: WORKBUDDY_INGESTION_DISCLOSURE_VERSION,
      ingestionFlag: { name: FLAG_ID, enabled: flagEnabledBefore }, hostWorkbuddyFlagEnabled: hostEnabled,
      warnings: hostEnabled ? [] : ['host.workbuddy is off: ingestion stays gated even after consent is granted.'],
    });
    return;
  }

  const decision: 'granted' | 'revoked' = options.accept === true ? 'granted' : 'revoked';
  const targetFlag = decision === 'granted';
  // Capture the pre-mutation bytes BEFORE the first write: if the consent
  // write fails, the rollback restores this exact state, not the intermediate
  // flag flip this command just made.
  let originalConfigBytes: string | undefined;
  try { originalConfigBytes = fs.readFileSync(configPath, 'utf8'); } catch { /* pre-checked above; leave undefined */ }
  const flagWrite = setWorkbuddyIngestionFlag(workspace, targetFlag);
  if (!flagWrite.ok) { refuse(flagWrite.reason, flagWrite.nextAction, { consentStateBefore: stateBefore }); return; }

  const recorded = recordConversationIngestionConsent(
    workspace,
    'workbuddy',
    consentInput(decision, '`' + SETUP_COMMAND + ' --' + (decision === 'granted' ? 'accept' : 'decline') + '` at ' + generatedAt),
  );
  if (!recorded.ok) {
    // Never leave a flag enabled without its grant (or a revocation without
    // its flag off): roll the config back to the previous value.
    const rollback = setWorkbuddyIngestionFlag(
      workspace,
      flagEnabledBefore,
      originalConfigBytes !== undefined ? { restoreBytes: originalConfigBytes } : {},
    );
    const rollbackOk = rollback.ok || rollback.restored === true;
    refuse(
      'consent_write_failed:' + recorded.reason,
      recorded.nextAction + (rollbackOk
        ? ' The ingestion flag was rolled back.'
        : ' WARNING: the ingestion flag could NOT be rolled back; disable it manually.'),
      {
        consentStateBefore: stateBefore,
        actualFlags: { ingestionFlagEnabled: rollbackOk ? flagEnabledBefore : targetFlag, hostWorkbuddyFlagEnabled: hostEnabled },
      },
    );
    return;
  }
  const stateAfter = deriveConversationIngestionConsentState(recorded.record, targetFlag);
  finish({
    generatedAt, host: 'workbuddy', workspace, status: 'ok', decision,
    consentStateBefore: stateBefore, consentState: stateAfter,
    disclosureVersion: WORKBUDDY_INGESTION_DISCLOSURE_VERSION,
    ingestionFlag: { name: FLAG_ID, enabled: targetFlag }, hostWorkbuddyFlagEnabled: hostEnabled,
    warnings: decision === 'granted' && !hostEnabled ? ['host.workbuddy is off: no transcript will be read until the host master switch is enabled.'] : [],
  });
}
