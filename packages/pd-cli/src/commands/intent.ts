/**
 * pd intent — Owner-authored INTENT.md management (PRI-466).
 *
 * Subcommands:
 *   - init : create .principles/INTENT.{lang}.md from the canonical template
 *   - show : display a read-only summary of INTENT.{lang}.md (sections, hash, warnings)
 *
 * `init` is not gated by the intent_engineering flag — the Owner can
 * initialise the intent doc at any time. `show` IS gated: flag-off returns
 * a structured `flag_disabled` result without touching the filesystem,
 * matching the Console backend contract.
 *
 * Bilingual: --lang zh-CN|en (default zh-CN) selects the intent doc language.
 * File naming: INTENT.zh-CN.md / INTENT.en.md via getIntentFilename(lang).
 *
 * JSON mode is strict: --json outputs exactly one parseable JSON object on
 * stdout (CLI Operator Gate rule 1). Failure paths include structured
 * reason + nextAction (rule 6).
 *
 * ERR refs:
 *   - ERR-001 (no any): all types explicit
 *   - ERR-005 (no as bypass): no type casts on untrusted data
 *   - ERR-002 (graceful degradation with reason): all failure paths include
 *     reason + nextAction
 *   - ERR-009 (fail loud): missing file / flag-off surfaced explicitly
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import {
  INTENT_MAX_BYTES,
  getIntentFilename,
  createIntentTemplate,
  parseIntentDocSections,
  computeIntentContentHash,
  validateIntentDocSections,
  isFeatureEnabled,
} from '@principles/core/runtime-v2';
import type { IntentDocSections, IntentDocWarning, IntentLang } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { emitResult } from '../services/cli-output.js';

// ── Constants ────────────────────────────────────────────────────────────────

const INTENT_DIR = '.principles';

function parseLang(value: string | undefined): IntentLang {
  return value === 'en' ? 'en' : 'zh-CN';
}

// ── Output types ─────────────────────────────────────────────────────────────

export interface IntentInitOutput {
  status: 'ok' | 'skipped' | 'dry_run' | 'read_error';
  path: string;
  overwritten: boolean;
  reason?: string;
  nextAction?: string;
}

export interface IntentShowOutput {
  status: 'ok' | 'flag_disabled' | 'not_found' | 'oversized' | 'read_error';
  flagEnabled: boolean;
  found: boolean;
  path?: string;
  contentHash?: string;
  lastEditedAt?: string;
  sections?: Record<string, string>;
  warnings: IntentDocWarning[];
  reason?: string;
  nextAction?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getIntentFilePath(workspaceDir: string, lang: IntentLang): string {
  return path.join(workspaceDir, INTENT_DIR, getIntentFilename(lang));
}

function sectionsToRecord(sections: IntentDocSections): Record<string, string> {
  const record: Record<string, string> = {};
  if (sections.why !== undefined) { record.why = sections.why; }
  if (sections.desiredOutcome !== undefined) { record.desiredOutcome = sections.desiredOutcome; }
  if (sections.nonNegotiables !== undefined) { record.nonNegotiables = sections.nonNegotiables; }
  if (sections.stopEscalation !== undefined) { record.stopEscalation = sections.stopEscalation; }
  if (sections.currentStrategicFocus !== undefined) { record.currentStrategicFocus = sections.currentStrategicFocus; }
  return record;
}

function formatIntentShowText(o: IntentShowOutput, filename: string): string {
  const lines: string[] = [];
  lines.push(`${filename} — ${o.path}`);
  lines.push(`Content hash: ${o.contentHash}`);
  lines.push(`Last edited:  ${o.lastEditedAt}`);
  lines.push('');
  if (o.sections) {
    if (o.sections.why) { lines.push('## 1. Why'); lines.push(o.sections.why); lines.push(''); }
    if (o.sections.desiredOutcome) { lines.push('## 2. Desired Outcome'); lines.push(o.sections.desiredOutcome); lines.push(''); }
    if (o.sections.nonNegotiables) { lines.push('## 3. Non-negotiables'); lines.push(o.sections.nonNegotiables); lines.push(''); }
    if (o.sections.stopEscalation) { lines.push('## 4. Stop / Escalation'); lines.push(o.sections.stopEscalation); lines.push(''); }
    if (o.sections.currentStrategicFocus) { lines.push('## 5. Current Strategic Focus'); lines.push(o.sections.currentStrategicFocus); lines.push(''); }
  }
  if (o.warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of o.warnings) {
      lines.push(`  [${w.code}] ${w.message}`);
    }
  } else {
    lines.push('No warnings.');
  }
  return lines.join('\n');
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export interface IntentInitOptions {
  workspace?: string;
  force?: boolean;
  json?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  lang?: string;
}

export async function handleIntentInit(opts: IntentInitOptions): Promise<void> {
  const lang = parseLang(opts.lang);

  // CLI Gate rule 4: --dry-run and --confirm must be mutually exclusive.
  if (opts.dryRun && opts.confirm) {
    const output: IntentInitOutput = {
      status: 'skipped',
      path: '',
      overwritten: false,
      reason: 'flag_conflict',
      nextAction: 'Use either --dry-run or --confirm, not both.',
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  // CLI Gate rule 6: workspace resolution inside try/catch so failures emit
  // structured JSON with reason + nextAction instead of an uncaught stack trace.
  let workspaceDir: string;
  let filePath: string;
  let dir: string;
  try {
    workspaceDir = resolveWorkspaceDir(opts.workspace);
    filePath = getIntentFilePath(workspaceDir, lang);
    dir = path.dirname(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const output: IntentInitOutput = {
      status: 'read_error',
      path: '',
      overwritten: false,
      reason,
      nextAction: 'Provide a valid --workspace <path> argument.',
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  const filename = getIntentFilename(lang);

  // CLI Gate rule 4: state-mutating command defaults to dry-run unless --confirm.
  const isDryRun = opts.dryRun === true || opts.confirm !== true;

  try {
    if (fs.existsSync(filePath) && !opts.force) {
      const output: IntentInitOutput = {
        status: 'skipped',
        path: filePath,
        overwritten: false,
        reason: 'file_exists',
        nextAction: `Use --force to overwrite: pd intent init --force --confirm --lang ${lang} --workspace "${workspaceDir}"`,
      };
      emitResult(output, {
        json: opts.json ?? false,
        formatText: (o) => `${filename} already exists at ${o.path}\n→ ${o.nextAction}`,
      });
      process.exitCode = 1;
      return;
    }

    if (isDryRun) {
      const output: IntentInitOutput = {
        status: 'dry_run',
        path: filePath,
        overwritten: opts.force === true,
        reason: 'dry_run',
        nextAction: `Confirm write: pd intent init --confirm --lang ${lang}${opts.force ? ' --force' : ''} --workspace "${workspaceDir}"`,
      };
      emitResult(output, {
        json: opts.json ?? false,
        formatText: (o) => `[dry-run] Would create ${filename} at ${o.path}${o.overwritten ? ' (overwritten)' : ''}\n→ ${o.nextAction}`,
      });
      return;
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, createIntentTemplate(lang), 'utf8');

    const output: IntentInitOutput = {
      status: 'ok',
      path: filePath,
      overwritten: opts.force === true,
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Created ${filename} at ${o.path}${o.overwritten ? ' (overwritten)' : ''}\nNext: edit the file to declare your project intent, then run "pd intent show --lang ${lang}".`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // CLI Gate rule 1: route through emitResult for consistent IntentInitOutput shape.
    const output: IntentInitOutput = {
      status: 'read_error',
      path: filePath,
      overwritten: false,
      reason,
      nextAction: `Check filesystem permissions for ${filePath}`,
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
  }
}

export interface IntentShowOptions {
  workspace?: string;
  json?: boolean;
  lang?: string;
}

export async function handleIntentShow(opts: IntentShowOptions): Promise<void> {
  const lang = parseLang(opts.lang);

  // CLI Gate rule 6: workspace resolution inside try/catch for structured errors.
  let workspaceDir: string;
  try {
    workspaceDir = resolveWorkspaceDir(opts.workspace);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const output: IntentShowOutput = {
      status: 'read_error',
      flagEnabled: false,
      found: false,
      warnings: [],
      reason,
      nextAction: 'Provide a valid --workspace <path> argument.',
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  // Flag check — flag-off short-circuits without fs access
  const configResult = loadPdConfig(workspaceDir);
  const flagsResult = computeFlagsFromLoadResult(configResult);
  const flagEnabled = isFeatureEnabled(flagsResult, 'intent_engineering');

  const filename = getIntentFilename(lang);

  if (!flagEnabled) {
    const output: IntentShowOutput = {
      status: 'flag_disabled',
      flagEnabled: false,
      found: false,
      warnings: [],
      reason: 'flag_disabled',
      nextAction: `Enable the intent_engineering feature flag in .pd/config.yaml to read ${filename}.`,
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Intent Engineering is disabled (flag off).\n→ ${o.nextAction}`,
    });
    return;
  }

  const filePath = getIntentFilePath(workspaceDir, lang);

  try {
    if (!fs.existsSync(filePath)) {
      const output: IntentShowOutput = {
        status: 'not_found',
        flagEnabled: true,
        found: false,
        warnings: [],
        reason: 'not_found',
        nextAction: `Create ${filename}: pd intent init --lang ${lang} --workspace "${workspaceDir}"`,
      };
      emitResult(output, {
        json: opts.json ?? false,
        formatText: (o) => `${filename} not found.\n→ ${o.nextAction}`,
      });
      return;
    }

    const stat = fs.statSync(filePath);
    if (stat.size > INTENT_MAX_BYTES) {
      const output: IntentShowOutput = {
        status: 'oversized',
        flagEnabled: true,
        found: true,
        warnings: [],
        reason: 'oversized',
        nextAction: `${filename} exceeds ${INTENT_MAX_BYTES} bytes (${stat.size} bytes). Reduce content.`,
      };
      emitResult(output, {
        json: opts.json ?? false,
        formatText: (o) => `${filename} is too large.\n→ ${o.nextAction}`,
      });
      return;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const sections = parseIntentDocSections(raw);
    const warnings = validateIntentDocSections(sections);
    const contentHash = computeIntentContentHash(raw);

    const output: IntentShowOutput = {
      status: 'ok',
      flagEnabled: true,
      found: true,
      path: filePath,
      contentHash,
      lastEditedAt: stat.mtime.toISOString(),
      sections: sectionsToRecord(sections),
      warnings,
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => formatIntentShowText(o, filename),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const output: IntentShowOutput = {
      status: 'read_error',
      flagEnabled: true,
      found: false,
      warnings: [],
      reason,
      nextAction: `Check filesystem permissions for ${filePath}`,
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Error reading ${filename}: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
  }
}

// ── Command registration ─────────────────────────────────────────────────────

export function registerIntentCommand(parentCmd: Command): Command {
  const intentCmd = parentCmd
    .command('intent')
    .description('Owner-authored INTENT.md management (init, show)');

  intentCmd
    .command('init')
    .description('Create .principles/INTENT.{lang}.md from the canonical template')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--force', 'Overwrite existing INTENT file')
    .option('--dry-run', 'Show what would happen without writing (default)')
    .option('--confirm', 'Actually write the file (required to create INTENT file)')
    .option('--lang <lang>', 'Language: zh-CN or en (default: zh-CN)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleIntentInit({
        workspace: opts.workspace,
        force: opts.force === true,
        json: opts.json === true,
        dryRun: opts.dryRun === true,
        confirm: opts.confirm === true,
        lang: opts.lang,
      });
    });

  intentCmd
    .command('show')
    .description('Display a read-only summary of INTENT.{lang}.md (sections, hash, warnings)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--lang <lang>', 'Language: zh-CN or en (default: zh-CN)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleIntentShow({
        workspace: opts.workspace,
        json: opts.json === true,
        lang: opts.lang,
      });
    });

  return intentCmd;
}
