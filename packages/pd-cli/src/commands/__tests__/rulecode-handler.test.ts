/**
 * Handler tests for `pd rulecode spec|validate|replay` (PRI-439 Phase 5).
 *
 * Tests the actual handler logic (not Commander parser wiring — that's in
 * rulecode-flag-wiring.test.ts). Verifies:
 *   - spec returns the canonical RuleCode dialect spec text
 *   - validate detects forbidden patterns, missing return fields, matched=false
 *   - validate passes clean code
 *   - replay runs sandbox replay against a golden trace file
 *   - failure paths include structured reason + nextAction (CLI gate rule 6)
 *   - --json outputs exactly one parseable JSON object (CLI gate rule 1)
 *   - missing --code/--code-file fails loud with reason (ERR-009)
 *   - missing/malformed --golden-trace fails loud with reason (ERR-009)
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleRulecodeSpec,
  handleRulecodeValidate,
  handleRulecodeReplay,
} from '../rulecode.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runHandler<T>(fn: () => Promise<T>): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutChunks.push(args.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderrChunks.push(args.map(String).join(' '));
  });
  process.exitCode = undefined;

  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  const exitCode = process.exitCode;
  process.exitCode = undefined;

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
}

function parseJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

const CLEAN_CODE = `function evaluate(input, helpers) {
  if (helpers.getToolName() === 'Bash') {
    return { decision: "block", matched: true, reason: "bash commands blocked" };
  }
  return { decision: "allow", matched: false, reason: "non-bash allowed" };
}`;

const FORBIDDEN_CODE = `function evaluate(input, helpers) {
  require('fs');
  return { decision: "allow", matched: false, reason: "x" };
}`;

const MISSING_FIELDS_CODE = `function evaluate(input, helpers) {
  if (helpers.isRiskPath()) {
    return { matched: true };
  }
  return { decision: "allow", matched: false, reason: "safe" };
}`;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('pd rulecode spec', () => {
  it('returns the canonical spec text as JSON', async () => {
    const { stdout, exitCode } = await runHandler(() => handleRulecodeSpec({ json: true }));
    const output = parseJson(stdout) as { status: string; spec: string };
    expect(output.status).toBe('ok');
    expect(output.spec).toContain('RuleCode Dialect Spec');
    expect(output.spec).toContain('CANONICAL FORM');
    expect(output.spec).toContain('FORBIDDEN PATTERNS');
    expect(exitCode).toBeUndefined();
  });

  it('outputs text when --json is false', async () => {
    const { stdout, exitCode } = await runHandler(() => handleRulecodeSpec({ json: false }));
    expect(stdout).toContain('RuleCode Dialect Spec');
    expect(stdout.startsWith('{')).toBe(false);
    expect(exitCode).toBeUndefined();
  });

  it('does not set exit code on success', async () => {
    const { exitCode } = await runHandler(() => handleRulecodeSpec({ json: true }));
    expect(exitCode).toBeUndefined();
  });
});

describe('pd rulecode validate', () => {
  it('passes clean code with valid=true', async () => {
    const { stdout, exitCode } = await runHandler(() =>
      handleRulecodeValidate({ code: CLEAN_CODE, json: true }),
    );
    const output = parseJson(stdout) as {
      status: string; valid: boolean; violationCount: number; violations: string[];
    };
    expect(output.status).toBe('ok');
    expect(output.valid).toBe(true);
    expect(output.violationCount).toBe(0);
    expect(output.violations).toEqual([]);
    expect(exitCode).toBeUndefined();
  });

  it('detects forbidden patterns', async () => {
    const { stdout, exitCode } = await runHandler(() =>
      handleRulecodeValidate({ code: FORBIDDEN_CODE, json: true }),
    );
    const output = parseJson(stdout) as {
      status: string; valid: boolean; violationCount: number; violations: string[];
      reason?: string; nextAction?: string;
    };
    expect(output.status).toBe('failed');
    expect(output.valid).toBe(false);
    expect(output.violationCount).toBeGreaterThan(0);
    expect(output.violations.some((v) => v.includes('forbidden pattern'))).toBe(true);
    expect(output.reason).toBeDefined();
    expect(output.nextAction).toBeDefined();
    expect(exitCode).toBe(1);
  });

  it('detects missing return fields', async () => {
    const { stdout, exitCode } = await runHandler(() =>
      handleRulecodeValidate({ code: MISSING_FIELDS_CODE, json: true }),
    );
    const output = parseJson(stdout) as { valid: boolean; violations: string[] };
    expect(output.valid).toBe(false);
    expect(output.violations.length).toBeGreaterThan(0);
    expect(exitCode).toBe(1);
  });

  it('fails loud when no --code or --code-file provided', async () => {
    const { stdout, exitCode } = await runHandler(() =>
      handleRulecodeValidate({ json: true }),
    );
    const output = parseJson(stdout) as {
      status: string; valid: boolean; reason: string; nextAction: string;
    };
    expect(output.status).toBe('failed');
    expect(output.valid).toBe(false);
    expect(output.reason).toContain('no code provided');
    expect(output.nextAction).toContain('--code');
    expect(exitCode).toBe(1);
  });

  it('reads code from --code-file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-test-'));
    const codeFile = path.join(tmpDir, 'rule.js');
    fs.writeFileSync(codeFile, CLEAN_CODE, 'utf8');

    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeValidate({ codeFile, json: true }),
      );
      const output = parseJson(stdout) as { valid: boolean };
      expect(output.valid).toBe(true);
      expect(exitCode).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails loud when --code-file does not exist', async () => {
    const { stdout, exitCode } = await runHandler(() =>
      handleRulecodeValidate({ codeFile: '/nonexistent/path/rule.js', json: true }),
    );
    const output = parseJson(stdout) as {
      status: string; reason: string; nextAction: string;
    };
    expect(output.status).toBe('failed');
    expect(output.reason).toContain('cannot read');
    expect(output.nextAction).toBeDefined();
    expect(exitCode).toBe(1);
  });
});

describe('pd rulecode replay', () => {
  const GOLDEN_TRACE_CASES = [
    {
      caseId: 'pos-1',
      kind: 'positive' as const,
      toolName: 'Write',
      params: { normalizedPath: 'src/safe.ts' },
      expectedDecision: 'allow' as const,
    },
    {
      caseId: 'neg-1',
      kind: 'negative' as const,
      toolName: 'Bash',
      params: { command: 'rm -rf /' },
      expectedDecision: 'block' as const,
    },
  ];

  function writeGoldenTraceFile(cases: unknown): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-replay-'));
    const filePath = path.join(tmpDir, 'trace.json');
    fs.writeFileSync(filePath, JSON.stringify(cases, null, 2), 'utf8');
    return filePath;
  }

  it('passes replay with clean code and valid golden trace', async () => {
    const traceFile = writeGoldenTraceFile(GOLDEN_TRACE_CASES);
    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeReplay({ code: CLEAN_CODE, goldenTrace: traceFile, json: true }),
      );
      const output = parseJson(stdout) as {
        status: string; decision: string; reasons: string[];
      };
      expect(output.status).toBe('ok');
      expect(output.decision).toBe('accepted_shadow');
      expect(exitCode).toBeUndefined();
    } finally {
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
    }
  });

  it('fails loud when --golden-trace file does not exist', async () => {
    const { stdout, exitCode } = await runHandler(() =>
      handleRulecodeReplay({
        code: CLEAN_CODE,
        goldenTrace: '/nonexistent/trace.json',
        json: true,
      }),
    );
    const output = parseJson(stdout) as {
      status: string; reason: string; nextAction: string;
    };
    expect(output.status).toBe('failed');
    expect(output.reason).toContain('cannot read');
    expect(exitCode).toBe(1);
  });

  it('fails loud when golden trace is not valid JSON', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-replay-'));
    const traceFile = path.join(tmpDir, 'trace.json');
    fs.writeFileSync(traceFile, '{ not valid json', 'utf8');

    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeReplay({ code: CLEAN_CODE, goldenTrace: traceFile, json: true }),
      );
      const output = parseJson(stdout) as {
        status: string; reason: string; nextAction: string;
      };
      expect(output.status).toBe('failed');
      expect(output.reason).toContain('not valid JSON');
      expect(exitCode).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails loud when golden trace is not an array', async () => {
    const traceFile = writeGoldenTraceFile({ not: 'an array' });

    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeReplay({ code: CLEAN_CODE, goldenTrace: traceFile, json: true }),
      );
      const output = parseJson(stdout) as {
        status: string; reason: string; nextAction: string;
      };
      expect(output.status).toBe('failed');
      expect(output.reason).toContain('must contain a JSON array');
      expect(exitCode).toBe(1);
    } finally {
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
    }
  });

  it('fails loud when golden trace has fewer than 2 cases', async () => {
    const traceFile = writeGoldenTraceFile([GOLDEN_TRACE_CASES[0]]);

    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeReplay({ code: CLEAN_CODE, goldenTrace: traceFile, json: true }),
      );
      const output = parseJson(stdout) as {
        status: string; reason: string; nextAction: string;
      };
      expect(output.status).toBe('failed');
      expect(output.reason).toContain('at least 2 cases');
      expect(exitCode).toBe(1);
    } finally {
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
    }
  });

  it('fails loud when a golden trace case is malformed', async () => {
    const traceFile = writeGoldenTraceFile([
      { caseId: 'x' }, // missing required fields
      GOLDEN_TRACE_CASES[1],
    ]);

    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeReplay({ code: CLEAN_CODE, goldenTrace: traceFile, json: true }),
      );
      const output = parseJson(stdout) as {
        status: string; reason: string; nextAction: string;
      };
      expect(output.status).toBe('failed');
      expect(output.reason).toContain('malformed');
      expect(exitCode).toBe(1);
    } finally {
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
    }
  });

  it('fails loud when no --code or --code-file provided', async () => {
    const traceFile = writeGoldenTraceFile(GOLDEN_TRACE_CASES);
    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeReplay({ goldenTrace: traceFile, json: true }),
      );
      const output = parseJson(stdout) as {
        status: string; reason: string; nextAction: string;
      };
      expect(output.status).toBe('failed');
      expect(output.reason).toContain('no code provided');
      expect(exitCode).toBe(1);
    } finally {
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
    }
  });

  it('reports sandbox failures with structured reason + nextAction', async () => {
    const traceFile = writeGoldenTraceFile(GOLDEN_TRACE_CASES);
    // Code with forbidden pattern — sandbox will reject
    const badCode = `function evaluate(input, helpers) {
      eval('1');
      return { decision: "allow", matched: false, reason: "x" };
    }`;

    try {
      const { stdout, exitCode } = await runHandler(() =>
        handleRulecodeReplay({ code: badCode, goldenTrace: traceFile, json: true }),
      );
      const output = parseJson(stdout) as {
        status: string; decision: string; reason?: string; nextAction?: string;
        forbiddenPatternViolations: string[];
      };
      expect(output.status).toBe('failed');
      expect(output.decision).not.toBe('accepted_shadow');
      expect(output.reason).toBeDefined();
      expect(output.nextAction).toBeDefined();
      expect(exitCode).toBe(1);
    } finally {
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
    }
  });
});
