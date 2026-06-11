/**
 * Spike runner — executes baseline vs grounded prompt comparison across LLM models.
 *
 * THROWAWAY script for PRI-366 (T-B) P-spike.
 * NOT production code. Does not need to follow project coding conventions.
 *
 * Usage:
 *   npx tsx docs/plans/2026-06-diagnostician-split/spike-run.ts
 *
 * Prerequisites:
 *   - LM Studio running at http://localhost:1234
 *   - qwen3:8b model loaded
 *   - glm-5.1 model loaded (or change MODEL_CONFIGS below)
 *
 * Output:
 *   - spike-results/baseline-qwen3.jsonl
 *   - spike-results/grounded-qwen3.jsonl
 *   - spike-results/baseline-glm5.1.jsonl
 *   - spike-results/grounded-glm5.1.jsonl
 *   - spike-results/summary.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildBaselinePrompt, buildGroundedPrompt, findFabricatedAxiomRefs, isValidAxiomRef, extractAxiomRefs } from './spike-distiller-prompt.js';
import { SPIKE_FIXTURES } from './spike-fixtures.js';
import type { DiagnosticianContextPayload } from '../../packages/principles-core/src/runtime-v2/context-payload.js';

// ── Configuration ────────────────────────────────────────────────────────

const LM_STUDIO_URL = 'http://localhost:1234/v1/chat/completions';

interface ModelConfig {
  name: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const MODEL_CONFIGS: ModelConfig[] = [
  { name: 'qwen3', model: 'qwen3:8b', temperature: 0.3, maxTokens: 4096 },
  { name: 'glm5.1', model: 'glm-5.1', temperature: 0.3, maxTokens: 4096 },
];

const RESULTS_DIR = path.join(__dirname, 'spike-results');
const TIMEOUT_MS = 120_000; // 2 minutes per request

// ── Types ────────────────────────────────────────────────────────────────

interface SpikeResult {
  fixtureName: string;
  fixtureIndex: number;
  model: string;
  promptVariant: 'baseline' | 'grounded';
  rawOutput: string;
  parsedOutput: Record<string, unknown> | null;
  parseError: string | null;
  latencyMs: number;
  recommendationKinds: string[];
  axiomRefs: string[];
  fabricatedAxiomRefs: string[];
  hasGroundedOn: boolean;
  error: string | null;
}

// ── LLM API call ─────────────────────────────────────────────────────────

async function callLlm(
  promptInput: { diagnosticInstruction: string; context: DiagnosticianContextPayload },
  modelConfig: ModelConfig,
): Promise<{ rawOutput: string; latencyMs: number }> {
  const systemPrompt = promptInput.diagnosticInstruction;
  const userMessage = JSON.stringify({
    taskId: promptInput.context.taskId,
    diagnosisTarget: promptInput.context.diagnosisTarget,
    conversationWindow: promptInput.context.conversationWindow,
    sourceRefs: promptInput.context.sourceRefs,
  });

  const body = {
    model: modelConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: modelConfig.temperature,
    max_tokens: modelConfig.maxTokens,
    stream: false,
  };

  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(LM_STUDIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content: string } }>;
    const content = choices?.[0]?.message?.content ?? '';

    return {
      rawOutput: content,
      latencyMs: Date.now() - startTime,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Output parsing ───────────────────────────────────────────────────────

function parseOutput(rawOutput: string): { parsed: Record<string, unknown> | null; error: string | null } {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(rawOutput.trim());
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { parsed, error: null };
    }
  } catch {
    // Fall through
  }

  // Try extracting JSON from markdown code fences
  const fencedMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(rawOutput);
  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim());
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return { parsed, error: null };
      }
    } catch {
      // Fall through
    }
  }

  // Try balanced-bracket extraction
  let depth = 0;
  let start = -1;
  for (let i = 0; i < rawOutput.length; i++) {
    if (rawOutput[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (rawOutput[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(rawOutput.slice(start, i + 1));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return { parsed, error: null };
          }
        } catch {
          // Continue searching
        }
        start = -1;
      }
    }
  }

  return { parsed: null, error: 'Failed to parse LLM output as JSON' };
}

// ── Analysis ─────────────────────────────────────────────────────────────

function analyzeResult(parsed: Record<string, unknown> | null): {
  recommendationKinds: string[];
  axiomRefs: string[];
  fabricatedAxiomRefs: string[];
  hasGroundedOn: boolean;
} {
  if (!parsed) {
    return { recommendationKinds: [], axiomRefs: [], fabricatedAxiomRefs: [], hasGroundedOn: false };
  }

  // Extract recommendation kinds
  const recs = parsed.recommendations;
  const recommendationKinds: string[] = [];
  if (Array.isArray(recs)) {
    for (const rec of recs) {
      if (typeof rec === 'object' && rec !== null && typeof rec.kind === 'string') {
        recommendationKinds.push(rec.kind);
      }
    }
  }

  // Extract axiom references from ambiguityNotes
  const notes = parsed.ambiguityNotes;
  const axiomRefs = extractAxiomRefs(Array.isArray(notes) ? notes as string[] : undefined);

  // Check for fabricated axiom IDs
  const fabricatedAxiomRefs = findFabricatedAxiomRefs(parsed);

  // Check for groundedOn pattern
  let hasGroundedOn = false;
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (typeof note === 'string' && note.includes('groundedOn:')) {
        hasGroundedOn = true;
        break;
      }
    }
  }

  return { recommendationKinds, axiomRefs, fabricatedAxiomRefs, hasGroundedOn };
}

// ── Main execution ───────────────────────────────────────────────────────

async function runSpike(): Promise<void> {
  // Ensure results directory exists
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  // Serialize fixtures to JSON files
  const fixturesDir = path.join(__dirname, 'spike-fixtures');
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }
  for (const fixture of SPIKE_FIXTURES) {
    const filePath = path.join(fixturesDir, `${fixture.name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2));
  }
  console.log(`Serialized ${SPIKE_FIXTURES.length} fixtures to ${fixturesDir}`);

  const allResults: SpikeResult[] = [];
  let totalRuns = SPIKE_FIXTURES.length * MODEL_CONFIGS.length * 2; // *2 for baseline+grounded
  let completedRuns = 0;

  for (const modelConfig of MODEL_CONFIGS) {
    for (const variant of ['baseline', 'grounded'] as const) {
      const resultsPath = path.join(RESULTS_DIR, `${variant}-${modelConfig.name}.jsonl`);
      // Clear previous results
      fs.writeFileSync(resultsPath, '');

      for (let i = 0; i < SPIKE_FIXTURES.length; i++) {
        const fixture = SPIKE_FIXTURES[i];
        completedRuns++;
        console.log(`[${completedRuns}/${totalRuns}] ${variant}/${modelConfig.name}/${fixture.name}`);

        const promptInput = variant === 'baseline'
          ? buildBaselinePrompt(fixture.payload)
          : buildGroundedPrompt(fixture.payload);

        let rawOutput = '';
        let latencyMs = 0;
        let error: string | null = null;

        try {
          const result = await callLlm(promptInput, modelConfig);
          rawOutput = result.rawOutput;
          latencyMs = result.latencyMs;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          console.error(`  ERROR: ${error}`);
        }

        const { parsed: parsedOutput, error: parseError } = parseOutput(rawOutput);
        const analysis = analyzeResult(parsedOutput);

        const spikeResult: SpikeResult = {
          fixtureName: fixture.name,
          fixtureIndex: i,
          model: modelConfig.name,
          promptVariant: variant,
          rawOutput,
          parsedOutput,
          parseError,
          latencyMs,
          recommendationKinds: analysis.recommendationKinds,
          axiomRefs: analysis.axiomRefs,
          fabricatedAxiomRefs: analysis.fabricatedAxiomRefs,
          hasGroundedOn: analysis.hasGroundedOn,
          error,
        };

        allResults.push(spikeResult);

        // Append to JSONL file
        fs.appendFileSync(resultsPath, JSON.stringify(spikeResult) + '\n');

        // EP-01: Alert on fabricated axiom refs
        if (analysis.fabricatedAxiomRefs.length > 0) {
          console.warn(`  ⚠ FABRICATED AXIOM REFS: ${analysis.fabricatedAxiomRefs.join(', ')}`);
        }

        // Brief pause between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  // ── Generate summary ─────────────────────────────────────────────────

  const summary = generateSummary(allResults);
  const summaryPath = path.join(RESULTS_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nSummary written to ${summaryPath}`);

  // Print summary to console
  console.log('\n=== SPIKE SUMMARY ===');
  console.log(`Total runs: ${allResults.length}`);
  console.log(`Parse failures: ${allResults.filter(r => r.parseError !== null).length}`);
  console.log(`Request errors: ${allResults.filter(r => r.error !== null).length}`);
  console.log(`Fabricated axiom refs: ${allResults.filter(r => r.fabricatedAxiomRefs.length > 0).length} runs`);

  for (const modelConfig of MODEL_CONFIGS) {
    for (const variant of ['baseline', 'grounded'] as const) {
      const variantResults = allResults.filter(r => r.model === modelConfig.name && r.promptVariant === variant);
      const principleCount = variantResults.filter(r => r.recommendationKinds.includes('principle')).length;
      const ruleCount = variantResults.filter(r => r.recommendationKinds.includes('rule')).length;
      const groundedOnCount = variantResults.filter(r => r.hasGroundedOn).length;
      console.log(`\n${variant}/${modelConfig.name}:`);
      console.log(`  principle kind: ${principleCount}/${variantResults.length}`);
      console.log(`  rule kind: ${ruleCount}/${variantResults.length}`);
      console.log(`  has groundedOn: ${groundedOnCount}/${variantResults.length}`);
    }
  }
}

function generateSummary(results: SpikeResult[]): Record<string, unknown> {
  const byModelAndVariant: Record<string, {
    total: number;
    parseFailures: number;
    requestErrors: number;
    principleCount: number;
    ruleCount: number;
    implementationCount: number;
    promptCount: number;
    deferCount: number;
    groundedOnCount: number;
    fabricatedCount: number;
    avgLatencyMs: number;
    axiomRefDistribution: Record<string, number>;
  }> = {};

  for (const result of results) {
    const key = `${result.promptVariant}/${result.model}`;
    if (!byModelAndVariant[key]) {
      byModelAndVariant[key] = {
        total: 0,
        parseFailures: 0,
        requestErrors: 0,
        principleCount: 0,
        ruleCount: 0,
        implementationCount: 0,
        promptCount: 0,
        deferCount: 0,
        groundedOnCount: 0,
        fabricatedCount: 0,
        avgLatencyMs: 0,
        axiomRefDistribution: {},
      };
    }

    const stats = byModelAndVariant[key];
    stats.total++;
    if (result.parseError) stats.parseFailures++;
    if (result.error) stats.requestErrors++;
    if (result.recommendationKinds.includes('principle')) stats.principleCount++;
    if (result.recommendationKinds.includes('rule')) stats.ruleCount++;
    if (result.recommendationKinds.includes('implementation')) stats.implementationCount++;
    if (result.recommendationKinds.includes('prompt')) stats.promptCount++;
    if (result.recommendationKinds.includes('defer')) stats.deferCount++;
    if (result.hasGroundedOn) stats.groundedOnCount++;
    if (result.fabricatedAxiomRefs.length > 0) stats.fabricatedCount++;
    stats.avgLatencyMs += result.latencyMs;

    for (const ref of result.axiomRefs) {
      stats.axiomRefDistribution[ref] = (stats.axiomRefDistribution[ref] ?? 0) + 1;
    }
  }

  // Calculate averages
  for (const stats of Object.values(byModelAndVariant)) {
    if (stats.total > 0) {
      stats.avgLatencyMs = Math.round(stats.avgLatencyMs / stats.total);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    fixturesCount: SPIKE_FIXTURES.length,
    models: MODEL_CONFIGS.map(m => m.name),
    byModelAndVariant,
    detailedResults: results.map(r => ({
      fixtureName: r.fixtureName,
      model: r.model,
      promptVariant: r.promptVariant,
      parseError: r.parseError,
      requestError: r.error,
      recommendationKinds: r.recommendationKinds,
      axiomRefs: r.axiomRefs,
      fabricatedAxiomRefs: r.fabricatedAxiomRefs,
      hasGroundedOn: r.hasGroundedOn,
      latencyMs: r.latencyMs,
    })),
  };
}

// ── Entry point ──────────────────────────────────────────────────────────

runSpike().catch(err => {
  console.error('Spike run failed:', err);
  process.exit(1);
});
