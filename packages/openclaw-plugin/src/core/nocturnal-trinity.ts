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
 *  - Adapter uses ONLY public plugin runtime APIs (api.runtime.subagent.*)
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { NocturnalSessionSnapshot } from './nocturnal-trajectory-extractor.js';
import { computeThinkingModelDelta } from './nocturnal-trajectory-extractor.js';
import type { TrinityArtificerContext } from './nocturnal-artificer.js';
import {
  runTournament,
  DEFAULT_SCORING_WEIGHTS,
  type ScoringWeights,
  type TournamentTraceEntry,
} from './nocturnal-candidate-scoring.js';
import {
  DEFAULT_THRESHOLDS,
  getEffectiveThresholds,
  type ThresholdValues,
} from './adaptive-thresholds.js';

// ---------------------------------------------------------------------------
// Embedded Role Prompts
// ---------------------------------------------------------------------------
// These prompts are embedded at build time. The agents/ directory was removed
// to eliminate fragile runtime file dependencies on the file system.

const NOCTURNAL_DREAMER_PROMPT = `# Nocturnal Dreamer — Candidate Generation

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
      "confidence": 0.95
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

### Candidates should DIFFER from each other:
- Different candidates should represent genuinely different approaches
- Do not generate candidates with identical betterDecisions
- Vary the confidence scores to reflect genuine uncertainty

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

const NOCTURNAL_PHILOSOPHER_PROMPT = `# Nocturnal Philosopher — Candidate Evaluation and Ranking

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
      "rank": 1
    }
  ],
  "overallAssessment": "<summary of candidate set quality>",
  "generatedAt": "<ISO timestamp>"
}

## Evaluation Criteria

### Score Components (0-1 scale each):
1. **Principle Alignment** (weight: 0.4) — Does the betterDecision properly reflect the target principle?
2. **Specificity** (weight: 0.3) — Is badDecision specific? Is betterDecision actionable?
3. **Actionability** (weight: 0.3) — Does betterDecision describe a specific next step?

### Ranking Rules:
- Candidates are ranked by score (highest = rank 1)
- Ties broken by: higher principle alignment, then lower candidateIndex

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
- **Philosopher's judgments** — ranked candidates with critiques
- **Dreamer's candidates** — the original candidate list

## Task

Select the best candidate (Philosopher's rank 1) and synthesize it into
a final TrinityDraftArtifact.

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
  }
}

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

// ---------------------------------------------------------------------------
// Trinity Runtime Adapter
// ---------------------------------------------------------------------------

/**
 * Interface for Trinity stage invocation.
 * Implementations can use real subagent runtimes or stubs.
 */
 
export interface TrinityRuntimeAdapter {
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
   * @returns Philosopher output JSON
   */
  invokePhilosopher(
    _dreamerOutput: DreamerOutput,
    _principleId: string
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
          timeoutMs: number;
          runId: string;
          disableTools?: boolean;
        }) => Promise<{
          payloads?: { isError?: boolean; text?: string }[];
        }>;
      };
    };
    config?: unknown;
    logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  };
   

  private readonly stageTimeoutMs: number;
  private readonly tempDir: string;

  constructor(
    api: OpenClawTrinityRuntimeAdapter['api'],
    stageTimeoutMs = 300_000  // 5 min — increased from 3 min to accommodate slower LLM responses
  ) {
    this.api = api;
    this.stageTimeoutMs = stageTimeoutMs;
    // Cross-platform temp directory for session files
    this.tempDir = path.join(os.tmpdir(), `pd-trinity-${process.pid}`);
  }

  /**
   * Create a valid JSONL session file for runEmbeddedPiAgent.
   * The file must contain an initial model_change event to set provider/model,
   * otherwise OpenClaw defaults to 'openai' provider which may not be configured.
   */
  private createSessionFile(stage: string): string {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    const sessionFile = path.join(this.tempDir, `${stage}-${randomUUID()}.jsonl`);
    
    // Extract model config from api.config (agents.defaults.model)
    const config = this.api.config as Record<string, unknown> | undefined;
    const agents = config?.agents as Record<string, unknown> | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const modelConfig = defaults?.model;
    
    // Parse model string (format: "provider/model" or {primary: "...", fallbacks: [...]})
    let provider = 'minimax-portal';  // sensible default
    let modelId = 'MiniMax-M2.7';
    
    if (typeof modelConfig === 'string' && modelConfig.includes('/')) {
      const parts = modelConfig.split('/');
      provider = parts[0];
      modelId = parts.slice(1).join('/');
    } else if (modelConfig && typeof modelConfig === 'object') {
      const mc = modelConfig as Record<string, unknown>;
      const primary = mc.primary as string | undefined;
      if (primary && primary.includes('/')) {
        const parts = primary.split('/');
        provider = parts[0];
        modelId = parts.slice(1).join('/');
      }
    }
    
    // Write initial model_change event to JSONL
    const modelChangeEvent = {
      type: 'model_change',
      id: randomUUID().slice(0, 8),
      parentId: null,
      timestamp: new Date().toISOString(),
      provider,
      modelId
    };
    
    fs.writeFileSync(sessionFile, JSON.stringify(modelChangeEvent) + '\n');
    
    this.api.logger?.info(`[Trinity] Created session file for ${stage}: provider=${provider}, model=${modelId}`);
    
    return sessionFile;
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

  async invokeDreamer(
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
    maxCandidates: number
  ): Promise<DreamerOutput> {
    const runId = `dreamer-${randomUUID()}`;
    const sessionFile = this.createSessionFile('dreamer');
    const prompt = this.buildDreamerPrompt(snapshot, principleId, maxCandidates);

    try {
      const result = await this.api.runtime.agent.runEmbeddedPiAgent({
        sessionId: runId,
        sessionFile,
        prompt,
        extraSystemPrompt: NOCTURNAL_DREAMER_PROMPT,
        config: this.api.config,
        timeoutMs: this.stageTimeoutMs,
        runId,
        disableTools: true,  // Trinity stages are pure LLM reasoning, no tools needed
      });

      const outputText = this.extractPayloadText(result);
      if (!outputText) {
        return {
          valid: false,
          candidates: [],
          reason: 'Dreamer returned empty response',
          generatedAt: new Date().toISOString(),
        };
      }

      return this.parseDreamerOutput(outputText);
    } catch (err) {
      return {
        valid: false,
        candidates: [],
        reason: `Dreamer failed: ${err instanceof Error ? err.message : String(err)}`,
        generatedAt: new Date().toISOString(),
      };
    } finally {
      // Clean up session file
      try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
    }
  }

  async invokePhilosopher(
    dreamerOutput: DreamerOutput,
    principleId: string
  ): Promise<PhilosopherOutput> {
    const runId = `philosopher-${randomUUID()}`;
    const sessionFile = this.createSessionFile('philosopher');
    const prompt = this.buildPhilosopherPrompt(dreamerOutput, principleId);

    try {
      const result = await this.api.runtime.agent.runEmbeddedPiAgent({
        sessionId: runId,
        sessionFile,
        prompt,
        extraSystemPrompt: NOCTURNAL_PHILOSOPHER_PROMPT,
        config: this.api.config,
        timeoutMs: this.stageTimeoutMs,
        runId,
        disableTools: true,
      });

      const outputText = this.extractPayloadText(result);
      if (!outputText) {
        return {
          valid: false,
          judgments: [],
          overallAssessment: '',
          reason: 'Philosopher returned empty response',
          generatedAt: new Date().toISOString(),
        };
      }

      return this.parsePhilosopherOutput(outputText);
    } catch (err) {
      return {
        valid: false,
        judgments: [],
        overallAssessment: '',
        reason: `Philosopher failed: ${err instanceof Error ? err.message : String(err)}`,
        generatedAt: new Date().toISOString(),
      };
    } finally {
      try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
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
    const runId = `scribe-${randomUUID()}`;
    const sessionFile = this.createSessionFile('scribe');
    const prompt = this.buildScribePrompt(dreamerOutput, philosopherOutput, snapshot, principleId);

    try {
      const result = await this.api.runtime.agent.runEmbeddedPiAgent({
        sessionId: runId,
        sessionFile,
        prompt,
        extraSystemPrompt: NOCTURNAL_SCRIBE_PROMPT,
        config: this.api.config,
        timeoutMs: this.stageTimeoutMs,
        runId,
        disableTools: true,
      });

      const outputText = this.extractPayloadText(result);
      if (!outputText) {
        return null;
      }

      return this.parseScribeOutput(outputText, snapshot, principleId, telemetry);
    } catch (err) {
      return null;
    } finally {
      try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
    }
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
    } catch { /* ignore cleanup errors */ }
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

   
  private buildDreamerPrompt(
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
    maxCandidates: number
  ): string {
    return `Target Principle: ${principleId}

Session Snapshot:
- Session ID: ${snapshot.sessionId}
- Assistant Turns: ${snapshot.stats.totalAssistantTurns ?? 'N/A (data unavailable)'}
- Tool Calls: ${snapshot.stats.totalToolCalls ?? 'N/A (data unavailable)'}
- Failures: ${snapshot.stats.failureCount ?? 'N/A (data unavailable)'}
- Pain Events: ${snapshot.stats.totalPainEvents}
- Gate Blocks: ${snapshot.stats.totalGateBlocks ?? 'N/A (data unavailable)'}

Please analyze this session and generate ${maxCandidates} candidate corrections. Each candidate should identify a bad decision and propose a better alternative grounded in the target principle.

Respond with ONLY a valid JSON object matching the DreamerOutput contract.`;
  }

   
  private buildPhilosopherPrompt(
    dreamerOutput: DreamerOutput,
    principleId: string
  ): string {
    const candidatesJson = JSON.stringify(dreamerOutput.candidates, null, 2);
    return `Target Principle: ${principleId}

Dreamer's Candidates:
${candidatesJson}

Please evaluate each candidate and rank them by principle alignment, specificity, and actionability. Respond with ONLY a valid JSON object matching the PhilosopherOutput contract.`;
  }

   
  private buildScribePrompt(
    dreamerOutput: DreamerOutput,
    philosopherOutput: PhilosopherOutput,
    snapshot: NocturnalSessionSnapshot,
    principleId: string
  ): string {
    const candidatesJson = JSON.stringify(dreamerOutput.candidates, null, 2);
    const judgmentsJson = JSON.stringify(philosopherOutput.judgments, null, 2);
    return `Target Principle: ${principleId}
Session ID: ${snapshot.sessionId}

Dreamer's Candidates:
${candidatesJson}

Philosopher's Judgments:
${judgmentsJson}

Select the best candidate (Philosopher's rank 1) and synthesize it into a final TrinityDraftArtifact. Respond with ONLY a valid JSON object.`;
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
        judgments: parsed.judgments,
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

   
  private parseScribeOutput(
    text: string,
    snapshot: NocturnalSessionSnapshot,
    principleId: string,
     
    _telemetry: TrinityTelemetry
  ): TrinityDraftArtifact | null {
    const json = this.extractJson(text);
    if (!json) {
      return null;
    }

    try {
      const parsed = JSON.parse(json);
      if (typeof parsed.selectedCandidateIndex !== 'number') {
        return null;
      }

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
          usedStubs: false,
          dreamerPassed: true,
          philosopherPassed: true,
          scribePassed: true,
          candidateCount: parsed.candidateCount ?? 0,
          selectedCandidateIndex: parsed.selectedCandidateIndex,
          stageFailures: [],
        },
      };
    } catch {
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

/**
 * Dreamer output — multiple candidate corrections.
 * Each candidate represents an alternative "better decision" approach.
 */
export interface DreamerCandidate {
  /** Unique index for this candidate within the Dreamer output */
  candidateIndex: number;
  /** The bad decision this candidate addresses */
  badDecision: string;
  /** The alternative/better decision */
  betterDecision: string;
  /** Why this alternative is better (brief) */
  rationale: string;
  /** Confidence that this candidate is valid (0-1) */
  confidence: number;
}

export interface DreamerOutput {
  /** Whether Dreamer succeeded */
  valid: boolean;
  /** List of candidate corrections */
  candidates: DreamerCandidate[];
  /** Why Dreamer could not generate (if valid === false) */
  reason?: string;
  /** Timestamp of generation */
  generatedAt: string;
}

/**
 * Philosopher output — principle-grounded critique and ranking.
 * Philosopher evaluates Dreamer's candidates and ranks them.
 */
export interface PhilosopherJudgment {
  /** Index of the judged candidate (references DreamerCandidate.candidateIndex) */
  candidateIndex: number;
  /** Principle-grounded critique of this candidate */
  critique: string;
  /** Whether this candidate aligns with the target principle */
  principleAligned: boolean;
  /** Ranking score (higher = better, 0-1) */
  score: number;
  /** Rank among all candidates (1 = best) */
  rank: number;
}

export interface PhilosopherOutput {
  /** Whether Philosopher succeeded */
  valid: boolean;
  /** Judgments for each candidate */
  judgments: PhilosopherJudgment[];
  /** Overall assessment of the candidate set */
  overallAssessment: string;
  /** Why Philosopher could not judge (if valid === false) */
  reason?: string;
  /** Timestamp of generation */
  generatedAt: string;
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
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Retried the same operation immediately after gate block without understanding why',
        betterDecision: 'Check the gatekeeper source first to diagnose the block reason; this is irreversible, so we must be certain before proceeding',
        rationale: 'Understanding why a gate blocked prevents repeated blocks',
        confidence: 0.85,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Modified the target of the blocked operation to bypass the check',
        betterDecision: 'Review docs/auth.md first to understand the authorization structure, then request proper review before any change',
        rationale: 'Proper authorization ensures accountability and prevents unintended changes',
        confidence: 0.75,
      });
    }
  } else if (hasPain) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Continued executing operations without pausing to address accumulated pain signals',
      betterDecision: 'Check logs/pain.json first to analyze pain signals; this error indicates we should stop and reconsider before proceeding',
      rationale: 'Pain signals indicate accumulated friction or error conditions',
      confidence: 0.90,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Ignored warning pain events and proceeded with high-risk operations',
        betterDecision: 'Review src/pain-detector.ts first; based on the evidence, this indicates a deeper issue we must not ignore',
        rationale: 'Addressing friction reduces error rates and improves outcomes',
        confidence: 0.80,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Retried failing operations without analyzing why they caused pain',
        betterDecision: 'Analyze logs/errors.json first to identify the failure pattern; this suggests we should stop and rethink before retrying',
        rationale: 'Pattern analysis prevents recurring pain from the same source',
        confidence: 0.70,
      });
    }
  } else if (hasFailures) {
    candidates.push({
      candidateIndex: 0,
      badDecision: 'Retried a failing operation without diagnosing the root cause',
      betterDecision: 'Verify config.json preconditions first, based on the error in logs/failure.json, before retrying',
      rationale: 'Diagnosing failures before retry prevents repeated failures',
      confidence: 0.92,
    });
    if (maxCandidates >= 2) {
      candidates.push({
        candidateIndex: 1,
        badDecision: 'Continued to the next operation after a failure without addressing it',
        betterDecision: 'Check docs/debugging.md first to diagnose what failed; we must not ignore this when the action is irreversible',
        rationale: 'Unaddressed failures compound and cause larger issues',
        confidence: 0.85,
      });
    }
    if (maxCandidates >= 3) {
      candidates.push({
        candidateIndex: 2,
        badDecision: 'Assumed the failure was transient and retried without investigation',
        betterDecision: 'Verify src/validator.ts state first; this error indicates a deeper problem before assuming resolution',
        rationale: 'Verification prevents cascading failures from unresolved issues',
        confidence: 0.78,
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

  // #219: Add fallback warning to rationales if data source is fallback
  const annotatedCandidates = isFallback
    ? limitedCandidates.map((c) => ({
        ...c,
        rationale: c.rationale + fallbackWarning,
      }))
    : limitedCandidates;

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
   
  _principleId: string
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

    // Step 2: Philosopher — rank candidates via real subagent
    const philosopherOutput = await adapter.invokePhilosopher(dreamerOutput, principleId);

    if (!philosopherOutput.valid || philosopherOutput.judgments.length === 0) {
      failures.push({
        stage: 'philosopher',
        reason: philosopherOutput.reason ?? 'No judgments produced',
      });
      telemetry.stageFailures.push(`Philosopher: ${philosopherOutput.reason ?? 'failed'}`);
      return { success: false, telemetry, failures, fallbackOccurred: false };
    }

    telemetry.philosopherPassed = true;

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

  // Step 2: Philosopher — rank candidates (stub)
  const philosopherOutput = invokeStubPhilosopher(dreamerOutput, principleId);

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
