/**
 * PRI-439 §Phase 4 — Artificer L2 agent tool contract (core, pure logic).
 *
 * Defines the 4 tools the Artificer L2 agent loop can call, plus the context
 * interface that injects the sandbox + validator. This file is PURE: it holds
 * tool definitions (name / description / typebox parameter schema) and a factory
 * that wires them to an injected context. No I/O, no `node:*` imports.
 *
 * Tool set (artificer, PRI-439 Phase 4):
 *   - read_rulecode_spec : returns the RuleCode dialect spec (canonical form,
 *                          forbidden patterns, return shape, golden trace rules)
 *   - validate_rulecode  : runs STATIC validation (forbidden patterns + return
 *                          statement checks + matched=false decision check) on
 *                          a code string. No VM, no sandbox.
 *   - replay_rulecode    : runs SANDBOX replay of code against a golden trace
 *                          using the injected RefinerRuleHostGateDeps.
 *   - submit_rulecode    : the model's final ArtificerRuleOutput submission.
 *                          Stores into outputCapture; the adapter's
 *                          shouldStopAfterTurn detects the capture and stops.
 *
 * The submit_rulecode tool does NOT terminate the loop via `terminate` alone
 * (that is unreliable — agent-loop uses .every() over the whole tool batch,
 * see l2-agent-loop-adapter.ts header comment). Loop termination is driven by
 * shouldStopAfterTurn detecting the captured output.
 *
 * Boundary: pure logic, no I/O. Lives in core. No `node:*` imports.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { ArtificerRuleOutputTypebox, GoldenTraceCaseInputTypebox } from './artificer-output-typebox.js';
import { checkForbiddenPatterns, checkReturnStatementsMissingFields, checkMatchedFalseDecisions } from '../internalization/rule-code-validator.js';
import type { RefinerRuleHostGateDeps } from '../internalization/refiner-rulehost-gate.js';
import { evaluateRefinerRuleHostGate } from '../internalization/refiner-rulehost-gate.js';
import type { ArtificerValidator } from '../internalization/artificer-output.js';
import { buildGoldenTraceFromArtificer } from '../golden-trace.js';

// ── Captured-output container ─────────────────────────────────────────────────
// The adapter reads this after the loop ends. submit_rulecode stores its params
// here; shouldStopAfterTurn checks it to decide termination.

export interface ArtificerL2OutputCapture {
  output: unknown | null;
}

// ── Tool context ──────────────────────────────────────────────────────────────

export interface ArtificerL2ToolContext {
  /** Sandbox replay deps (real or test double). */
  gateDeps: RefinerRuleHostGateDeps;
  /** Artificer output validator (used by submit_rulecode for runtime validation). */
  validator: ArtificerValidator;
  /** The taskId the loop is running for (lineage consistency check in submit). */
  taskId: string;
  /** The capture container the submit_rulecode tool writes into. */
  outputCapture: ArtificerL2OutputCapture;
  /** Telemetry sink: called once per tool execution (toolName + ok/error). */
  onToolExecution?: (info: { toolName: string; ok: boolean; error?: string }) => void;
}

// ── Tool parameter schemas (typebox) ─────────────────────────────────────────

const readRulecodeSpecSchema = Type.Object({});

const validateRulecodeSchema = Type.Object({
  code: Type.String({ description: 'The rule implementation source code to validate statically.' }),
});

const replayRulecodeSchema = Type.Object({
  code: Type.String({ description: 'The rule implementation source code to replay.' }),
  goldenTraceCases: Type.Array(GoldenTraceCaseInputTypebox, {
    minItems: 2,
    maxItems: 10,
    description: 'Golden trace cases to replay against. At least 1 positive + 1 negative.',
  }),
});

// submit_rulecode parameter schema = ArtificerRuleOutputTypebox (re-exported for clarity).
export { ArtificerRuleOutputTypebox as SubmitRulecodeSchema };

// ── Spec text (read_rulecode_spec return value) ──────────────────────────────

/**
 * The RuleCode dialect spec returned by read_rulecode_spec. Pure text so the
 * model can reference it during the loop. Mirrors the constraints in
 * ARTIFICER_PROTOCOL_INSTRUCTION + checkForbiddenPatterns + the matched=false
 * decision rule.
 *
 * Exported so the `pd rulecode spec` CLI command (PRI-439 Phase 5) can return
 * the same canonical text the Artificer L2 agent sees — single source of truth.
 */
export const RULECODE_SPEC_TEXT = [
  '=== RuleCode Dialect Spec (PRI-439) ===',
  '',
  'CANONICAL FORM:',
  '  function evaluate(input, helpers) {',
  '    // ... matcher logic ...',
  '    return { decision: "allow"|"block"|"requireApproval"|"auto_correct", matched: <boolean>, reason: "<string>" };',
  '  }',
  '',
  '  - Bare function (NO `export` keyword — export is forbidden).',
  '  - Synchronous only (NO `async` / `await`).',
  '  - The function MUST be named `evaluate` and take exactly (input, helpers).',
  '',
  'RETURN SHAPE (every return statement must include all three required fields):',
  '  - decision: "allow" | "block" | "requireApproval" | "auto_correct"',
  '  - matched:  boolean (true if the rule applied to this input)',
  '  - reason:   non-empty string',
  '  - correctionProposal?: required when decision === "auto_correct"',
  '',
  'MATCHED=FALSE RULE:',
  '  When matched === false, decision MUST be "allow". A "block" or "requireApproval"',
  '  with matched=false is contradictory and will be rejected.',
  '',
  'FORBIDDEN PATTERNS (static check rejects these):',
  '  require, import, export, async, await, fetch, eval, Function, process,',
  '  globalThis, global, Reflect, Proxy, constructor, Buffer,',
  '  setTimeout, setInterval, setImmediate, queueMicrotask,',
  '  XMLHttpRequest, Math.random, crypto',
  '  (also forbidden: bracket access like globalThis["require"])',
  '',
  'INPUT SHAPE (input.action is the only safe surface to inspect):',
  '  input.action.toolName      : string',
  '  input.action.normalizedPath: string | null   (posix-relative when available)',
  '  input.action.paramsSummary : Record<string, unknown>',
  '  input.workspace.isRiskPath : boolean',
  '  input.workspace.planStatus : "NONE"|"DRAFT"|"READY"|"UNKNOWN"',
  '  input.workspace.hasPlanFile: boolean',
  '  input.derived.estimatedLineChanges: number',
  '  input.derived.bashRisk     : "safe"|"normal"|"dangerous"|"unknown"',
  '',
  'HELPERS (second argument):',
  '  helpers.isRiskPath()              : boolean',
  '  helpers.getToolName()             : string',
  '  helpers.getEstimatedLineChanges() : number',
  '  helpers.getBashRisk()             : "safe"|"normal"|"dangerous"|"unknown"',
  '  helpers.hasPlanFile()             : boolean',
  '  helpers.getPlanStatus()           : "NONE"|"DRAFT"|"READY"|"UNKNOWN"',
  '  helpers.getEpTier()               : number',
  '',
  'GOLDEN TRACE CASES (2-10 cases, at least 1 positive + 1 negative):',
  '  - positive case: expectedDecision must be "allow"',
  '  - negative case: expectedDecision is "block" or "propose_correction"',
  '  - propose_correction cases MUST include expectedProposedParams + expectedApplicationMode',
  '',
  'WORKFLOW:',
  '  1. Call read_rulecode_spec once (or as needed) to ground your output.',
  '  2. Call validate_rulecode with your draft code to catch static errors.',
  '  3. Call replay_rulecode with your code + goldenTraceCases to verify sandbox replay.',
  '  4. Call submit_rulecode with the full ArtificerRuleOutput once replay passes.',
  '',
].join('\n');

// ── Tool factory ──────────────────────────────────────────────────────────────

/**
 * Build the Artificer L2 tool set bound to an injected context.
 *
 * Returns AgentTool[] suitable for assignment to AgentContext.tools. Tools are
 * read-only by construction (validate/replay do not mutate state; submit writes
 * only into the adapter-owned outputCapture).
 */
export function buildArtificerL2Tools(ctx: ArtificerL2ToolContext): AgentTool[] {
  const readRulecodeSpecTool: AgentTool<typeof readRulecodeSpecSchema, undefined> = {
    label: 'Read RuleCode spec',
    name: 'read_rulecode_spec',
    description:
      'Read the RuleCode dialect spec: canonical form, forbidden patterns, return shape, input/helpers shape, golden trace rules. Call this BEFORE writing code so your output conforms to the contract.',
    parameters: readRulecodeSpecSchema,
    execute: async (): Promise<AgentToolResult<undefined>> => {
      try {
        ctx.onToolExecution?.({ toolName: 'read_rulecode_spec', ok: true });
        return {
          content: [{ type: 'text', text: RULECODE_SPEC_TEXT }],
          details: undefined,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.onToolExecution?.({ toolName: 'read_rulecode_spec', ok: false, error });
        return {
          content: [{ type: 'text', text: `read_rulecode_spec failed: ${error}` }],
          details: undefined,
        };
      }
    },
  };

  const validateRulecodeTool: AgentTool<typeof validateRulecodeSchema, undefined> = {
    label: 'Validate RuleCode (static)',
    name: 'validate_rulecode',
    description:
      'Run STATIC validation on a rule implementation code string. Checks forbidden patterns, return-statement missing fields, and matched=false decision consistency. Does NOT execute the code. Returns VALID or INVALID with specific violations. Call this before replay_rulecode to catch cheap errors early.',
    parameters: validateRulecodeSchema,
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      try {
        const { code } = params;
        const forbidden = checkForbiddenPatterns(code);
        const missingFields = checkReturnStatementsMissingFields(code);
        const matchedFalseViolations = checkMatchedFalseDecisions(code);

        const allViolations = [
          ...forbidden.map((label) => `forbidden pattern: ${label}`),
          ...missingFields,
          ...matchedFalseViolations,
        ];

        ctx.onToolExecution?.({ toolName: 'validate_rulecode', ok: true });

        if (allViolations.length === 0) {
          return {
            content: [{ type: 'text', text: 'VALID: no static violations detected. Proceed to replay_rulecode to verify runtime behavior.' }],
            details: undefined,
          };
        }

        return {
          content: [{
            type: 'text',
            text: `INVALID: ${allViolations.length} violation(s) found:\n${allViolations.map((v) => `  - ${v}`).join('\n')}`,
          }],
          details: undefined,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.onToolExecution?.({ toolName: 'validate_rulecode', ok: false, error });
        return {
          content: [{ type: 'text', text: `validate_rulecode failed: ${error}` }],
          details: undefined,
        };
      }
    },
  };

  const replayRulecodeTool: AgentTool<typeof replayRulecodeSchema, undefined> = {
    label: 'Replay RuleCode (sandbox)',
    name: 'replay_rulecode',
    description:
      'Run SANDBOX replay of rule code against a golden trace. Executes the code in a constrained VM and verifies each case produces the expected decision. Returns PASSED or FAILED with per-case results. Call this after validate_rulecode passes.',
    parameters: replayRulecodeSchema,
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      try {
        const { code, goldenTraceCases } = params;

        // Build the GoldenTrace from the artificer-input shape.
        const traceResult = buildGoldenTraceFromArtificer({
          cases: goldenTraceCases,
          sourceArtifactId: undefined,
        });
        if (!traceResult.ok) {
          ctx.onToolExecution?.({ toolName: 'replay_rulecode', ok: false, error: traceResult.reason });
          return {
            content: [{ type: 'text', text: `FAILED: golden trace build failed — ${traceResult.reason}` }],
            details: undefined,
          };
        }

        // Run the sandbox replay via the injected gate deps.
        const gateResult = evaluateRefinerRuleHostGate(
          { code, goldenTrace: traceResult.trace },
          ctx.gateDeps,
        );

        ctx.onToolExecution?.({ toolName: 'replay_rulecode', ok: gateResult.decision === 'accepted_shadow' });

        if (gateResult.decision === 'accepted_shadow') {
          return {
            content: [{ type: 'text', text: 'PASSED: all golden trace cases replayed successfully. You may now call submit_rulecode.' }],
            details: undefined,
          };
        }

        // Format the failure details for the model.
        const { sandboxResult } = gateResult;
        const failedCaseLines = sandboxResult.failedCases.length > 0
          ? sandboxResult.failedCases.map((c) => `  - caseId: ${c.caseId} | errorType: ${c.errorType} | message: ${c.message}`)
          : [];
        const forbiddenLines = sandboxResult.forbiddenPatternViolations.length > 0
          ? sandboxResult.forbiddenPatternViolations.map((p) => `  - forbidden pattern: ${p}`)
          : [];

        const lines = [
          `FAILED: ${gateResult.decision}`,
          ...gateResult.reasons.map((r) => `  - ${r}`),
          ...failedCaseLines,
          ...forbiddenLines,
        ].join('\n');

        return {
          content: [{ type: 'text', text: lines }],
          details: undefined,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.onToolExecution?.({ toolName: 'replay_rulecode', ok: false, error });
        return {
          content: [{ type: 'text', text: `replay_rulecode failed: ${error}` }],
          details: undefined,
        };
      }
    },
  };

  const submitRulecodeTool: AgentTool<typeof ArtificerRuleOutputTypebox, undefined> = {
    label: 'Submit RuleCode',
    name: 'submit_rulecode',
    description:
      'Submit your final ArtificerRuleOutput. You MUST call this exactly once with a complete object (taskId, sourceScribeArtifactId, implementationCode, goldenTraceCases, affectedTools, implementationSummary, risks, sourceTrace, generatedAt). The loop stops after you call this. Do not emit the answer as free text — call this tool.',
    parameters: ArtificerRuleOutputTypebox,
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      try {
        // Runtime-validate the submission against the authoritative validator
        // (Runtime Contract Rule 1/2 — never trust the typebox-validated shape
        // blindly; the DefaultArtificerValidator performs field-by-field checks
        // including lineage consistency).
        const validation = await ctx.validator.validate(params, ctx.taskId);
        if (!validation.valid) {
          ctx.onToolExecution?.({ toolName: 'submit_rulecode', ok: false, error: validation.errors.join('; ') });
          return {
            content: [{
              type: 'text',
              text: `REJECTED: ArtificerValidator found ${validation.errors.length} error(s):\n${validation.errors.map((e) => `  - ${e}`).join('\n')}\n\nFix the issues and call submit_rulecode again.`,
            }],
            details: undefined,
          };
        }

        // Store the captured output. The adapter's shouldStopAfterTurn detects
        // this and terminates the loop; terminate:true is a secondary hint only
        // (unreliable across a multi-tool batch — see l2-agent-loop-adapter.ts).
        ctx.outputCapture.output = params;
        ctx.onToolExecution?.({ toolName: 'submit_rulecode', ok: true });
        return {
          content: [{ type: 'text', text: 'Output submitted.' }],
          details: undefined,
          terminate: true,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.onToolExecution?.({ toolName: 'submit_rulecode', ok: false, error });
        return {
          content: [{ type: 'text', text: `submit_rulecode failed: ${error}` }],
          details: undefined,
        };
      }
    },
  };

  return [readRulecodeSpecTool, validateRulecodeTool, replayRulecodeTool, submitRulecodeTool];
}

/** Allow-list of tool names the Artificer L2 loop may execute (defense-in-depth for beforeToolCall). */
export const ARTIFICER_L2_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'read_rulecode_spec',
  'validate_rulecode',
  'replay_rulecode',
  'submit_rulecode',
]);
