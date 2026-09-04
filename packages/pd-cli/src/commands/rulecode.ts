/**
 * pd rulecode — RuleCode dialect spec, static validation, and sandbox replay.
 *
 * PRI-439 Phase 5: Read-only CLI commands that mirror 3 of the 4 Artificer L2
 * agent tools (read_rulecode_spec, validate_rulecode, replay_rulecode). These
 * commands let operators inspect the RuleCode contract and dry-run code
 * against the same pure-logic validators the Artificer L2 agent uses.
 *
 * Subcommands:
 *   - spec     : print the RuleCode dialect spec text
 *   - validate : run static validation (forbidden patterns + return shape +
 *                matched=false decision check) on a code string
 *   - replay   : run sandbox replay of code against a golden trace JSON file
 *
 * All three are READ-ONLY: no DB mutation, no artifact writes, no approvals,
 * no activations. Failure paths include structured reason + nextAction
 * (CLI Operator Gate rule 6).
 *
 * JSON mode is strict: --json outputs exactly one parseable JSON object on
 * stdout, no banners (CLI Operator Gate rule 1).
 *
 * ERR refs:
 *   - ERR-001 (no any): all types explicit; untrusted JSON parsed as unknown
 *   - ERR-005 (no as bypass): golden trace cases validated with type guards
 *   - ERR-009 (fail loud): missing --code/--code-file fails with reason
 *   - ERR-002 (graceful degradation with reason): all failure paths include
 *     reason + nextAction
 *   - ERR-014 (bounded preview): safeStringifyPreview on unknown payloads
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Command } from 'commander';
import { isPathInside } from '../utils/path-security.js';
import {
  RULECODE_SPEC_TEXT,
  checkForbiddenPatterns,
  checkReturnStatementsMissingFields,
  checkMatchedFalseDecisions,
  evaluateRefinerRuleHostGate,
  buildGoldenTraceFromArtificer,
  createProductionGateDeps,
} from '@principles/core/runtime-v2';
import type { GoldenTraceCaseInput } from '@principles/core/runtime-v2';
import { emitResult } from '../services/cli-output.js';

// ── Output types ─────────────────────────────────────────────────────────────

export interface RulecodeSpecOutput {
  status: 'ok';
  spec: string;
}

export interface RulecodeValidateOutput {
  status: 'ok' | 'failed';
  valid: boolean;
  violationCount: number;
  violations: string[];
  reason?: string;
  nextAction?: string;
}

export interface RulecodeReplayOutput {
  status: 'ok' | 'failed';
  decision: string;
  reasons: string[];
  failedCases: { caseId: string; errorType: string; message: string }[];
  forbiddenPatternViolations: string[];
  reason?: string;
  nextAction?: string;
  /**
   * PRI-634-F R2 (review P2): structured failure attribution
   * ({layer, reasonCode, evidence, nextAction}) — machine-readable on
   * `--json`, printed on the text path. Absent when replay passed.
   */
  failure?: { layer: string; reasonCode: string; evidence: string; nextAction: string };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve code from --code (inline) or --code-file (path). Fails loud if
 * neither is provided or the file cannot be read.
 */
function resolveCode(opts: { code?: string; codeFile?: string }): { code?: string; error?: { reason: string; nextAction: string } } {
  if (opts.code && opts.code.trim().length > 0) {
    return { code: opts.code };
  }
  if (opts.codeFile) {
    try {
      const resolved = path.resolve(opts.codeFile);
      const content = fs.readFileSync(resolved, 'utf8');
      if (content.trim().length === 0) {
        return { error: { reason: `code file is empty: ${resolved}`, nextAction: 'provide a non-empty rule implementation file' } };
      }
      return { code: content };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { error: { reason: `cannot read --code-file: ${reason}`, nextAction: 'verify the file path exists and is readable' } };
    }
  }
  return { error: { reason: 'no code provided: pass --code <string> or --code-file <path>', nextAction: 'specify one of --code or --code-file' } };
}

/**
 * Type guard: validate that an unknown value is a GoldenTraceCaseInput.
 * Treats parsed JSON as untrusted (Runtime Contract Rule 1/2/4).
 */
function isGoldenTraceCaseInput(value: unknown): value is GoldenTraceCaseInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.caseId !== 'string' || v.caseId.length === 0) return false;
  if (v.kind !== 'positive' && v.kind !== 'negative') return false;
  if (typeof v.toolName !== 'string' || v.toolName.length === 0) return false;
  if (typeof v.params !== 'object' || v.params === null) return false;
  if (typeof v.expectedDecision !== 'string') return false;
  return true;
}

/**
 * Load and validate golden trace cases from a JSON file.
 * Returns either the validated cases or a structured error.
 * Exported for boundary regression tests (internal test surface).
 */
export function loadGoldenTraceCases(
  filePath: string,
  workspaceDir?: string,
): { cases?: GoldenTraceCaseInput[]; error?: { reason: string; nextAction: string } } {
  let raw: string;
  try {
    if (!filePath || filePath.trim().length === 0) {
      throw new Error('golden trace path is empty');
    }
    const resolved = path.resolve(filePath);
    // CWE-22 boundary: canonical containment against the workspace root
    // (rejects sibling-prefix and traversal escapes; relative workspaces
    // canonicalize consistently). Filesystem-root targets are rejected by
    // containment when a workspace root is supplied.
    const normalized = path.normalize(resolved);
    if (normalized.split(/[\\/]/).includes('..')) {
      throw new Error('golden trace path contains parent traversal');
    }
    if (workspaceDir) {
      if (!isPathInside(workspaceDir, resolved)) {
        throw new Error('golden trace path must be inside the workspace directory');
      }
    } else if (normalized === path.parse(normalized).root) {
      throw new Error('golden trace path resolves to filesystem root');
    }
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: { reason: `cannot read --golden-trace file: ${reason}`, nextAction: 'verify the file path exists and is readable' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: { reason: `golden trace file is not valid JSON: ${reason}`, nextAction: 'fix the JSON syntax in the golden trace file' } };
  }

  if (!Array.isArray(parsed)) {
    return { error: { reason: 'golden trace file must contain a JSON array of cases', nextAction: 'provide an array of GoldenTraceCaseInput objects' } };
  }

  // Validate each element (Runtime Contract Rule 4 — validate array element types)
  const cases: GoldenTraceCaseInput[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const element = parsed[i];
    if (!isGoldenTraceCaseInput(element)) {
      return { error: { reason: `golden trace case at index ${i} is malformed (requires caseId, kind, toolName, params, expectedDecision)`, nextAction: `fix case at index ${i} in the golden trace file` } };
    }
    cases.push(element);
  }

  if (cases.length < 2) {
    return { error: { reason: `golden trace must contain at least 2 cases (1 positive + 1 negative), got ${cases.length}`, nextAction: 'add more cases to the golden trace file' } };
  }

  return { cases };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

interface SpecOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleRulecodeSpec(opts: SpecOptions): Promise<void> {
  const output: RulecodeSpecOutput = {
    status: 'ok',
    spec: RULECODE_SPEC_TEXT,
  };
  emitResult(output, {
    json: opts.json ?? false,
    formatText: (o) => o.spec,
  });
}

interface ValidateOptions {
  code?: string;
  codeFile?: string;
  workspace?: string;
  json?: boolean;
}

export async function handleRulecodeValidate(opts: ValidateOptions): Promise<void> {
  const json = opts.json ?? false;
  const codeResult = resolveCode(opts);
  if (codeResult.error || codeResult.code === undefined) {
    const { error } = codeResult;
    const output: RulecodeValidateOutput = {
      status: 'failed',
      valid: false,
      violationCount: 0,
      violations: [],
      reason: error?.reason ?? 'unknown error',
      nextAction: error?.nextAction ?? 'check input and retry',
    };
    emitResult(output, {
      json,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  const { code } = codeResult;
  const forbidden = checkForbiddenPatterns(code);
  const missingFields = checkReturnStatementsMissingFields(code);
  const matchedFalseViolations = checkMatchedFalseDecisions(code);

  const allViolations = [
    ...forbidden.map((label) => `forbidden pattern: ${label}`),
    ...missingFields,
    ...matchedFalseViolations,
  ];

  const output: RulecodeValidateOutput = {
    status: allViolations.length === 0 ? 'ok' : 'failed',
    valid: allViolations.length === 0,
    violationCount: allViolations.length,
    violations: allViolations,
  };

  if (allViolations.length > 0) {
    output.reason = `${allViolations.length} static violation(s) found`;
    output.nextAction = 'fix the listed violations, then run `pd rulecode replay` to verify sandbox behavior';
  }

  emitResult(output, {
    json,
    formatText: (o) => {
      if (o.valid) return 'VALID: no static violations detected.';
      const lines = [`INVALID: ${o.violationCount} violation(s):`];
      for (const v of o.violations) lines.push(`  - ${v}`);
      return lines.join('\n');
    },
  });

  if (output.status === 'failed') {
    process.exitCode = 1;
  }
}

interface ReplayOptions {
  code?: string;
  codeFile?: string;
  goldenTrace?: string;
  workspace?: string;
  json?: boolean;
}

export async function handleRulecodeReplay(opts: ReplayOptions): Promise<void> {
  const json = opts.json ?? false;
  const codeResult = resolveCode(opts);
  if (codeResult.error || codeResult.code === undefined) {
    const { error } = codeResult;
    const output: RulecodeReplayOutput = {
      status: 'failed',
      decision: 'rejected_input',
      reasons: [],
      failedCases: [],
      forbiddenPatternViolations: [],
      reason: error?.reason ?? 'unknown error',
      nextAction: error?.nextAction ?? 'check input and retry',
    };
    emitResult(output, {
      json,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  if (!opts.goldenTrace) {
    // Should not happen — --golden-trace is requiredOption. Defense-in-depth.
    const output: RulecodeReplayOutput = {
      status: 'failed',
      decision: 'rejected_input',
      reasons: [],
      failedCases: [],
      forbiddenPatternViolations: [],
      reason: '--golden-trace is required',
      nextAction: 'pass --golden-trace <path> with a JSON file of golden trace cases',
    };
    emitResult(output, {
      json,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  const traceResult = loadGoldenTraceCases(opts.goldenTrace, opts.workspace);
  if (traceResult.error || traceResult.cases === undefined) {
    const { error } = traceResult;
    const output: RulecodeReplayOutput = {
      status: 'failed',
      decision: 'rejected_input',
      reasons: [],
      failedCases: [],
      forbiddenPatternViolations: [],
      reason: error?.reason ?? 'unknown error',
      nextAction: error?.nextAction ?? 'check golden trace file and retry',
    };
    emitResult(output, {
      json,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  // Build the GoldenTrace from the artificer-input shape.
  const buildResult = buildGoldenTraceFromArtificer({
    cases: traceResult.cases,
    sourceArtifactId: undefined,
  });
  if (!buildResult.ok) {
    const output: RulecodeReplayOutput = {
      status: 'failed',
      decision: 'rejected_input',
      reasons: [],
      failedCases: [],
      forbiddenPatternViolations: [],
      reason: `golden trace build failed: ${buildResult.reason}`,
      nextAction: 'ensure the golden trace has at least 1 positive + 1 negative case',
    };
    emitResult(output, {
      json,
      formatText: (o) => `Error: ${o.reason}\n→ ${o.nextAction}`,
    });
    process.exitCode = 1;
    return;
  }

  // Run the sandbox replay via production gate deps.
  const gateDeps = createProductionGateDeps();
  const gateResult = evaluateRefinerRuleHostGate(
    { code: codeResult.code, goldenTrace: buildResult.trace },
    gateDeps,
  );

  const output: RulecodeReplayOutput = {
    status: gateResult.decision === 'accepted_shadow' ? 'ok' : 'failed',
    decision: gateResult.decision,
    reasons: gateResult.reasons,
    failedCases: gateResult.sandboxResult.failedCases.map((c) => ({
      caseId: c.caseId,
      errorType: c.errorType,
      message: c.message,
    })),
    forbiddenPatternViolations: gateResult.sandboxResult.forbiddenPatternViolations,
    ...(gateResult.failure ? { failure: gateResult.failure } : {}),
  };

  if (output.status === 'failed') {
    output.reason = `sandbox replay rejected: ${gateResult.decision}`;
    output.nextAction = gateResult.failure?.nextAction ?? 'fix the code or golden trace cases based on the failed cases above';
  }

  emitResult(output, {
    json,
    formatText: (o) => {
      if (o.status === 'ok') return 'PASSED: all golden trace cases replayed successfully.';
      const lines = [`FAILED: ${o.decision}`];
      if (o.failure) lines.push(`  - failureLayer: ${o.failure.layer} | reasonCode: ${o.failure.reasonCode}`);
      for (const r of o.reasons) lines.push(`  - ${r}`);
      for (const c of o.failedCases) lines.push(`  - caseId: ${c.caseId} | ${c.errorType}: ${c.message}`);
      for (const p of o.forbiddenPatternViolations) lines.push(`  - forbidden: ${p}`);
      return lines.join('\n');
    },
  });

  if (output.status === 'failed') {
    process.exitCode = 1;
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the `rulecode` parent command with 3 subcommands (spec, validate,
 * replay). Returns the parent command for chaining.
 *
 * This is the single source of truth for flag registration — both index.ts
 * and parser tests call this function (CLI gate rule 7).
 */
export function registerRulecodeCommand(parentCmd: Command): Command {
  const rulecodeCmd = parentCmd
    .command('rulecode', { hidden: true })
    .description('RuleCode dialect spec, static validation, and sandbox replay (read-only)');

  // spec — no code input needed
  rulecodeCmd
    .command('spec')
    .description('Print the RuleCode dialect spec text (canonical form, forbidden patterns, return shape)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRulecodeSpec({ workspace: opts.workspace, json: opts.json });
    });

  // validate — static validation only
  rulecodeCmd
    .command('validate')
    .description('Run static validation on rule implementation code (forbidden patterns + return shape)')
    .option('--code <string>', 'Rule implementation source code (inline)')
    .option('--code-file <path>', 'Read rule implementation code from file')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRulecodeValidate({
        code: opts.code,
        codeFile: opts.codeFile,
        workspace: opts.workspace,
        json: opts.json,
      });
    });

  // replay — sandbox replay against a golden trace
  rulecodeCmd
    .command('replay')
    .description('Run sandbox replay of rule code against a golden trace JSON file')
    .option('--code <string>', 'Rule implementation source code (inline)')
    .option('--code-file <path>', 'Read rule implementation code from file')
    .requiredOption('--golden-trace <path>', 'JSON file containing golden trace cases array')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      await handleRulecodeReplay({
        code: opts.code,
        codeFile: opts.codeFile,
        goldenTrace: opts.goldenTrace,
        workspace: opts.workspace,
        json: opts.json,
      });
    });

  return rulecodeCmd;
}
