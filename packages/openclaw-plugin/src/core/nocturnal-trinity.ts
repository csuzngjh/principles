/**
 * Nocturnal Trinity — Three-Stage Reflection Chain
 * ================================================
 *
 * PURPOSE: Upgrade single-reflector nocturnal sample generation to a
 * Dreamer -> Philosopher -> Scribe Trinity chain that produces higher quality
 * decision-point samples through structured multi-stage reflection.
 *
 * TRINITY STAGES:
 *  1. Dreamer   — Generates multiple candidate corrections/alternatives
 *  2. Philosopher — Provides principle-grounded critique and ranking
 *  3. Scribe    — Produces the final structured artifact draft using tournament selection
 *
 * DESIGN CONSTRAINTS:
 *  - All stage I/O is structured JSON contracts (not prose)
 *  - Any malformed stage output fails the entire chain closed
 *  - Single-reflector fallback is preserved via useTrinity flag
 *  - Trinity mode is configurable but defaults to enabled
 *  - Final artifact still passes arbiter + executability validation
 *  - Telemetry records chain mode, stage outcomes, candidate counts
 *  - Tournament selection is deterministic (same inputs → same winner)
 *
 * RUNTIME ADAPTER:
 *  - useStubs=true: uses synchronous stub implementations (no external calls)
 *  - useStubs=false: requires a TrinityRuntimeAdapter for real subagent execution
 *  - Adapter uses api.runtime.agent.runEmbeddedPiAgent() which works in background contexts
 *    (unlike api.runtime.subagent.* which requires gateway request scope)
 *  - IMPORTANT: provider and model must be passed explicitly — runEmbeddedPiAgent does NOT
 *    read config.agents.defaults.model and falls back to openai/gpt-5.4 if not specified
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ArtificerInput } from './nocturnal-artificer.js';
import type { NocturnalSessionSnapshot } from './nocturnal-trajectory-extractor.js';
import { computeThinkingModelDelta } from './nocturnal-trajectory-extractor.js';
import {
  deriveReasoningChain,
  deriveContextualFactors,
} from './nocturnal-reasoning-deriver.js';
import type { TrinityArtificerContext } from './nocturnal-artificer.js';
import {
  runTournament,
  DEFAULT_SCORING_WEIGHTS,
  type ScoringWeights,
  type TournamentTraceEntry,
  validateCandidateDiversity,
} from './nocturnal-candidate-scoring.js';
import {
  DEFAULT_THRESHOLDS,
  getEffectiveThresholds,
  type ThresholdValues,
} from './adaptive-thresholds.js';

// ---------------------------------------------------------------------------
// Configurable Model Fallback (avoid hardcoded strings deep in adapters)
// ---------------------------------------------------------------------------

const FALLBACK_PROVIDER = process.env.OPENCLAW_DEFAULT_PROVIDER || 'minimax-portal';
const FALLBACK_MODEL = process.env.OPENCLAW_DEFAULT_MODEL || 'MiniMax-M2.7';

// ---------------------------------------------------------------------------
// Embedded Role Prompts
// ---------------------------------------------------------------------------
// These prompts are embedded at build time. The agents/ directory was removed
// to eliminate fragile runtime file dependencies on the file system.

export const NOCTURNAL_DREAMER_PROMPT = `# Nocturnal Dreamer — Candidate Generation

> System prompt for Trinity Dreamer stage.
> Role: Generate multiple alternative "better decision" candidates from a session snapshot.

## Role

You are a principles analyst specializing in identifying decision alternatives.
Your task is to analyze a session trajectory and generate **multiple candidate corrections**,
each representing a different valid approach to the same problem.

## Input

You will receive:
- A **target principle** (principle ID and description)
- A **session trajectory snapshot** containing:
  - Assistant turns (sanitized text, no raw content)
  - User turns (correction cues only, no raw content)
  - Tool calls with outcomes and error messages
  - Pain events and gate blocks
  - Session metadata

## Task

Analyze the session and generate **2-3 candidate corrections**, each capturing:

1. **The bad decision**: What the agent decided or did that violated the target principle
2. **The better decision**: What the agent should have done instead (unique per candidate)
3. **The rationale**: Why this alternative is better
4. **Confidence**: How confident you are this is a valid alternative (0.0-1.0)

## Output Format

You MUST respond with ONLY a valid JSON object. No markdown, no explanation, no preamble.

{
  "valid": true,
  "candidates": [
    {
      "candidateIndex": 0,
      "badDecision": "<what the agent did wrong>",
      "betterDecision": "<what the agent should have done>",
      "rationale": "<why this is better>",
      "confidence": 0.95,
      "riskLevel": "low",
      "strategicPerspective": "conservative_fix"
    }
  ],
  "generatedAt": "<ISO timestamp>"
}

## Quality Standards

### Each candidate MUST:
- Have a candidateIndex that is unique within the candidate list
- Describe a specific, concrete badDecision (not generic anti-patterns)
- Propose a specific, actionable betterDecision (contains an action verb)
- Provide a principle-grounded rationale (explicitly references the principle)
- Include a confidence score (0.0-1.0, higher = more confident)

### betterDecision FORMAT — Must be executable:
- MUST start with a concrete action verb: read, check, verify, edit, write, create, delete, search, grep, find, list, review, examine, inspect, test, run, execute, analyze, diagnose, debug
- MUST reference a specific, concrete target (file, command, config, etc.)
- MUST describe a bounded, executable action — not a vague principle
- Examples: "Read the file before editing to verify current content", "Check user permissions before executing privileged commands"
- Anti-examples: "Per T-01, pause all tasks..." (starts with "Per"), "Be more careful" (vague verb "be")

### Candidates should DIFFER from each other:
- Different candidates should represent genuinely different approaches
- Do not generate candidates with identical betterDecisions
- Vary the confidence scores to reflect genuine uncertainty

## Strategic Perspective Requirements

Generate candidates from DISTINCT strategic perspectives:

- **conservative_fix**: Minimal deviation from original approach. Add a
  verification or validation step that was missing.
- **structural_improvement**: Reorder operations or introduce an intermediate
  checkpoint. Change HOW the goal is achieved.
- **paradigm_shift**: Challenge whether the original goal was correct.
  Consider a fundamentally different approach.

Each candidate MUST specify \`riskLevel\` ("low"|"medium"|"high") and
\`strategicPerspective\` matching one of the above.

ANTI-PATTERN: Candidates that differ only in wording, not in substance,
will be rejected.

### Candidates must NOT:
- Contain raw user text or private content
- Reference non-existent tools or impossible actions
- Propose vague improvements ("be more careful")
- Exceed the requested number of candidates

## Validation

If you cannot generate valid candidates (e.g., no clear violation found, insufficient data), respond with:

{
  "valid": false,
  "candidates": [],
  "reason": "<why valid candidates cannot be generated>",
  "generatedAt": "<ISO timestamp>"
}`;

export const NOCTURNAL_PHILOSOPHER_PROMPT = `# Nocturnal Philosopher — Candidate Evaluation and Ranking

> System prompt for Trinity Philosopher stage.
> Role: Evaluate Dreamer's candidates and rank them by principle alignment and quality.

## Role

You are a principles analyst specializing in critical evaluation.
Your task is to evaluate Dreamer's candidate corrections and rank them
based on principle alignment, specificity, and actionability.

## Input

You will receive:
- A **target principle** (principle ID and description)
- **Dreamer's candidates** — a list of alternative corrections to evaluate

## Task

For each candidate, provide:
1. **Critique**: A principle-grounded assessment of this candidate's strengths and weaknesses
2. **Principle alignment**: Whether this candidate properly aligns with the target principle
3. **Score**: Overall quality score (0.0-1.0, higher = better)
4. **Rank**: Relative ranking among all candidates (1 = best)

Finally, provide an **overall assessment** of the candidate set.

## Output Format

You MUST respond with ONLY a valid JSON object. No markdown, no explanation, no preamble.

{
  "valid": true,
  "judgments": [
    {
      "candidateIndex": 0,
      "critique": "<principle-grounded critique>",
      "principleAligned": true,
      "score": 0.92,
      "rank": 1,
      "scores": {
        "principleAlignment": 0.9,
        "specificity": 0.85,
        "actionability": 0.9,
        "executability": 0.95,
        "safetyImpact": 0.8,
        "uxImpact": 0.85
      },
      "risks": {
        "falsePositiveEstimate": 0.1,
        "implementationComplexity": "low",
        "breakingChangeRisk": false
      }
    }
  ],
  "overallAssessment": "<summary of candidate set quality>",
  "generatedAt": "<ISO timestamp>"
}

## Evaluation Criteria

### Score Components (0-1 scale each):
1. **Principle Alignment** (weight: 0.20) — Does the betterDecision properly reflect the target principle?
2. **Specificity** (weight: 0.15) — Is badDecision specific? Is betterDecision actionable?
3. **Actionability** (weight: 0.15) — Does betterDecision describe a specific next step?
4. **Executability** (weight: 0.15) — Does betterDecision start with a bounded verb (read, check, verify, edit, write, etc.) and reference a concrete target?
5. **Safety Impact** (weight: 0.20) — Does the betterDecision reduce risk of data loss, corruption, or new failure modes? Would implementing this prevent dangerous operations?
6. **UX Impact** (weight: 0.15) — Does the betterDecision reduce user frustration or improve response reliability? Would the user experience be noticeably better?

### Risk Assessment (per candidate):
For each candidate, also assess:
- **falsePositiveEstimate** (0-1): How likely is this candidate a false positive (the "betterDecision" is actually not better)?
- **implementationComplexity** ("low"/"medium"/"high"): How complex would it be to implement this correction?
- **breakingChangeRisk** (boolean): Could implementing this correction break existing behavior?

### Executability Check:
A betterDecision is executable if it:
- STARTS with a concrete action verb: read, check, verify, edit, write, create, delete, search, grep, find, list, review, examine, inspect, test, run, execute, analyze, diagnose, debug
- References a specific, concrete target (file, command, config, etc.)
- Describes a bounded, executable action — not a vague principle
- Examples that PASS: "Read the file before editing", "Check user permissions before executing"
- Examples that FAIL: "Per T-01, pause all tasks..." (starts with "Per"), "Be more careful" (vague)

### Ranking Rules:
- Candidates are ranked by score (highest = rank 1)
- Ties broken by: higher executability, then higher principle alignment, then lower candidateIndex
- If a candidate's betterDecision is NOT executable, penalize its score by 0.2

## Validation

If you cannot judge the candidates, respond with:

{
  "valid": false,
  "judgments": [],
  "overallAssessment": "",
  "reason": "<why judgment cannot be produced>",
  "generatedAt": "<ISO timestamp>"
}`;

const NOCTURNAL_SCRIBE_PROMPT = `# Nocturnal Scribe — Final Artifact Synthesis

> System prompt for Trinity Scribe stage.
> Role: Synthesize the best candidate into a final structured artifact.

## Role

You are a principles analyst specializing in structured output.
Your task is to take the top-ranked candidate from Philosopher's evaluation
and synthesize it into a final decision-point artifact that passes arbiter validation.

## Input

You will receive:
- A **target principle** (principle ID and description)
- A **session trajectory snapshot**
- **Philosopher's judgments** — ranked candidates with critiques and 6D scores
- **Dreamer's candidates** — the original candidate list
- **Philosopher's risk assessments** — falsePositiveEstimate, implementationComplexity, breakingChangeRisk per candidate

Use the risk assessments to determine which candidates require deeper contrastive analysis. High-risk candidates (high breakingChangeRisk or implementationComplexity) warrant thorough rejectedAnalysis.

## Task

Select the best candidate (Philosopher's rank 1) and synthesize it into
a final TrinityDraftArtifact. Then produce a **Contrastive Analysis** that explains why the winner was chosen and what to learn from the runners-up.

## Output Format

You MUST respond with ONLY a valid JSON object. No markdown, no explanation, no preamble.

{
  "selectedCandidateIndex": 0,
  "badDecision": "<final bad decision text>",
  "betterDecision": "<final better decision text>",
  "rationale": "<final rationale text>",
  "sessionId": "<source session ID>",
  "principleId": "<principle ID>",
  "sourceSnapshotRef": "<snapshot reference>",
  "telemetry": {
    "chainMode": "trinity",
    "dreamerPassed": true,
    "philosopherPassed": true,
    "scribePassed": true,
    "candidateCount": 2,
    "selectedCandidateIndex": 0,
    "stageFailures": []
  },
  "rejectedAnalysis": {
    "whyRejected": "<mental model that led to the rejected candidate>",
    "warningSignals": ["<observable caution trigger 1>", "<trigger 2>"],
    "correctiveThinking": "<correct reasoning path that should have been taken>"
  },
  "chosenJustification": {
    "whyChosen": "<why this candidate was selected over others>",
    "keyInsights": ["<transferable insight 1>", "<insight 2>", "<insight 3>"],
    "limitations": ["<when this approach does NOT apply 1>", "<limitation 2>"]
  },
  "contrastiveAnalysis": {
    "criticalDifference": "<ONE key insight distinguishing chosen from rejected>",
    "decisionTrigger": "<When X, do Y pattern>",
    "preventionStrategy": "<how to systematically avoid the rejected path>"
  }
}

All three analysis sections (rejectedAnalysis, chosenJustification, contrastiveAnalysis) are optional but recommended. When multiple candidates were evaluated, include them to provide richer training signals.

## Validation

If you cannot synthesize an artifact:

{
  "selectedCandidateIndex": -1,
  "badDecision": "",
  "betterDecision": "",
  "rationale": "",
  "sessionId": "<source session ID>",
  "principleId": "<principle ID>",
  "sourceSnapshotRef": "",
  "telemetry": {
    "chainMode": "trinity",
    "dreamerPassed": true,
    "philosopherPassed": false,
    "scribePassed": false,
    "candidateCount": 2,
    "selectedCandidateIndex": -1,
   "stageFailures": ["Philosopher: no valid judgments produced"]
  }
}`;

const ARTIFICER_SYSTEM_PROMPT = `# Nocturnal Artificer — Rule Implementation Generator

> System prompt for Artificer stage.
> Role: Generate a sandbox-safe JavaScript interception rule from Trinity reflection results.

## Role

You are a code generation specialist for the Principles Disciple framework.
Your task is to take the Trinity reflection output (bad decision, better decision, rationale)
and generate a JavaScript interception rule that would prevent the bad decision from recurring.

## Sandbox Constraints (MANDATORY)

The generated code runs in a sandboxed RuleHost. It MUST:
1. Export a \`meta\` object with: name (string), version (string), ruleId (string), coversCondition (string)
2. Export an \`evaluate(input, helpers)\` function
3. \`evaluate\` must return: { decision: 'allow'|'block'|'requireApproval', matched: boolean, reason: string }

### Available Helpers (via helpers parameter):
- helpers.isRiskPath() — boolean: whether the target path is a risk path
- helpers.getToolName() — string: the tool being called
- helpers.getEstimatedLineChanges() — number: estimated line changes
- helpers.getBashRisk() — 'normal'|'high'|'critical': bash command risk level
- helpers.hasPlanFile() — boolean: whether a plan file exists
- helpers.getPlanStatus() — 'DRAFT'|'READY'|string: plan status
- helpers.getCurrentEpiTier() — number: current evolution tier

### FORBIDDEN APIs (will cause validation rejection):
- eval(), Function(), import(), require()
- fetch, XMLHttpRequest
- child_process, process, fs, http, https, net
- setTimeout/setInterval with string arguments
- WebSocket, Buffer

## Output Format

You MUST respond with ONLY a valid JSON object. No markdown, no explanation, no preamble.

{
  "ruleId": "<target rule ID>",
  "implementationType": "code",
  "candidateSource": "<the JavaScript source code as a single string, with proper escaping>",
  "helperUsage": ["<list of helper names used>"],
  "expectedDecision": "allow"|"block"|"requireApproval",
  "rationale": "<why this implementation addresses the bad decision>",
  "lineage": {
    "artifactKind": "rule-implementation-candidate",
    "sourceSnapshotRef": "<from input>",
    "sourcePainIds": ["<from input>"],
    "sourceGateBlockIds": ["<from input>"]
  }
}

## Important Notes
- The candidateSource must be valid JavaScript that can be compiled with new Function()
- Use template literals for string values inside the code
- The evaluate function should be specific to the observed bad decision pattern
- Return matched: false and decision: 'allow' when the rule does not apply
- The code must be deterministic (same input → same output)`;

// ---------------------------------------------------------------------------
// Trinity Runtime Adapter
// ---------------------------------------------------------------------------

export interface ArtificerRuleContext {
  ruleName: string;
  ruleDescription: string;
  triggerCondition: string;
  action: string;
}

/**
 * Interface for Trinity stage invocation.
 * Implementations can use real subagent runtimes or stubs.
 */
 
export interface TrinityRuntimeAdapter {
  /**
   * Check if the runtime surface is available for Trinity stage execution.
   * @returns true if the adapter can invoke stages
   */
  isRuntimeAvailable(): boolean;

  /**
   * Get the reason for the last runtime failure, or null if no failure.
   */
  getLastFailureReason(): string | null;

  /**
   * Invoke the Dreamer stage.
   * @param snapshot Session trajectory snapshot
   * @param principleId Target principle ID
   * @param maxCandidates Maximum number of candidates to generate
   * @returns Dreamer output JSON
   */
  invokeDreamer(
    _snapshot: NocturnalSessionSnapshot,
    _principleId: string,
    _maxCandidates: number
  ): Promise<DreamerOutput>;

  /**
   * Invoke the Philosopher stage.
   * @param dreamerOutput Dreamer's output
   * @param principleId Target principle ID
   * @param snapshot Session snapshot (for violation evidence)
   * @returns Philosopher output JSON
   */
  invokePhilosopher(
    _dreamerOutput: DreamerOutput,
    _principleId: string,
    _snapshot: NocturnalSessionSnapshot
  ): Promise<PhilosopherOutput>;

  /**
   * Invoke the Scribe stage.
   * @param dreamerOutput Dreamer's output
   * @param philosopherOutput Philosopher's output
   * @param snapshot Session snapshot
   * @param principleId Target principle ID
   * @param telemetry Running telemetry
   * @param config Trinity config
   * @returns Scribe draft artifact or null if failed
   */
  invokeScribe(
    _dreamerOutput: DreamerOutput,
    _philosopherOutput: PhilosopherOutput,
    _snapshot: NocturnalSessionSnapshot,
    _principleId: string,
    _telemetry: TrinityTelemetry,
    _config: TrinityConfig
  ): Promise<TrinityDraftArtifact | null>;

  /**
   * Invoke the Artificer stage.
   * Generates a rule implementation candidate from Trinity reflection results.
   * @param input Artificer input with principle, rule, snapshot, and scribe artifact
   * @param ruleContext Target rule metadata for prompt context
   * @param telemetry Running telemetry
   * @param config Trinity config
   * @returns Raw JSON string matching ArtificerOutput, or null on failure
   */
  invokeArtificer(
    _input: ArtificerInput,
    _ruleContext: ArtificerRuleContext,
    _telemetry: TrinityTelemetry,
    _config: TrinityConfig
  ): Promise<string | null>;

  /**
   * Clean up any resources used by the adapter.
   * Called after Trinity chain completes (success or failure).
   */
  close?(): Promise<void>;
}
 

// ---------------------------------------------------------------------------
// OpenClaw Runtime Adapter
// ---------------------------------------------------------------------------

/**
 * OpenClaw-backed Trinity runtime adapter.
 * Uses api.runtime.agent.runEmbeddedPiAgent() which works in background contexts
 * (unlike api.runtime.subagent.* which requires gateway request scope).
 */
/** @deprecated Use PDErrorCategory from '@principles/core/runtime-v2'. M2 migration will replace this. */
export type TrinityRuntimeFailureCode =
  | 'runtime_unavailable'
  | 'invalid_runtime_request'
  | 'runtime_run_failed'
  | 'runtime_timeout'
  | 'runtime_session_read_failed';

export class TrinityRuntimeContractError extends Error {
  readonly code: TrinityRuntimeFailureCode;
  readonly diagnostics?: Record<string, unknown>;

  constructor(
    code: TrinityRuntimeFailureCode,
    message: string,
    diagnostics?: Record<string, unknown>
  ) {
    super(`${code}: ${message}`);
    this.name = 'TrinityRuntimeContractError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

// ---------------------------------------------------------------------------
// Reasoning Context Serialization (D-03, D-04)
// ---------------------------------------------------------------------------

/**
 * Format derived reasoning signals into a prompt section for Dreamer.
 *
 * Returns the formatted "## Reasoning Context" section as a string,
 * or null if no meaningful reasoning content exists to include.
 *
 * Only reasoningChain + contextualFactors are serialized.
 * DecisionPoints are NOT injected (reserved for Phase 37 Scribe per D-04).
 */
export function formatReasoningContext(snapshot: NocturnalSessionSnapshot): string | null {
  const reasoningChain = deriveReasoningChain(snapshot.assistantTurns);
  const contextualFactors = deriveContextualFactors(snapshot);

  const hasReasoningContent = reasoningChain.length > 0 &&
    reasoningChain.some(s => s.thinkingContent || s.uncertaintyMarkers.length > 0);

  if (!hasReasoningContent && !contextualFactors.fileStructureKnown &&
      !contextualFactors.errorHistoryPresent &&
      !contextualFactors.userGuidanceAvailable &&
      !contextualFactors.timePressure) {
    return null;
  }

  const sections: string[] = ['## Reasoning Context', ''];

  // Serialize reasoning chain (only turns with non-empty signals)
  const significantTurns = reasoningChain.filter(
    s => s.thinkingContent || s.uncertaintyMarkers.length > 0
  );
  for (const signal of significantTurns) {
    if (signal.thinkingContent) {
      sections.push(`- Turn ${signal.turnIndex}: Internal reasoning: "${signal.thinkingContent.slice(0, 200)}"`);
    }
    if (signal.uncertaintyMarkers.length > 0) {
      sections.push(`- Turn ${signal.turnIndex}: Uncertainty detected: ${signal.uncertaintyMarkers.join(', ')}`);
    }
    if (signal.confidenceSignal !== 'high') {
      sections.push(`- Turn ${signal.turnIndex}: Confidence: ${signal.confidenceSignal}`);
    }
  }

  // Serialize contextual factors
  const factorLabels: string[] = [];
  if (contextualFactors.fileStructureKnown) factorLabels.push('File structure explored before modification');
  if (contextualFactors.errorHistoryPresent) factorLabels.push('Prior error history present');
  if (contextualFactors.userGuidanceAvailable) factorLabels.push('User guidance/corrections available');
  if (contextualFactors.timePressure) factorLabels.push('Time pressure detected (rapid tool calls)');

  if (factorLabels.length > 0) {
    sections.push('');
    sections.push('Environmental context:');
    for (const label of factorLabels) {
      sections.push(`- ${label}`);
    }
  }

  sections.push('');
  return sections.join('\n');
}

export class OpenClawTrinityRuntimeAdapter implements TrinityRuntimeAdapter {

  private readonly api: {
    runtime: {
      agent: {
        runEmbeddedPiAgent: (_opts: {
          sessionId: string;
          sessionFile: string;
          prompt: string;
          extraSystemPrompt?: string;
          config?: unknown;
          provider?: string;
          model?: string;
          timeoutMs: number;
          runId: string;
          disableTools?: boolean;
        }) => Promise<{
          payloads?: { isError?: boolean; text?: string }[];
        }>;
      };
      config?: {
        loadConfig?: () => unknown;
      };
    };
    config?: unknown;
    logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  };
  private lastFailureReason: string | null = null;
   

  private readonly stageTimeoutMs: number;
  private readonly tempDir: string;

  constructor(
    api: OpenClawTrinityRuntimeAdapter['api'],
    stageTimeoutMs = 300_000  // 5 min — increased from 3 min to accommodate slower LLM responses
  ) {
    if (typeof api?.runtime?.agent?.runEmbeddedPiAgent !== 'function') {
      throw new TrinityRuntimeContractError(
        'runtime_unavailable',
        'embedded runtime unavailable (missing runtime.agent.runEmbeddedPiAgent)',
      );
    }

    this.api = api;
    this.stageTimeoutMs = stageTimeoutMs;
    // Cross-platform temp directory for session files
    this.tempDir = path.join(os.tmpdir(), `pd-trinity-${process.pid}`);
    // Clean up any stale temp files from previous crashed runs
    this.cleanupStaleTempDirs();
  }

   
  isRuntimeAvailable(): boolean {
    return true;
  }

  getLastFailureReason(): string | null {
    return this.lastFailureReason;
  }

  /**
   * Clean up temp directories from previous crashed runs.
   * Matches pattern pd-trinity-* in the OS temp directory.
   */
  private cleanupStaleTempDirs(): void {
    try {
      const osTempDir = os.tmpdir();
      if (!fs.existsSync(osTempDir)) return;
      const entries = fs.readdirSync(osTempDir);
      for (const entry of entries) {
        if (entry.startsWith('pd-trinity-') && entry !== path.basename(this.tempDir)) {
          const fullPath = path.join(osTempDir, entry);
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      }
    } catch (err) {
      this.api.logger?.warn?.(`[Trinity] Failed to cleanup stale temp dirs: ${err instanceof Error ? err.message.replace(/([A-Za-z]:\\[^:\\s]+|\\\/[^\s:]+)/g, '[PATH]') : String(err)}`);
    }
  }

  /**
   * Load the full OpenClaw config (including models.providers).
   *
   * Why: `this.api.config` is the plugin config, not the full OpenClaw config.
   * It does NOT contain `models.providers`, which is needed to resolve provider
   * model definitions. `api.runtime.config.loadConfig()` returns the full config.
   *
   * Fallback: If loadConfig() is unavailable, we return the plugin config.
   * The caller (resolveModel) handles this with a minimax-portal fallback.
   */
  private loadFullConfig(): Record<string, unknown> | undefined {
    // Try runtime.config.loadConfig() first (available in native plugin context)
    const loadConfig = this.api.runtime?.config?.loadConfig;
    if (loadConfig && typeof loadConfig === 'function') {
      try {
        return loadConfig() as Record<string, unknown> | undefined;
      } catch (err) {
        this.api.logger?.warn?.(`[Trinity] loadConfig() failed, falling back to plugin config: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Fallback: plugin config (limited — won't have models.providers)
    // resolveModel() handles this with a minimax-portal/MiniMax-M2.7 fallback
    return this.api.config as Record<string, unknown> | undefined;
  }

  /**
   * Resolve the provider and model from the OpenClaw config.
   * runEmbeddedPiAgent does NOT read config.agents.defaults.model —
   * it requires explicit params.provider and params.model.
   */
     
  private resolveModel(): { provider: string; model: string } {
    const config = this.loadFullConfig();
    const agents = config?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelConfig = defaults?.model;

    if (typeof modelConfig === 'string' && modelConfig.includes('/')) {
      const parts = modelConfig.split('/');
      return { provider: parts[0], model: parts.slice(1).join('/') };
    }

    if (modelConfig && typeof modelConfig === 'object') {
      const mc = modelConfig as Record<string, unknown>;
      const primary = mc.primary as string | undefined;
      if (primary && primary.includes('/')) {
        const parts = primary.split('/');
        return { provider: parts[0], model: parts.slice(1).join('/') };
      }
    }

    // Last resort fallback — read from env vars to avoid hardcoded strings
    this.api.logger?.warn?.(`[Trinity] Could not resolve model from config, using fallback: ${FALLBACK_PROVIDER}/${FALLBACK_MODEL}`);
    return { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL };
  }

  /**
   * Create a valid JSONL session file for runEmbeddedPiAgent.
   */
  private createSessionFile(stage: string): string {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    return path.join(this.tempDir, `${stage}-${randomUUID()}.jsonl`);
  }

  /**
   * Extract text from runEmbeddedPiAgent result.
   */
   
  private extractPayloadText(result: { payloads?: { isError?: boolean; text?: string }[] }): string {
    return (result.payloads ?? [])
      .filter(p => !p.isError)
      .map(p => p.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n');
  }

  /** Clamp a value to [0, 1] range — used for LLM-produced scores that may be out of range */
   
  private clamp01(val: unknown, fallback = 0): number {
    if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
    return Math.min(1, Math.max(0, val));
  }

   
  private classifyRuntimeError(error: unknown): TrinityRuntimeFailureCode {
    const detail = error instanceof Error ? error.message : String(error);
    return /timeout/i.test(detail) ? 'runtime_timeout' : 'runtime_run_failed';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async invokeDreamer(
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
    maxCandidates: number
  ): Promise<DreamerOutput> {
    this.lastFailureReason = null;
    const runId = `dreamer-${randomUUID()}`;
    const sessionFile = this.createSessionFile('dreamer');
    const prompt = this.buildDreamerPrompt(snapshot, principleId, maxCandidates);
    const model = this.resolveModel();

    this.api.logger?.info(`[Trinity:Dreamer] Using model: ${model.provider}/${model.model}`);

    try {
      const result = await this.api.runtime.agent.runEmbeddedPiAgent({
        sessionId: runId,
        sessionFile,
        prompt,
        extraSystemPrompt: NOCTURNAL_DREAMER_PROMPT,
        config: this.loadFullConfig(),
        provider: model.provider,
        model: model.model,
        timeoutMs: this.stageTimeoutMs,
        runId,
        disableTools: true,
      });

      const outputText = this.extractPayloadText(result);
      if (!outputText) {
        return this.buildRuntimeFailureDreamerOutput(
          'runtime_session_read_failed',
          'Dreamer returned empty response',
        );
      }

      // Log extracted Dreamer output for traceability
      this.api.logger?.info(`[Trinity:Dreamer] Output preview: ${outputText.slice(0, 500)}`);

      return this.parseDreamerOutput(outputText);
    } catch (err) {
      return this.buildRuntimeFailureDreamerOutput(this.classifyRuntimeError(err), err);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      try { fs.unlinkSync(sessionFile); } catch (err) { this.api.logger?.warn?.(`[Trinity] Failed to delete session file: ${sessionFile}`); }
    }
  }

  async invokePhilosopher(
    dreamerOutput: DreamerOutput,
    principleId: string,
    snapshot: NocturnalSessionSnapshot
  ): Promise<PhilosopherOutput> {
    this.lastFailureReason = null;
    const runId = `philosopher-${randomUUID()}`;
    const sessionFile = this.createSessionFile('philosopher');
    const prompt = this.buildPhilosopherPrompt(dreamerOutput, principleId, snapshot);
    const model = this.resolveModel();

    try {
      const result = await this.api.runtime.agent.runEmbeddedPiAgent({
        sessionId: runId,
        sessionFile,
        prompt,
        extraSystemPrompt: NOCTURNAL_PHILOSOPHER_PROMPT,
        config: this.loadFullConfig(),
        provider: model.provider,
        model: model.model,
        timeoutMs: this.stageTimeoutMs,
        runId,
        disableTools: true,
      });

      const outputText = this.extractPayloadText(result);
      if (!outputText) {
        return this.buildRuntimeFailurePhilosopherOutput(
          'runtime_session_read_failed',
          'Philosopher returned empty response',
        );
      }

      // Log extracted Philosopher output for traceability
      this.api.logger?.info(`[Trinity:Philosopher] Output preview: ${outputText.slice(0, 500)}`);

      return this.parsePhilosopherOutput(outputText);
    } catch (err) {
      return this.buildRuntimeFailurePhilosopherOutput(this.classifyRuntimeError(err), err);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      try { fs.unlinkSync(sessionFile); } catch (err) { this.api.logger?.warn?.(`[Trinity] Failed to delete session file: ${sessionFile}`); }
    }
  }


   
  async invokeScribe(
    dreamerOutput: DreamerOutput,
    philosopherOutput: PhilosopherOutput,
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
    telemetry: TrinityTelemetry,

    _config: TrinityConfig
  ): Promise<TrinityDraftArtifact | null> {
    this.lastFailureReason = null;
    const prompt = this.buildScribePrompt(dreamerOutput, philosopherOutput, snapshot, principleId);
    const model = this.resolveModel();

    // Retry up to 2 times on JSON parse / missing-field errors (common LLM output issues)
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const runId = `scribe-${randomUUID()}`;
      const sessionFile = this.createSessionFile('scribe');

      try {
        const result = await this.api.runtime.agent.runEmbeddedPiAgent({
          sessionId: runId,
          sessionFile,
          prompt,
          extraSystemPrompt: NOCTURNAL_SCRIBE_PROMPT,
          config: this.loadFullConfig(),
          provider: model.provider,
          model: model.model,
          timeoutMs: this.stageTimeoutMs,
          runId,
          disableTools: true,
        });

        const outputText = this.extractPayloadText(result);
        if (!outputText) {
          this.recordFailure('runtime_session_read_failed', 'Scribe returned empty response');
          if (attempt < maxAttempts) { await this.sleep(1000); continue; }
          return null;
        }

        // Log extracted Scribe output for traceability
        this.api.logger?.info(`[Trinity:Scribe] Output preview (attempt ${attempt}): ${outputText.slice(0, 800)}`);

        const artifact = this.parseScribeOutput(outputText, snapshot, principleId, telemetry);
        if (artifact) return artifact;

        // JSON parse or missing-field error — retry
        if (attempt < maxAttempts) {
          await this.sleep(1500);
          continue;
        }
        return null;
      } catch (err) {
        this.recordFailure(this.classifyRuntimeError(err), err);
        if (attempt < maxAttempts) { await this.sleep(2000); continue; }
        return null;
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        try { fs.unlinkSync(sessionFile); } catch (err) { this.api.logger?.warn?.(`[Trinity] Failed to delete session file: ${sessionFile}`); }
      }
    }
    return null;
  }

  async invokeArtificer(
    input: ArtificerInput,
    ruleContext: ArtificerRuleContext,
    _telemetry: TrinityTelemetry,
    _config: TrinityConfig
  ): Promise<string | null> {
    this.lastFailureReason = null;
    const prompt = this.buildArtificerPrompt(input, ruleContext);
    const model = this.resolveModel();

    this.api.logger?.info(`[Trinity:Artificer] Using model: ${model.provider}/${model.model}`);

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const runId = `artificer-${randomUUID()}`;
      const sessionFile = this.createSessionFile('artificer');

      try {
        const result = await this.api.runtime.agent.runEmbeddedPiAgent({
          sessionId: runId,
          sessionFile,
          prompt,
          extraSystemPrompt: ARTIFICER_SYSTEM_PROMPT,
          config: this.loadFullConfig(),
          provider: model.provider,
          model: model.model,
          timeoutMs: this.stageTimeoutMs,
          runId,
          disableTools: true,
        });

        const outputText = this.extractPayloadText(result);
        if (!outputText) {
          this.recordFailure('runtime_session_read_failed', 'Artificer returned empty response');
          if (attempt < maxAttempts) { await this.sleep(1000); continue; }
          return null;
        }

        this.api.logger?.info(`[Trinity:Artificer] Output preview (attempt ${attempt}): ${outputText.slice(0, 500)}`);

        // Return raw JSON string for caller to parse
        return outputText;
      } catch (err) {
        this.recordFailure(this.classifyRuntimeError(err), err);
        if (attempt < maxAttempts) { await this.sleep(2000); continue; }
        return null;
      } finally {
        try { fs.unlinkSync(sessionFile); } catch { /* session file cleanup */ }
      }
    }
    return null;
  }

  async close(): Promise<void> {
    // Clean up temp directory
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.tempDir, file));
        }
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (err) {
      this.api.logger?.warn?.(`[Trinity] Session cleanup failed: ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

   
   
  private buildDreamerPrompt(
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
    maxCandidates: number
  ): string {
    // Build detailed tool failure list
    const failures = snapshot.toolCalls
      .filter(tc => tc.outcome === 'failure')
      .map(tc => {
        let desc = `- ${tc.toolName}`;
        if (tc.filePath) desc += ` on ${tc.filePath}`;
        desc += ` → FAILED: ${tc.errorMessage || 'unknown error'}`;
        return desc;
      });

    // Build detailed pain event list
    const pains = snapshot.painEvents
      .filter(pe => pe.score >= 50)
      .map(pe => `- Pain (score: ${pe.score}): ${pe.reason || 'no reason'} [source: ${pe.source}]`);

    // Build gate block list
    const blocks = snapshot.gateBlocks
      .map(gb => `- Gate blocked ${gb.toolName}: ${gb.reason}`);

    // Build assistant decision context (last 3 turns max)
    const recentTurns = snapshot.assistantTurns
      .slice(-3)
      .map((t, i) => `[Turn ${i+1}] ${t.sanitizedText.slice(0, 300)}`)
      .join('\n');

    // Build user correction cues (if any)
    const userCues = snapshot.userTurns
      .filter(ut => ut.correctionDetected)
      .map(ut => `- User correction: ${ut.correctionCue || 'detected'}`)
      .join('\n');

    const sections = [
      `## Target Principle`,
      `**Principle ID**: ${principleId}`,
      ``,
      `## Session Context`,
      `**Session ID**: ${snapshot.sessionId}`,
      ``,
    ];

    if (failures.length > 0) {
      sections.push(`## Tool Failures (${failures.length})`);
      sections.push(failures.join('\n'));
      sections.push('');
    }

    if (pains.length > 0) {
      sections.push(`## Pain Signals (${pains.length})`);
      sections.push(pains.join('\n'));
      sections.push('');
    }

    if (blocks.length > 0) {
      sections.push(`## Gate Blocks (${blocks.length})`);
      sections.push(blocks.join('\n'));
      sections.push('');
    }

    if (recentTurns) {
      sections.push(`## Assistant Decision Context`);
      sections.push(recentTurns);
      sections.push('');
    }

    if (userCues) {
      sections.push(`## User Corrections`);
      sections.push(userCues);
      sections.push('');
    }

    // ## Reasoning Context — derived signals from Phase 34 deriver module (D-03, D-04)
    const reasoningSection = formatReasoningContext(snapshot);
    if (reasoningSection) {
      sections.push(reasoningSection);
    }

    sections.push(`## Task`,
      `Analyze the above session and generate ${maxCandidates} candidate corrections.`,
      `Each candidate must:`,
      `1. Identify a specific bad decision from the session`,
      `2. Propose a concrete better decision grounded in principle ${principleId}`,
      `3. The betterDecision MUST START with a bounded verb: read, check, verify, edit, write, create, delete, search, grep, find, list, review, examine, inspect, test, run, execute, analyze, diagnose, debug`,
      `4. Explain the rationale referencing the principle`,
      ``,
      `Respond with ONLY a valid JSON object matching the DreamerOutput contract.`
    );

    return sections.join('\n');
  }

   
   
  private buildPhilosopherPrompt(
    dreamerOutput: DreamerOutput,
    principleId: string,
    snapshot: NocturnalSessionSnapshot
  ): string {
    const candidatesJson = JSON.stringify(dreamerOutput.candidates, null, 2);

    // Build per-candidate metadata from Dreamer (risk level + strategic perspective)
    const candidateMeta = dreamerOutput.candidates
      .filter(c => c.riskLevel || c.strategicPerspective)
      .map(c => `- Candidate #${c.candidateIndex}: risk=${c.riskLevel || 'N/A'}, perspective=${c.strategicPerspective || 'N/A'}`);

    // Build violation summary from snapshot for Philosopher to validate candidates
    const failures = snapshot.toolCalls
      .filter(tc => tc.outcome === 'failure')
      .map(tc => `- ${tc.toolName}${tc.filePath ? ` on ${tc.filePath}` : ''} → FAILED: ${tc.errorMessage || 'unknown error'}`);

    const pains = snapshot.painEvents
      .filter(pe => pe.score >= 50)
      .map(pe => `- Pain (score: ${pe.score}, severity: ${pe.severity || 'N/A'}): ${pe.reason || 'no reason'} [source: ${pe.source}]`);

    const blocks = snapshot.gateBlocks
      .map(gb => `- Gate blocked ${gb.toolName}: ${gb.reason}`);

    const userCues = snapshot.userTurns
      .filter(ut => ut.correctionDetected)
      .map(ut => `- User correction: ${ut.correctionCue || 'detected'}`);

    const sections = [
      `## Target Principle`,
      `**Principle ID**: ${principleId}`,
      ``,
      `## Session Violation Summary`,
      `**Session ID**: ${snapshot.sessionId}`,
    ];

    if (failures.length > 0) {
      sections.push(`\n### Tool Failures (${failures.length})`);
      sections.push(failures.join('\n'));
    }

    if (pains.length > 0) {
      sections.push(`\n### Pain Signals (${pains.length})`);
      sections.push(pains.join('\n'));
    }

    if (blocks.length > 0) {
      sections.push(`\n### Gate Blocks (${blocks.length})`);
      sections.push(blocks.join('\n'));
    }

    if (userCues.length > 0) {
      sections.push(`\n### User Corrections (${userCues.length})`);
      sections.push(userCues.join('\n'));
    }

    if (candidateMeta.length > 0) {
      sections.push(`\n### Candidate Risk Profiles (${candidateMeta.length})`);
      sections.push(candidateMeta.join('\n'));
    }

    sections.push(
      ``,
      `## Dreamer's Candidates`,
      candidatesJson,
      ``,
      `## Task`,
      `Evaluate each candidate against the violation summary above.`,
      `For each candidate:`,
      `1. Is the badDecision accurate — does it match the actual violations in the session?`,
      `2. Is the betterDecision specific and actionable?`,
      `3. Does the betterDecision START with a bounded verb (read, check, verify, edit, write, etc.)?`,
      `4. Does the rationale correctly reference principle ${principleId}?`,
      `5. Is the confidence score justified?`,
      ``,
      `**Penalize executability**: If betterDecision does NOT start with a bounded verb, reduce score by 0.2.`,
      ``,
      `Respond with ONLY a valid JSON object matching the PhilosopherOutput contract.`
    );

    return sections.join('\n');
  }
 

   
   
  private buildScribePrompt(
    dreamerOutput: DreamerOutput,
    philosopherOutput: PhilosopherOutput,
    snapshot: NocturnalSessionSnapshot,
    principleId: string
  ): string {
    const candidatesJson = JSON.stringify(dreamerOutput.candidates, null, 2);
    const judgmentsJson = JSON.stringify(philosopherOutput.judgments, null, 2);

    // Build violation evidence for Scribe to ground the final artifact
    const violations: string[] = [];

    const failures = snapshot.toolCalls.filter(tc => tc.outcome === 'failure');
    for (const tc of failures) {
      violations.push(`- Tool failure: ${tc.toolName}${tc.filePath ? ` on ${tc.filePath}` : ''} → ${tc.errorMessage || 'unknown error'}`);
    }

    const pains = snapshot.painEvents.filter(pe => pe.score >= 50);
    for (const pe of pains) {
      violations.push(`- Pain signal (score: ${pe.score}): ${pe.reason || 'no reason'} [source: ${pe.source}]`);
    }

    const blocks = snapshot.gateBlocks;
    for (const gb of blocks) {
      violations.push(`- Gate blocked: ${gb.toolName} → ${gb.reason}`);
    }

    const sections = [
      `## Target Principle`,
      `**Principle ID**: ${principleId}`,
      ``,
      `## Original Violation Evidence`,
      `**Session ID**: ${snapshot.sessionId}`,
    ];

    if (violations.length > 0) {
      sections.push(violations.join('\n'));
    } else {
      sections.push(`(No specific violations found in snapshot)`);
    }

    // Build risk summary from Philosopher 6D judgments for Scribe contrastive analysis
    const riskSummary = philosopherOutput.judgments
      .map(j => {
        const risk = j.risks ? ` [risks: fp=${j.risks.falsePositiveEstimate.toFixed(2)}, complexity=${j.risks.implementationComplexity}, breaking=${j.risks.breakingChangeRisk}]` : '';
        return `  - candidate[${j.candidateIndex}] (rank ${j.rank}, score ${j.score?.toFixed(2) ?? 'n/a'}): ${j.principleAligned ? 'aligned' : 'not aligned'}${risk}`;
      })
      .join('\n');

    sections.push(
      ``,
      `## Dreamer's Candidates`,
      candidatesJson,
      ``,
      `## Philosopher's Judgments + Risk Assessments`,
      judgmentsJson,
      ``,
      `## Philosopher 6D Risk Summary`,
      `Use this to determine contrastive depth — high-risk candidates need deeper analysis:`,
      riskSummary,
      ``,
      `## Task`,
      `Select the best candidate (Philosopher's rank 1) and synthesize it into a final TrinityDraftArtifact.`,
      `Then produce contrastive analysis explaining why the winner was chosen and what the rejected candidates teach us.`,
      ``,
      `## CRITICAL: betterDecision Format Requirements`,
      `Your betterDecision MUST pass executability validation. It MUST:`,
      `1. START with a concrete action verb from this list: read, check, verify, edit, write, create, delete, search, grep, find, list, review, examine, inspect, test, run, execute, analyze, diagnose, debug`,
      `2. Reference a SPECIFIC, concrete target (file path, command name, config key, etc.)`,
      `3. Describe a BOUNDED, executable action — not a vague principle or process`,
      ``,
      `**Examples that PASS executability check**:`,
      `- "Read the file before editing to verify current content"`,
      `- "Check user permissions before executing privileged commands"`,
      `- "Verify the routing infrastructure is operational before analyzing system state"`,
      `- "Edit the config file to set timeout=30000ms"`,
      ``,
      `**Examples that FAIL executability check**:`,
      `- "Per T-01, pause all analysis tasks..." (starts with "Per", not a bounded verb)`,
      `- "The agent should have first checked..." (starts with "The", not the action verb)`,
      `- "Be more careful with routing tools" (vague verb "be")`,
      `- "Ensure proper authorization" (vague verb "ensure")`,
      ``,
      `Respond with ONLY a valid JSON object.`
    );

    return sections.join('\n');
  }

  private buildArtificerPrompt(
    input: ArtificerInput,
    ruleContext: ArtificerRuleContext
  ): string {
    const sections: string[] = [];

    sections.push('## Target Rule');
    sections.push(`Rule ID: ${input.ruleId}`);
    sections.push(`Rule Name: ${ruleContext.ruleName}`);
    sections.push(`Description: ${ruleContext.ruleDescription}`);
    sections.push(`Trigger Condition: ${ruleContext.triggerCondition}`);
    sections.push(`Action: ${ruleContext.action}`);
    sections.push('');

    sections.push('## Scribe Reflection');
    sections.push(`Bad Decision: ${input.scribeArtifact.badDecision}`);
    sections.push(`Better Decision: ${input.scribeArtifact.betterDecision}`);
    sections.push(`Rationale: ${input.scribeArtifact.rationale}`);
    sections.push('');

    sections.push('## Pain Events');
    const painSummaries = input.snapshot.painEvents
      .slice(0, 5)
      .map((pe) => `- [score: ${pe.score}] ${pe.reason || 'no reason'} (source: ${pe.source})`);
    sections.push(painSummaries.length > 0 ? painSummaries.join('\n') : '(none)');
    sections.push('');

    sections.push('## Gate Blocks');
    const gateSummaries = input.snapshot.gateBlocks
      .slice(0, 5)
      .map((gb) => `- ${gb.toolName}: ${gb.reason}`);
    sections.push(gateSummaries.length > 0 ? gateSummaries.join('\n') : '(none)');
    sections.push('');

    sections.push('## Lineage');
    sections.push(`Source Snapshot: ${input.lineage.sourceSnapshotRef}`);
    sections.push(`Pain IDs: ${input.lineage.sourcePainIds.join(', ') || '(none)'}`);
    sections.push(`Gate Block IDs: ${input.lineage.sourceGateBlockIds.join(', ') || '(none)'}`);

    return sections.join('\n');
  }
   

  private parseDreamerOutput(text: string): DreamerOutput {
    const json = this.extractJson(text);
    if (!json) {
      return {
        valid: false,
        candidates: [],
        reason: 'Failed to parse Dreamer output as JSON',
        generatedAt: new Date().toISOString(),
      };
    }

    try {
      const parsed = JSON.parse(json);
      // Validate required structure
      if (typeof parsed.valid !== 'boolean') {
        return {
          valid: false,
          candidates: [],
          reason: 'Dreamer output missing "valid" field',
          generatedAt: new Date().toISOString(),
        };
      }
      if (!Array.isArray(parsed.candidates)) {
        return {
          valid: false,
          candidates: [],
          reason: 'Dreamer output missing "candidates" array',
          generatedAt: new Date().toISOString(),
        };
      }
      return {
        valid: parsed.valid,
        candidates: parsed.candidates,
        reason: parsed.reason,
        generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      };
    } catch {
      return {
        valid: false,
        candidates: [],
        reason: `JSON parse error: ${text.slice(0, 100)}`,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  private buildRuntimeFailureDreamerOutput(
    code: TrinityRuntimeFailureCode,
    error: unknown
  ): DreamerOutput {
    const reason = this.recordFailure(code, error);
    return {
      valid: false,
      candidates: [],
      reason,
      generatedAt: new Date().toISOString(),
    };
  }

  private parsePhilosopherOutput(text: string): PhilosopherOutput {
    const json = this.extractJson(text);
    if (!json) {
      return {
        valid: false,
        judgments: [],
        overallAssessment: '',
        reason: 'Failed to parse Philosopher output as JSON',
        generatedAt: new Date().toISOString(),
      };
    }

    try {
      const parsed = JSON.parse(json);
      if (typeof parsed.valid !== 'boolean') {
        return {
          valid: false,
          judgments: [],
          overallAssessment: '',
          reason: 'Philosopher output missing "valid" field',
          generatedAt: new Date().toISOString(),
        };
      }
      if (!Array.isArray(parsed.judgments)) {
        return {
          valid: false,
          judgments: [],
          overallAssessment: '',
          reason: 'Philosopher output missing "judgments" array',
          generatedAt: new Date().toISOString(),
        };
      }
      return {
        valid: parsed.valid,
        judgments: parsed.judgments.map((j: Record<string, unknown>) => ({
          candidateIndex: j.candidateIndex,
          critique: j.critique ?? '',
          principleAligned: j.principleAligned ?? false,
          score: j.score ?? 0,
          rank: j.rank ?? 0,
          // Optional 6D scores and risk assessment (Phase 36)
          // Only include a dimension if the LLM actually returned a number (not undefined/null).
          // This preserves the distinction between "LLM returned 0" vs "LLM omitted the field."
          ...(j.scores ? {
            scores: Object.fromEntries(
              (['principleAlignment', 'specificity', 'actionability', 'executability', 'safetyImpact', 'uxImpact'] as const)
                .map(dim => [dim, (j.scores as Record<string, unknown>)[dim]])
                .filter(([, v]) => typeof v === 'number')
                .map(([dim, v]) => [dim, this.clamp01(v as number)])
            )
          } : {}),
          ...(j.risks ? (() => {
            const risks = j.risks as Record<string, unknown>;
            const fp = risks.falsePositiveEstimate;
            const hasFp = typeof fp === 'number';
            const risksObj: {
              falsePositiveEstimate?: number;
              implementationComplexity: string;
              breakingChangeRisk: boolean;
             
            } = {
              implementationComplexity: (risks.implementationComplexity as string) ?? 'medium',
              breakingChangeRisk: Boolean(risks.breakingChangeRisk),
            };
             
            if (hasFp) risksObj.falsePositiveEstimate = this.clamp01(fp as number);
            return { risks: risksObj };
          })() : {}),
        })),
        overallAssessment: parsed.overallAssessment ?? '',
        reason: parsed.reason,
        generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      };
    } catch {
      return {
        valid: false,
        judgments: [],
        overallAssessment: '',
        reason: `JSON parse error: ${text.slice(0, 100)}`,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  private buildRuntimeFailurePhilosopherOutput(
    code: TrinityRuntimeFailureCode,
    error: unknown
  ): PhilosopherOutput {
    const reason = this.recordFailure(code, error);
    return {
      valid: false,
      judgments: [],
      overallAssessment: '',
      reason,
      generatedAt: new Date().toISOString(),
    };
  }

  private recordFailure(
    code: TrinityRuntimeFailureCode,
    error: unknown
  ): string {
    const detail = error instanceof Error ? error.message : String(error);
    this.lastFailureReason = `${code}: ${detail}`;
    return this.lastFailureReason;
  }

   
   
  private parseScribeOutput(
    text: string,
    snapshot: NocturnalSessionSnapshot,
    principleId: string,

    _telemetry: TrinityTelemetry
  ): TrinityDraftArtifact | null {
    const json = this.extractJson(text);
    if (!json) {
      this.recordFailure('runtime_run_failed', new Error('Scribe output contains no parseable JSON'));
      return null;
    }

    try {
      const parsed = JSON.parse(json);
      if (typeof parsed.selectedCandidateIndex !== 'number') {
        this.recordFailure('runtime_run_failed', new Error(`Scribe output missing "selectedCandidateIndex" field: ${text.slice(0, 200)}`));
        return null;
      }

      // Validate contrastive analysis sub-fields (H-03): only include if structure is intact
      const contrastiveAnalysis = parsed.contrastiveAnalysis
        && typeof parsed.contrastiveAnalysis === 'object'
        && typeof parsed.contrastiveAnalysis.criticalDifference === 'string'
        ? parsed.contrastiveAnalysis : undefined;

      const rejectedAnalysis = parsed.rejectedAnalysis
        && typeof parsed.rejectedAnalysis === 'object'
        && typeof parsed.rejectedAnalysis.whyRejected === 'string'
        ? parsed.rejectedAnalysis : undefined;

      const chosenJustification = parsed.chosenJustification
        && typeof parsed.chosenJustification === 'object'
        && typeof parsed.chosenJustification.whyChosen === 'string'
        ? parsed.chosenJustification : undefined;

      return {
        selectedCandidateIndex: parsed.selectedCandidateIndex,
        badDecision: parsed.badDecision ?? '',
        betterDecision: parsed.betterDecision ?? '',
        rationale: parsed.rationale ?? '',
        sessionId: snapshot.sessionId,
        principleId,
        sourceSnapshotRef: `snapshot-${snapshot.sessionId}-${Date.now()}`,
        telemetry: {
          chainMode: 'trinity',
          usedStubs: _telemetry.usedStubs,
          dreamerPassed: true,
          philosopherPassed: true,
          scribePassed: true,
          candidateCount: parsed.candidateCount ?? 0,
          selectedCandidateIndex: parsed.selectedCandidateIndex,
          stageFailures: [],
        },
        ...(contrastiveAnalysis ? { contrastiveAnalysis } : {}),
        ...(rejectedAnalysis ? { rejectedAnalysis } : {}),
        ...(chosenJustification ? { chosenJustification } : {}),
      };
    } catch {
      this.recordFailure('runtime_run_failed', new Error(`Scribe output JSON parse error: ${json.slice(0, 200)}`));
      return null;
    }
  }

  /**
   * Extract JSON object from text that may contain markdown code blocks.
   */
   
   
  private extractJson(text: string): string | null {
    // Try direct parse first
    try {
      JSON.parse(text);
      return text;
    } catch {
      // Try extracting from markdown code blocks
    }

    // Match triple-backtick JSON blocks
    const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
    if (codeBlockMatch) {
      const extracted = codeBlockMatch[1].trim();
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        // Not valid JSON
      }
    }

    // Try to find first { and last } to extract JSON object
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const extracted = text.slice(firstBrace, lastBrace + 1);
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        // Not valid JSON
      }
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Trinity Mode Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for Trinity chain execution.
 */
export interface TrinityConfig {
  /**
   * Whether to use Trinity chain (true) or single-reflector (false).
   * Default: true
   */
  useTrinity: boolean;

  /**
   * Maximum candidates Dreamer should generate.
   * Default: 3
   */
  maxCandidates: number;

  /**
   * Whether to use stub stage outputs (for testing without real model calls).
   * Default: false (real subagent calls via runtimeAdapter)
   */
  useStubs: boolean;

  /**
   * Runtime adapter for real subagent execution.
   * Required when useStubs is false. Ignored when useStubs is true.
   * Default: undefined
   */
  runtimeAdapter?: TrinityRuntimeAdapter;

  /**
   * Scoring weights for tournament selection.
   * Default: DEFAULT_SCORING_WEIGHTS
   */
  scoringWeights?: ScoringWeights;

  /**
   * Threshold values for tournament eligibility.
   * Default: DEFAULT_THRESHOLDS
   */
  thresholds?: ThresholdValues;

  /**
   * State directory for threshold persistence.
   * If provided, thresholds will be loaded from state.
   */
  stateDir?: string;
}

// ---------------------------------------------------------------------------
// Trinity Intermediate Contracts
// ---------------------------------------------------------------------------

// Forward-exports from shared types module — single source of truth
export type {
  DreamerCandidate,
  DreamerOutput,
  PhilosopherRiskAssessment,
  Philosopher6DScores,
  PhilosopherJudgment,
  PhilosopherOutput,
} from './nocturnal-trinity-types.js';

// Import all types for local use in this file
import type {
  DreamerCandidate,
  DreamerOutput,
  PhilosopherRiskAssessment,
  Philosopher6DScores,
  PhilosopherJudgment,
  PhilosopherOutput,
} from './nocturnal-trinity-types.js';

/**
 * Analysis of a rejected candidate — why it lost the tournament.
 * Informs training signal for "what to avoid".
 */
export interface RejectedAnalysis {
  /** Mental model that led to the rejected candidate */
  whyRejected: string;
  /** Observable caution triggers that were missed or ignored */
  warningSignals: string[];
  /** Correct reasoning path that should have been taken */
  correctiveThinking: string;
}

/**
 * Justification for the chosen candidate — why it won the tournament.
 * Informs training signal for "what to do".
 */
export interface ChosenJustification {
  /** Why this candidate was selected over others */
  whyChosen: string;
  /** 1-3 transferable insights from this decision */
  keyInsights: string[];
  /** When this approach does NOT apply */
  limitations: string[];
}

/**
 * Contrastive analysis: key differences between chosen and rejected paths.
 * Synthesizes the core lesson from the tournament.
 */
export interface ContrastiveAnalysis {
  /** ONE key insight distinguishing chosen from rejected */
  criticalDifference: string;
  /** Pattern: "When X, do Y" */
  decisionTrigger: string;
  /** How to systematically avoid the rejected path */
  preventionStrategy: string;
}

/**
 * Scribe output — final structured artifact draft.
 * Scribe synthesizes the best candidate into an approved artifact format.
 */
export interface TrinityDraftArtifact {
  /** The selected winning candidate index */
  selectedCandidateIndex: number;
  /** The final badDecision */
  badDecision: string;
  /** The final betterDecision */
  betterDecision: string;
  /** The final rationale */
  rationale: string;
  /** Source session from snapshot */
  sessionId: string;
  /** Target principle ID */
  principleId: string;
  /** Reference to snapshot used */
  sourceSnapshotRef: string;
  /** Chain telemetry */
  telemetry: TrinityTelemetry;
  /** Reflection quality: delta in thinking model activation (-1 to 1) */
  thinkingModelDelta?: number;
  /** Reflection quality: gain in planning ratio (-1 to 1) */
  planningRatioGain?: number;
  /** Optional routing context for a follow-on Artificer stage */
  artificerContext?: TrinityArtificerContext;
  /** Contrastive analysis: chosen vs rejected reasoning paths (SCRIBE-03) */
  contrastiveAnalysis?: ContrastiveAnalysis;
  /** Analysis of the rejected candidates — why they lost the tournament (SCRIBE-01) */
  rejectedAnalysis?: RejectedAnalysis;
  /** Justification for the chosen candidate — why it won (SCRIBE-02) */
  chosenJustification?: ChosenJustification;
}

export interface TrinityTelemetry {
  /** Whether Trinity or single-reflector was used */
  chainMode: 'trinity' | 'single-reflector';
  /** Whether stub implementations were used (always true in Phase 8) */
  usedStubs: boolean;
  /** Whether each stage passed */
  dreamerPassed: boolean;
  philosopherPassed: boolean;
  scribePassed: boolean;
  /** Number of candidates generated */
  candidateCount: number;
  /** Final selected candidate index */
  selectedCandidateIndex: number;
  /** Stage failure reasons (if any) */
  stageFailures: string[];
  /** Tournament trace for explainability (optional) */
  tournamentTrace?: TournamentTraceEntry[];
  /** Winner aggregate score (optional) */
  winnerAggregateScore?: number;
  /** Whether winner passed all thresholds (optional) */
  winnerThresholdPassed?: boolean;
  /** Number of eligible candidates after threshold check (optional) */
  eligibleCandidateCount?: number;
  /** Whether Dreamer candidates passed diversity validation (DIVER-04) */
  diversityCheckPassed?: boolean;
  /** Risk levels assigned to Dreamer candidates (for telemetry) */
  candidateRiskLevels?: string[];
  /** Aggregate 6D Philosopher evaluation metrics (informational) */
  philosopher6D?: {
    /** Average scores across all candidates per dimension */
    avgScores: {
      principleAlignment: number;
      specificity: number;
      actionability: number;
      executability: number;
      safetyImpact: number;
      uxImpact: number;
    };
    /** Count of candidates with breakingChangeRisk = true */
    highRiskCount: number;
  };
}

// ---------------------------------------------------------------------------
// Trinity Stage Validation
// ---------------------------------------------------------------------------

/**
 * Validation failure for a Trinity stage.
 */
export interface TrinityStageFailure {
  stage: 'dreamer' | 'philosopher' | 'scribe';
  reason: string;
}

/**
 * Result of Trinity chain execution.
 */
export interface TrinityResult {
  /** Whether Trinity chain completed successfully */
  success: boolean;
  /** The final draft artifact (if success) */
  artifact?: TrinityDraftArtifact;
  /** Telemetry about the chain execution */
  telemetry: TrinityTelemetry;
  /** Stage failures (if any) */
  failures: TrinityStageFailure[];
  /** Whether fallback to single-reflector occurred */
  fallbackOccurred: boolean;
  /** Optional routing context for a follow-on Artificer stage */
  artificerContext?: TrinityArtificerContext;
}

// ---------------------------------------------------------------------------
// Internal Types for Trinity Execution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stub Stage Implementations (Phase 2 — no real subagent calls)
// ---------------------------------------------------------------------------

/**
 * STUB DREAMER — generates synthetic candidates for testing.
 *
 * In production, this would call the actual Dreamer subagent.
 * The stub generates plausible candidates based on snapshot signals.
 */
     
export function invokeStubDreamer(
  snapshot: NocturnalSessionSnapshot,
  principleId: string,
  maxCandidates: number
): DreamerOutput {
  const hasFailures = (snapshot.stats.failureCount ?? 0) > 0;
  const hasPain = snapshot.stats.totalPainEvents > 0;
  const hasGateBlocks = (snapshot.stats.totalGateBlocks ?? 0) > 0;

  // #219: Detect fallback data source - stats may be incomplete
  const isFallback = snapshot._dataSource === 'pain_context_fallback';
  const fallbackWarning = isFallback ? ' [fallback data: stats may be incomplete]' : '';

  const candidates: DreamerCandidate[] = [];

  // Generate candidates based on available signals
  // NOTE: betterDecision includes thinking model patterns so computeThinkingModelDelta > 0
  //       (these activate T-03, T-05, T-08 patterns respectively)
  if (hasGateBlocks) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Proceeded with a tool call despite receiving a gate block, bypassing the safety check',
      betterDecision: 'Review docs/gateblocks.md and verify authorization requirements first; based on the evidence, this irreversible action must be reviewed before proceeding',
      rationale: 'Respecting gate blocks prevents unintended system modifications',
      confidence: 0.95,
      riskLevel: 'low' as const,
      strategicPerspective: 'conservative_fix' as const,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Retried the same operation immediately after gate block without understanding why',
        betterDecision: 'Check the gatekeeper source first to diagnose the block reason; this is irreversible, so we must be certain before proceeding',
        rationale: 'Understanding why a gate blocked prevents repeated blocks',
        confidence: 0.85,
        riskLevel: 'low' as const,
        strategicPerspective: 'conservative_fix' as const,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Modified the target of the blocked operation to bypass the check',
        betterDecision: 'Review docs/auth.md first to understand the authorization structure, then request proper review before any change',
        rationale: 'Proper authorization ensures accountability and prevents unintended changes',
        confidence: 0.75,
        riskLevel: 'low' as const,
        strategicPerspective: 'conservative_fix' as const,
      });
    }
  } else if (hasPain) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Continued executing operations without pausing to address accumulated pain signals',
      betterDecision: 'Check logs/pain.json first to analyze pain signals; this error indicates we should stop and reconsider before proceeding',
      rationale: 'Pain signals indicate accumulated friction or error conditions',
      confidence: 0.90,
      riskLevel: 'medium' as const,
      strategicPerspective: 'structural_improvement' as const,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Ignored warning pain events and proceeded with high-risk operations',
        betterDecision: 'Review src/pain-detector.ts first; based on the evidence, this indicates a deeper issue we must not ignore',
        rationale: 'Addressing friction reduces error rates and improves outcomes',
        confidence: 0.80,
        riskLevel: 'medium' as const,
        strategicPerspective: 'structural_improvement' as const,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Retried failing operations without analyzing why they caused pain',
        betterDecision: 'Analyze logs/errors.json first to identify the failure pattern; this suggests we should stop and rethink before retrying',
        rationale: 'Pattern analysis prevents recurring pain from the same source',
        confidence: 0.70,
        riskLevel: 'medium' as const,
        strategicPerspective: 'structural_improvement' as const,
      });
    }
  } else if (hasFailures) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Retried a failing operation without diagnosing the root cause',
      betterDecision: 'Verify config.json preconditions first, based on the error in logs/failure.json, before retrying',
      rationale: 'Diagnosing failures before retry prevents repeated failures',
      confidence: 0.92,
      riskLevel: 'high' as const,
      strategicPerspective: 'paradigm_shift' as const,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Continued to the next operation after a failure without addressing it',
        betterDecision: 'Check docs/debugging.md first to diagnose what failed; we must not ignore this when the action is irreversible',
        rationale: 'Unaddressed failures compound and cause larger issues',
        confidence: 0.85,
        riskLevel: 'high' as const,
        strategicPerspective: 'paradigm_shift' as const,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Assumed the failure was transient and retried without investigation',
        betterDecision: 'Verify src/validator.ts state first; this error indicates a deeper problem before assuming resolution',
        rationale: 'Verification prevents cascading failures from unresolved issues',
        confidence: 0.78,
        riskLevel: 'high' as const,
        strategicPerspective: 'paradigm_shift' as const,
      });
    }
  } else {
    // No signal available - cannot generate meaningful candidates
    // Return empty candidates array to trigger invalid output
    // (Real Dreamer would also fail with no signal)
    return {
      valid: false,
      candidates: [],
      reason: 'No signal available for candidate generation (failureCount=0, painEvents=0, gateBlocks=0)',
      generatedAt: new Date().toISOString(),
    };
  }

  // Ensure we don't exceed maxCandidates
  const limitedCandidates = candidates.slice(0, Math.min(candidates.length, maxCandidates));

  // #219/#259: Annotate and downgrade confidence if data source is fallback
  // Fallback data is incomplete (trajectory DB unavailable) — reduce confidence
  // so reviewers don't over-trust low-quality candidates.
  const annotatedCandidates = limitedCandidates.map((c) => ({
    ...c,
    rationale: isFallback ? c.rationale + fallbackWarning : c.rationale,
    confidence: isFallback ? Math.round(c.confidence * 0.5 * 100) / 100 : c.confidence,
  }));

  return {
    valid: annotatedCandidates.length > 0,
    candidates: annotatedCandidates,
    generatedAt: new Date().toISOString(),
    reason: annotatedCandidates.length === 0 ? 'No signal available for candidate generation' : undefined,
  };
}

/**
 * STUB PHILOSOPHER — ranks candidates based on simple heuristics.
 *
 * In production, this would call the actual Philosopher subagent.
 * The stub applies principle alignment heuristics.
 */
export function invokeStubPhilosopher(
  dreamerOutput: DreamerOutput,
  _principleId: string,
  _snapshot: NocturnalSessionSnapshot
): PhilosopherOutput {
  if (!dreamerOutput.valid || dreamerOutput.candidates.length === 0) {
    return {
      valid: false,
      judgments: [],
      overallAssessment: '',
      reason: 'No candidates to judge',
      generatedAt: new Date().toISOString(),
    };
  }

  // Simple heuristic scoring based on candidate structure
  const judgments: PhilosopherJudgment[] = dreamerOutput.candidates.map((candidate) => {
    let principleAligned = true;
    let score = candidate.confidence;

    // Heuristic: longer rationales tend to be more principled
    if (candidate.rationale.length < 30) {
      score *= 0.8;
      principleAligned = false;
    }

    // Heuristic: betterDecision should be actionable (contain verbs)
    const actionableVerbs = ['read', 'check', 'verify', 'edit', 'write', 'search', 'review', 'analyze'];
    const hasActionable = actionableVerbs.some((v) => candidate.betterDecision.toLowerCase().includes(v));
    if (!hasActionable) {
      score *= 0.85;
      principleAligned = false;
    }

    // Heuristic: badDecision should be specific (not generic)
    const genericPatterns = ['something went wrong', 'it did not work', 'mistake was made'];
    const isGeneric = genericPatterns.some((p) => candidate.badDecision.toLowerCase().includes(p));
    if (isGeneric) {
      score *= 0.75;
      principleAligned = false;
    }

    // Deterministic 6D scores based on strategic perspective (Phase 35 D-07 mapping)
    const perspective = candidate.strategicPerspective;
     
    let sixDScores: Philosopher6DScores;
     
    let riskAssessment: PhilosopherRiskAssessment;

    if (perspective === 'conservative_fix') {
      sixDScores = {
        principleAlignment: 0.9,
        specificity: 0.8,
        actionability: 0.85,
        executability: 0.9,
        safetyImpact: 0.95,
        uxImpact: 0.7,
      };
      riskAssessment = {
        falsePositiveEstimate: 0.1,
        implementationComplexity: 'low',
        breakingChangeRisk: false,
      };
    } else if (perspective === 'structural_improvement') {
      sixDScores = {
        principleAlignment: 0.75,
        specificity: 0.7,
        actionability: 0.75,
        executability: 0.7,
        safetyImpact: 0.7,
        uxImpact: 0.8,
      };
      riskAssessment = {
        falsePositiveEstimate: 0.25,
        implementationComplexity: 'medium',
        breakingChangeRisk: false,
      };
    } else if (perspective === 'paradigm_shift') {
      sixDScores = {
        principleAlignment: 0.6,
        specificity: 0.5,
        actionability: 0.5,
        executability: 0.45,
        safetyImpact: 0.4,
        uxImpact: 0.6,
      };
      riskAssessment = {
        falsePositiveEstimate: 0.4,
        implementationComplexity: 'high',
        breakingChangeRisk: true,
      };
    } else {
      // Fallback for candidates without strategicPerspective
      sixDScores = {
        principleAlignment: score,
        specificity: score * 0.9,
        actionability: score * 0.85,
        executability: score * 0.8,
        safetyImpact: score * 0.7,
        uxImpact: score * 0.75,
      };
      riskAssessment = {
        falsePositiveEstimate: 0.3,
        implementationComplexity: 'medium',
        breakingChangeRisk: false,
      };
    }

    return {
      candidateIndex: candidate.candidateIndex,
      critique: `Candidate ${candidate.candidateIndex} scored ${score.toFixed(2)}. ${
        principleAligned
          ? 'Principle-aligned with specific actionable alternative.'
          : 'May need refinement for principle alignment.'
      }`,
      principleAligned,
      score: Math.min(1, Math.max(0, score)),
      rank: 0, // Will be set after sorting
      scores: sixDScores,
      risks: riskAssessment,
    };
  });

  // Sort by score descending and assign ranks
  judgments.sort((a, b) => b.score - a.score);
  judgments.forEach((j, idx) => {
    j.rank = idx + 1;
  });

  const [topJudgment] = judgments;

  return {
    valid: true,
    judgments,
    overallAssessment: `Best candidate is #${topJudgment.candidateIndex} with score ${topJudgment.score.toFixed(2)}. ${topJudgment.principleAligned ? 'Well-aligned with principle.' : 'Alignment could be improved.'}`,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * STUB SCRIBE — synthesizes best candidate into final artifact using tournament selection.
 *
 * In production, this would call the actual Scribe subagent.
 * The stub uses tournament selection (scoring + thresholds) to pick the winner.
 */
 
 
export function invokeStubScribe(
  dreamerOutput: DreamerOutput,
  philosopherOutput: PhilosopherOutput,
  snapshot: NocturnalSessionSnapshot,
  principleId: string,
  telemetry: TrinityTelemetry,
  config: TrinityConfig
): TrinityDraftArtifact | null {
  if (!dreamerOutput.valid || !philosopherOutput.valid) {
    return null;
  }

  // Get thresholds (from config or state, or defaults)
  const thresholds = config.thresholds ?? (config.stateDir ? getEffectiveThresholds(config.stateDir) : { ...DEFAULT_THRESHOLDS });
  const weights = config.scoringWeights ?? DEFAULT_SCORING_WEIGHTS;

  // Run tournament selection
  const tournamentResult = runTournament(
    dreamerOutput.candidates,
    philosopherOutput.judgments,
    thresholds,
    weights
  );

  if (!tournamentResult.success || !tournamentResult.winner) {
    // Tournament failed — no eligible candidate
    return null;
  }

  const {winner} = tournamentResult;

  // Update telemetry with tournament info
  const updatedTelemetry: TrinityTelemetry = {
    ...telemetry,
    tournamentTrace: tournamentResult.trace,
    winnerAggregateScore: winner.scores.aggregate,
    winnerThresholdPassed: winner.thresholdPassed,
    eligibleCandidateCount: tournamentResult.rankedCandidates.filter((c) => c.thresholdPassed).length,
  };

  return {
    selectedCandidateIndex: winner.candidateIndex,
    badDecision: winner.candidate.badDecision,
    betterDecision: winner.candidate.betterDecision,
    rationale: winner.candidate.rationale,
    sessionId: snapshot.sessionId,
    principleId,
    sourceSnapshotRef: `snapshot-${snapshot.sessionId}-${Date.now()}`,
    telemetry: updatedTelemetry,
  };
}

// ---------------------------------------------------------------------------
// Trinity Chain Execution
// ---------------------------------------------------------------------------

export interface RunTrinityOptions {
  /** Snapshot to generate candidates from */
  snapshot: NocturnalSessionSnapshot;
  /** Target principle ID */
  principleId: string;
  /** Trinity configuration */
  config: TrinityConfig;
}

/**
 * Execute the Trinity chain using stubs (synchronous).
 * Use runTrinityAsync for real subagent execution via runtime adapter.
 *
 * @param options - Trinity execution options
 * @returns TrinityResult with final artifact or failure info
 */
export function runTrinity(options: RunTrinityOptions): TrinityResult {
  const { snapshot, principleId, config } = options;

  // Stub path: use synchronous stub implementations
  if (config.useStubs) {
     
     
    return runTrinityWithStubs(snapshot, principleId, config);
  }

  // Real execution path: requires runtimeAdapter
  // This is handled asynchronously in runTrinityAsync
  const errorMsg = '[Trinity] useStubs=false requires a runtimeAdapter. Use runTrinityAsync for real subagent execution.';
  const failures: TrinityStageFailure[] = [{ stage: 'dreamer', reason: errorMsg }];
  const telemetry: TrinityTelemetry = {
    chainMode: 'trinity',
    usedStubs: false,
    dreamerPassed: false,
    philosopherPassed: false,
    scribePassed: false,
    candidateCount: 0,
    selectedCandidateIndex: -1,
    stageFailures: [`Configuration: ${errorMsg}`],
  };
  console.error(`[Trinity] ERROR: ${errorMsg}`);
  return {
    success: false,
    telemetry,
    failures,
    fallbackOccurred: false,
  };
}

/**
 * Execute the Trinity chain with real subagent runtime (asynchronous).
 * Requires config.runtimeAdapter to be set.
 *
 * @param options - Trinity execution options
 * @returns Promise<TrinityResult> with final artifact or failure info
 */
export async function runTrinityAsync(options: RunTrinityOptions): Promise<TrinityResult> {
  const { snapshot, principleId, config } = options;

  if (config.useStubs) {
    // Stub path: use synchronous stubs
     
     
    return runTrinityWithStubs(snapshot, principleId, config);
  }

  if (!config.runtimeAdapter) {
    const errorMsg = '[Trinity] useStubs=false requires config.runtimeAdapter to be set.';
    const failures: TrinityStageFailure[] = [{ stage: 'dreamer', reason: errorMsg }];
    const telemetry: TrinityTelemetry = {
      chainMode: 'trinity',
      usedStubs: false,
      dreamerPassed: false,
      philosopherPassed: false,
      scribePassed: false,
      candidateCount: 0,
      selectedCandidateIndex: -1,
      stageFailures: [`Configuration: ${errorMsg}`],
    };
    console.error(`[Trinity] ERROR: ${errorMsg}`);
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  const adapter = config.runtimeAdapter;
  const telemetry: TrinityTelemetry = {
    chainMode: 'trinity',
    usedStubs: false,
    dreamerPassed: false,
    philosopherPassed: false,
    scribePassed: false,
    candidateCount: 0,
    selectedCandidateIndex: -1,
    stageFailures: [],
  };

  const failures: TrinityStageFailure[] = [];

  try {
    // Step 1: Dreamer — generate candidates via real subagent
    const dreamerOutput = await adapter.invokeDreamer(snapshot, principleId, config.maxCandidates);

    if (!dreamerOutput.valid || dreamerOutput.candidates.length === 0) {
      failures.push({
        stage: 'dreamer',
        reason: dreamerOutput.reason ?? 'No valid candidates generated',
      });
      telemetry.stageFailures.push(`Dreamer: ${dreamerOutput.reason ?? 'failed'}`);
      return { success: false, telemetry, failures, fallbackOccurred: false };
    }

    telemetry.dreamerPassed = true;
    telemetry.candidateCount = dreamerOutput.candidates.length;

    // Diversity validation (DIVER-04): soft check, never gates pipeline
    const diversityResult = validateCandidateDiversity(dreamerOutput.candidates);
    telemetry.diversityCheckPassed = diversityResult.diversityCheckPassed;
    telemetry.candidateRiskLevels = dreamerOutput.candidates
      .map(c => c.riskLevel)
      .filter((r): r is "low" | "medium" | "high" => typeof r === 'string');
    if (!diversityResult.diversityCheckPassed) {
      console.warn(`[Trinity] Diversity check failed: ${diversityResult.details}`);
    }

    // Step 2: Philosopher — rank candidates via real subagent
    const philosopherOutput = await adapter.invokePhilosopher(dreamerOutput, principleId, snapshot);

    if (!philosopherOutput.valid || philosopherOutput.judgments.length === 0) {
      failures.push({
        stage: 'philosopher',
        reason: philosopherOutput.reason ?? 'No judgments produced',
      });
      telemetry.stageFailures.push(`Philosopher: ${philosopherOutput.reason ?? 'failed'}`);
      return { success: false, telemetry, failures, fallbackOccurred: false };
    }

    telemetry.philosopherPassed = true;

    // Aggregate 6D scores from Philosopher judgments (if available)
    const realJudgments6D = philosopherOutput.judgments.filter(j => j.scores);
    if (realJudgments6D.length > 0) {
      const dims = ['principleAlignment', 'specificity', 'actionability', 'executability', 'safetyImpact', 'uxImpact'] as const;
      const avgScores: Record<string, number> = {};
      for (const dim of dims) {
        const values = realJudgments6D.map(j => j.scores?.[dim] ?? 0);
        avgScores[dim] = values.reduce((a, b) => a + b, 0) / values.length;
      }
      telemetry.philosopher6D = {
        avgScores: avgScores as NonNullable<TrinityTelemetry['philosopher6D']>['avgScores'],
        highRiskCount: philosopherOutput.judgments.filter(j => j.risks?.breakingChangeRisk).length,
      };
    }

    // Step 3: Scribe — synthesize final artifact via real subagent
    const draftArtifact = await adapter.invokeScribe(
      dreamerOutput,
      philosopherOutput,
      snapshot,
      principleId,
      telemetry,
      config
    );

    if (!draftArtifact) {
      failures.push({ stage: 'scribe', reason: 'Failed to synthesize artifact from candidates' });
      telemetry.stageFailures.push('Scribe: synthesis failed');
      return { success: false, telemetry, failures, fallbackOccurred: false };
    }

    telemetry.scribePassed = true;
    telemetry.selectedCandidateIndex = draftArtifact.selectedCandidateIndex;

    if (draftArtifact.telemetry) {
      telemetry.tournamentTrace = draftArtifact.telemetry.tournamentTrace;
      telemetry.winnerAggregateScore = draftArtifact.telemetry.winnerAggregateScore;
      telemetry.winnerThresholdPassed = draftArtifact.telemetry.winnerThresholdPassed;
      telemetry.eligibleCandidateCount = draftArtifact.telemetry.eligibleCandidateCount;
    }

    // Hallucination detection (SDK-QUAL-02): validate extraction against snapshot
    const hallucinationResult = validateExtraction(draftArtifact, snapshot);
    if (!hallucinationResult.isGrounded) {
      const reason = hallucinationResult.reason ?? 'Extraction not grounded in session evidence';
      console.warn(`[Trinity] HALLUCINATION_DETECTED: ${reason}`);
      telemetry.stageFailures.push(`Hallucination: ${reason}`);
      return {
        success: false,
        telemetry,
        failures: [{ stage: 'scribe', reason }],
        fallbackOccurred: false,
      };
    }

    return {
      success: true,
      artifact: draftArtifact,
      telemetry,
      failures: [],
      fallbackOccurred: false,
      artificerContext: draftArtifact.artificerContext,
    };
  } finally {
    if (adapter.close) {
      await adapter.close().catch(() => { /* intentionally empty - adapter cleanup error ignored */ });
    }
  }
}

/**
 * Internal: Run Trinity chain with stub implementations (synchronous).
    // eslint-disable-next-line complexity, @typescript-eslint/class-methods-use-this -- complexity 14, refactor candidate
 */
function runTrinityWithStubs(
  snapshot: NocturnalSessionSnapshot,
  principleId: string,
  config: TrinityConfig
): TrinityResult {
  const telemetry: TrinityTelemetry = {
    chainMode: 'trinity',
    usedStubs: true,
    dreamerPassed: false,
    philosopherPassed: false,
    scribePassed: false,
    candidateCount: 0,
    selectedCandidateIndex: -1,
    stageFailures: [],
  };

  const failures: TrinityStageFailure[] = [];

  // Step 1: Dreamer — generate candidates (stub)
  const dreamerOutput = invokeStubDreamer(snapshot, principleId, config.maxCandidates);

  if (!dreamerOutput.valid || dreamerOutput.candidates.length === 0) {
    failures.push({
      stage: 'dreamer',
      reason: dreamerOutput.reason ?? 'No valid candidates generated',
    });
    telemetry.stageFailures.push(`Dreamer: ${dreamerOutput.reason ?? 'failed'}`);
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  telemetry.dreamerPassed = true;
  telemetry.candidateCount = dreamerOutput.candidates.length;

  // Diversity validation (DIVER-04): soft check, never gates pipeline
  const diversityResult = validateCandidateDiversity(dreamerOutput.candidates);
  telemetry.diversityCheckPassed = diversityResult.diversityCheckPassed;
  telemetry.candidateRiskLevels = dreamerOutput.candidates
    .map(c => c.riskLevel)
    .filter((r): r is "low" | "medium" | "high" => typeof r === 'string');
  if (!diversityResult.diversityCheckPassed) {
    console.warn(`[Trinity] Diversity check failed: ${diversityResult.details}`);
  }

  // Step 2: Philosopher — rank candidates (stub)
  const philosopherOutput = invokeStubPhilosopher(dreamerOutput, principleId, snapshot);

  if (!philosopherOutput.valid || philosopherOutput.judgments.length === 0) {
    failures.push({
      stage: 'philosopher',
      reason: philosopherOutput.reason ?? 'No judgments produced',
    });
    telemetry.stageFailures.push(`Philosopher: ${philosopherOutput.reason ?? 'failed'}`);
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  telemetry.philosopherPassed = true;

  // Aggregate 6D scores from Philosopher judgments (if available)
  const judgments6D = philosopherOutput.judgments.filter(j => j.scores);
  if (judgments6D.length > 0) {
    const dims = ['principleAlignment', 'specificity', 'actionability', 'executability', 'safetyImpact', 'uxImpact'] as const;
    const avgScores: Record<string, number> = {};
    for (const dim of dims) {
      const values = judgments6D.map(j => j.scores?.[dim] ?? 0);
      avgScores[dim] = values.reduce((a, b) => a + b, 0) / values.length;
    }
    telemetry.philosopher6D = {
      avgScores: avgScores as NonNullable<TrinityTelemetry['philosopher6D']>['avgScores'],
      highRiskCount: philosopherOutput.judgments.filter(j => j.risks?.breakingChangeRisk).length,
    };
  }

  // Step 3: Scribe — produce final artifact using tournament selection (stub)
  const draftArtifact = invokeStubScribe(dreamerOutput, philosopherOutput, snapshot, principleId, telemetry, config);

  if (!draftArtifact) {
    failures.push({
      stage: 'scribe',
      reason: 'Failed to synthesize artifact from candidates',
    });
    telemetry.stageFailures.push('Scribe: synthesis failed');
    return {
      success: false,
      telemetry,
      failures,
      fallbackOccurred: false,
    };
  }

  telemetry.scribePassed = true;
  telemetry.selectedCandidateIndex = draftArtifact.selectedCandidateIndex;

  if (draftArtifact.telemetry) {
    telemetry.tournamentTrace = draftArtifact.telemetry.tournamentTrace;
    telemetry.winnerAggregateScore = draftArtifact.telemetry.winnerAggregateScore;
    telemetry.winnerThresholdPassed = draftArtifact.telemetry.winnerThresholdPassed;
    telemetry.eligibleCandidateCount = draftArtifact.telemetry.eligibleCandidateCount;
  }

  // Hallucination detection (SDK-QUAL-02): validate extraction against snapshot
  const hallucinationResult = validateExtraction(draftArtifact, snapshot);
  if (!hallucinationResult.isGrounded) {
    const reason = hallucinationResult.reason ?? 'Extraction not grounded in session evidence';
    console.warn(`[Trinity] HALLUCINATION_DETECTED: ${reason}`);
    telemetry.stageFailures.push(`Hallucination: ${reason}`);
    return {
      success: false,
      telemetry,
      failures: [{ stage: 'scribe', reason }],
      fallbackOccurred: false,
    };
  }

  return {
    success: true,
    artifact: draftArtifact,
    telemetry,
    failures: [],
    fallbackOccurred: false,
    artificerContext: draftArtifact.artificerContext,
  };
}

// ---------------------------------------------------------------------------
// Trinity Validation (for Arbiter integration)
// ---------------------------------------------------------------------------

/**
 * Validate that a Trinity draft artifact can pass final arbiter validation.
 * This checks the draft against the same rules as single-reflector artifacts.
 */
export interface DraftValidationResult {
  valid: boolean;
  failures: string[];
}

/**
 * Validate a TrinityDraftArtifact before passing to arbiter.
 */
export function validateDraftArtifact(draft: TrinityDraftArtifact): DraftValidationResult {
  const failures: string[] = [];

  if (!draft.badDecision || draft.badDecision.trim().length === 0) {
    failures.push('badDecision is required and non-empty');
  }

  if (!draft.betterDecision || draft.betterDecision.trim().length === 0) {
    failures.push('betterDecision is required and non-empty');
  }

  if (!draft.rationale || draft.rationale.trim().length < 20) {
    failures.push('rationale must be at least 20 characters');
  }

  if (!draft.principleId || draft.principleId.trim().length === 0) {
    failures.push('principleId is required');
  }

  if (!draft.sessionId || draft.sessionId.trim().length === 0) {
    failures.push('sessionId is required');
  }

  // badDecision should not be identical to betterDecision
  if (
    typeof draft.badDecision === 'string' &&
    typeof draft.betterDecision === 'string' &&
    draft.badDecision.trim().length > 0 &&
    draft.betterDecision.trim().length > 0 &&
    draft.badDecision.trim() === draft.betterDecision.trim()
  ) {
    failures.push('badDecision and betterDecision cannot be identical');
  }

  return {
    valid: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Hallucination Detection (SDK-QUAL-02)
// ---------------------------------------------------------------------------

/**
 * Result of hallucination validation against session snapshot evidence.
 */
export interface HallucinationDetectionResult {
  /** Whether the extraction is grounded in real session evidence */
  isGrounded: boolean;
  /** List of evidence types found in the snapshot supporting the extraction */
  evidenceTypes: string[];
  /** Detailed reason if hallucination is detected */
  reason?: string;
  /** Matching evidence items for telemetry (truncated for safety) */
  evidencePreview: string[];
}

/**
 * Validate that an extracted badDecision corresponds to actual events in the
 * NocturnalSessionSnapshot. This catches hallucinated extractions where the
 * Trinity chain produces a badDecision that has no grounding in real failures,
 * pain events, or gate blocks.
 *
 * Evidence sources checked:
 *  1. Failed tool calls (snapshot.toolCalls with outcome='failure')
 *  2. Pain events (snapshot.painEvents with score >= 50)
 *  3. Gate blocks (snapshot.gateBlocks)
 *  4. User corrections (snapshot.userTurns with correctionDetected=true)
 *
 * The function uses keyword overlap heuristics: it extracts tool names, file
 * paths, error messages, and pain reasons from the snapshot and checks if the
 * badDecision text overlaps meaningfully with any of them.
 *
 * @param artifact The draft artifact produced by the Scribe stage
 * @param snapshot The session snapshot used to generate the extraction
 * @returns HallucinationDetectionResult indicating whether the extraction is grounded
 */
export function validateExtraction(
  artifact: TrinityDraftArtifact,
  snapshot: NocturnalSessionSnapshot
): HallucinationDetectionResult {
  const evidenceTypes: string[] = [];
  const evidencePreview: string[] = [];

  // Shared token normalizer: lowercase + strip punctuation, same as badDecisionTokens
  const normalizeEvidenceToken = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Build a set of evidence tokens from the snapshot
  const evidenceTokens = new Set<string>();
  const badDecisionLower = artifact.badDecision.toLowerCase();

  // 1. Failed tool calls
  const failedToolCalls = (snapshot.toolCalls ?? []).filter(tc => tc.outcome === 'failure');
  if (failedToolCalls.length > 0) {
    evidenceTypes.push('tool_failures');
    for (const tc of failedToolCalls) {
      // Extract tool name tokens
      evidenceTokens.add(tc.toolName.toLowerCase());
      if (tc.filePath) {
        // Extract all path segments and normalize each for matching
        const rawPathParts = [tc.filePath, ...tc.filePath.split(/[\\/]/)];
        for (const part of rawPathParts) {
          const normalized = normalizeEvidenceToken(part);
          if (normalized.length > 0) evidenceTokens.add(normalized);
        }
      }
      if (tc.errorMessage) {
        // Extract key words from error messages (filter stop words)
        const errorWords = tc.errorMessage.toLowerCase().split(/\s+/)
          .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'which', 'been', 'have', 'were', 'they', 'their'].includes(w));
        for (const w of errorWords) {
          const normalized = normalizeEvidenceToken(w);
          if (normalized.length > 0) evidenceTokens.add(normalized);
        }
      }
      if (tc.errorType) evidenceTokens.add(tc.errorType.toLowerCase());
      evidencePreview.push(`tool:${tc.toolName}${tc.filePath ? `@${tc.filePath}` : ''} -> ${tc.errorMessage ?? 'unknown'}`.slice(0, 100));
    }
  }

  // 2. Pain events (score >= 50 indicates meaningful pain)
  const significantPainEvents = (snapshot.painEvents ?? []).filter(pe => pe.score >= 50);
  if (significantPainEvents.length > 0) {
    evidenceTypes.push('pain_events');
    for (const pe of significantPainEvents) {
      evidenceTokens.add(pe.source.toLowerCase());
      if (pe.reason) {
        const painWords = pe.reason.toLowerCase().split(/\s+/)
          .filter(w => w.length > 3 && !['with', 'from', 'that', 'this', 'which', 'been', 'have', 'were', 'they', 'their'].includes(w));
        for (const w of painWords) {
          const normalized = normalizeEvidenceToken(w);
          if (normalized.length > 0) evidenceTokens.add(normalized);
        }
      }
      evidencePreview.push(`pain:${pe.score} [${pe.source}] ${pe.reason ?? ''}`.slice(0, 100));
    }
  }

  // 3. Gate blocks
  if ((snapshot.gateBlocks ?? []).length > 0) {
    evidenceTypes.push('gate_blocks');
    for (const gb of snapshot.gateBlocks) {
      evidenceTokens.add(gb.toolName.toLowerCase());
      evidenceTokens.add('gate');
      evidenceTokens.add('blocked');
      if (gb.reason) {
        const blockWords = gb.reason.toLowerCase().split(/\s+/)
          .filter(w => w.length > 3);
        for (const w of blockWords) {
          const normalized = normalizeEvidenceToken(w);
          if (normalized.length > 0) evidenceTokens.add(normalized);
        }
      }
      evidencePreview.push(`gate:${gb.toolName} -> ${gb.reason}`.slice(0, 100));
    }
  }

  // 4. User corrections
  const userCorrections = (snapshot.userTurns ?? []).filter(ut => ut.correctionDetected);
  if (userCorrections.length > 0) {
    evidenceTypes.push('user_corrections');
    evidenceTokens.add('correction');
    evidenceTokens.add('wrong');
    evidenceTokens.add('incorrect');
    evidencePreview.push(`corrections:${userCorrections.length}`);
  }

  // If no evidence exists at all in the snapshot, we cannot validate.
  // Allow the extraction through — the pipeline already has guardrails for
  // empty snapshots (Dreamer returns valid:false).
  if (evidenceTypes.length === 0) {
    return {
      isGrounded: true,
      evidenceTypes: [],
      reason: undefined,
      evidencePreview: [],
    };
  }

  // Check for overlap between badDecision text and evidence tokens
  // We look for meaningful keyword matches (tokens of length > 4)
  const badDecisionTokens = badDecisionLower.split(/\s+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length > 4);

  let matchCount = 0;
  const matchedTokens: string[] = [];
  for (const token of badDecisionTokens) {
    // Direct match
    if (evidenceTokens.has(token)) {
      matchCount++;
      matchedTokens.push(token);
      continue;
    }
    // Partial match: check if any evidence token contains this token or vice versa
    for (const evToken of evidenceTokens) {
      if (evToken.length > 4 && (evToken.includes(token) || token.includes(evToken))) {
        matchCount++;
        matchedTokens.push(token);
        break;
      }
    }
  }

  // Heuristic: if at least 2 meaningful tokens overlap, consider grounded
  // Single overlap is acceptable if the token is highly specific (length > 8)
  const minOverlap = badDecisionTokens.length > 0
    ? Math.max(1, Math.ceil(badDecisionTokens.length * 0.15))
    : 0;

  if (matchCount >= Math.max(2, minOverlap)) {
    return {
      isGrounded: true,
      evidenceTypes,
      evidencePreview: evidencePreview.slice(0, 5),
    };
  }

  // Also check for at least one highly-specific match (length > 8)
  const hasHighlySpecificMatch = matchedTokens.some(t => t.length > 8);
  if (hasHighlySpecificMatch) {
    return {
      isGrounded: true,
      evidenceTypes,
      evidencePreview: evidencePreview.slice(0, 5),
    };
  }

  // Hallucination detected — badDecision has no grounding in snapshot evidence
  const reason = `Hallucinated extraction: badDecision "${artifact.badDecision.slice(0, 80)}" has insufficient overlap with session evidence. ` +
    `Evidence types available: [${evidenceTypes.join(', ')}]. Matched tokens: [${matchedTokens.join(', ')}] (needed >= ${Math.max(2, minOverlap)}).`;

  return {
    isGrounded: false,
    evidenceTypes,
    reason,
    evidencePreview: evidencePreview.slice(0, 5),
  };
}

/**
 * Convert a TrinityDraftArtifact to a NocturnalArtifact-compatible structure.
 */
export function draftToArtifact(draft: TrinityDraftArtifact): {
  artifactId: string;
  sessionId: string;
  principleId: string;
  sourceSnapshotRef: string;
  badDecision: string;
  betterDecision: string;
  rationale: string;
  createdAt: string;
  thinkingModelDelta?: number;
  planningRatioGain?: number;
} {
  // Compute reflection quality metrics
  const thinkingModelDelta = draft.thinkingModelDelta ?? computeThinkingModelDelta(draft.badDecision, draft.betterDecision);
  // planningRatioGain requires an improved snapshot — Trinity draft doesn't have one, so default to 0
  const planningRatioGain = draft.planningRatioGain ?? 0;

  return {
    artifactId: randomUUID(),
    sessionId: draft.sessionId,
    principleId: draft.principleId,
    sourceSnapshotRef: draft.sourceSnapshotRef,
    badDecision: draft.badDecision,
    betterDecision: draft.betterDecision,
    rationale: draft.rationale,
    createdAt: new Date().toISOString(),
    thinkingModelDelta,
    planningRatioGain,
  };
}

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_TRINITY_CONFIG: TrinityConfig = {
  useTrinity: true,
  maxCandidates: 3,
  useStubs: false,  // Real subagent execution is the default; set useStubs=true for stub-only mode
};
