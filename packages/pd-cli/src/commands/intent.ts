/**
 * pd intent — Owner-authored INTENT.md management (PRI-466).
 *
 * Subcommands:
 *   - init : create .principles/INTENT.md from the canonical template
 *   - show : display a read-only summary of INTENT.md (sections, hash, warnings)
 *
 * `init` is not gated by the intent_engineering flag — the Owner can
 * initialise the intent doc at any time. `show` IS gated: flag-off returns
 * a structured `flag_disabled` result without touching the filesystem,
 * matching the Console backend contract.
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
  INTENT_DOC_TEMPLATE,
  parseIntentDocSections,
  computeIntentContentHash,
  validateIntentDocSections,
  isFeatureEnabled,
} from '@principles/core/runtime-v2';
import type { IntentDocSections, IntentDocWarning } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';
import { emitResult } from '../services/cli-output.js';

// ── Constants ────────────────────────────────────────────────────────────────

const INTENT_DIR = '.principles';
const INTENT_FILENAME = 'INTENT.md';

// ── Output types ─────────────────────────────────────────────────────────────

export interface IntentInitOutput {
  status: 'ok' | 'skipped';
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

function getIntentFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, INTENT_DIR, INTENT_FILENAME);
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

function formatIntentShowText(o: IntentShowOutput): string {
  const lines: string[] = [];
  lines.push(`INTENT.md — ${o.path}`);
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
}

export async function handleIntentInit(opts: IntentInitOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const filePath = getIntentFilePath(workspaceDir);
  const dir = path.dirname(filePath);

  try {
    if (fs.existsSync(filePath) && !opts.force) {
      const output: IntentInitOutput = {
        status: 'skipped',
        path: filePath,
        overwritten: false,
        reason: 'file_exists',
        nextAction: `Use --force to overwrite: pd intent init --force --workspace "${workspaceDir}"`,
      };
      emitResult(output, {
        json: opts.json ?? false,
        formatText: (o) => `INTENT.md already exists at ${o.path}\n→ ${o.nextAction}`,
      });
      process.exitCode = 1;
      return;
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, INTENT_DOC_TEMPLATE, 'utf8');

    const output: IntentInitOutput = {
      status: 'ok',
      path: filePath,
      overwritten: opts.force === true,
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Created INTENT.md at ${o.path}${o.overwritten ? ' (overwritten)' : ''}\nNext: edit the file to declare your project intent, then run "pd intent show".`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'read_error',
        ok: false,
        reason,
        nextAction: `Check filesystem permissions for ${filePath}`,
      }, null, 2));
    } else {
      console.error(`Error: ${reason}`);
      console.error(`Next action: Check filesystem permissions for ${filePath}`);
    }
    process.exitCode = 1;
  }
}

export interface IntentShowOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleIntentShow(opts: IntentShowOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);

  // Flag check — flag-off short-circuits without fs access
  const configResult = loadPdConfig(workspaceDir);
  const flagsResult = computeFlagsFromLoadResult(configResult);
  const flagEnabled = isFeatureEnabled(flagsResult, 'intent_engineering');

  if (!flagEnabled) {
    const output: IntentShowOutput = {
      status: 'flag_disabled',
      flagEnabled: false,
      found: false,
      warnings: [],
      reason: 'flag_disabled',
      nextAction: 'Enable the intent_engineering feature flag in .pd/config.yaml to read INTENT.md.',
    };
    emitResult(output, {
      json: opts.json ?? false,
      formatText: (o) => `Intent Engineering is disabled (flag off).\n→ ${o.nextAction}`,
    });
    return;
  }

  const filePath = getIntentFilePath(workspaceDir);

  try {
    if (!fs.existsSync(filePath)) {
      const output: IntentShowOutput = {
        status: 'not_found',
        flagEnabled: true,
        found: false,
        warnings: [],
        reason: 'not_found',
        nextAction: `Create INTENT.md: pd intent init --workspace "${workspaceDir}"`,
      };
      emitResult(output, {
        json: opts.json ?? false,
        formatText: (o) => `INTENT.md not found.\n→ ${o.nextAction}`,
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
        nextAction: `INTENT.md exceeds ${INTENT_MAX_BYTES} bytes (${stat.size} bytes). Reduce content.`,
      };
      emitResult(output, {
        json: opts.json ?? false,
        formatText: (o) => `INTENT.md is too large.\n→ ${o.nextAction}`,
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
      formatText: (o) => formatIntentShowText(o),
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
      formatText: (o) => `Error reading INTENT.md: ${o.reason}\n→ ${o.nextAction}`,
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
    .description('Create .principles/INTENT.md from the canonical template')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--force', 'Overwrite existing INTENT.md')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleIntentInit({
        workspace: opts.workspace,
        force: opts.force === true,
        json: opts.json === true,
      });
    });

  intentCmd
    .command('show')
    .description('Display a read-only summary of INTENT.md (sections, hash, warnings)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleIntentShow({
        workspace: opts.workspace,
        json: opts.json === true,
      });
    });

  return intentCmd;
}
