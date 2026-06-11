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
import { fileURLToPath } from 'url';
import { buildBaselinePrompt, buildGroundedPrompt, findFabricatedAxiomRefs, isValidAxiomRef, extractAxiomRefs } from './spike-distiller-prompt.js';
import { SPIKE_FIXTURES } from './spike-fixtures.js';
import type { DiagnosticianContextPayload } from '../../../packages/principles-core/src/runtime-v2/context-payload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Configuration ────────────────────────────────────────────────────────

const LM_STUDIO_BASE = 'http://localhost:12341';
const LM_STUDIO_CHAT_URL = `${LM_STUDIO_BASE}/api/v1/chat`;
const LM_STUDIO_MODELS_URL = `${LM_STUDIO_BASE}/api/v1/models`;

interface ModelConfig {
  name: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

// Use qwen3.6-27b-mtp as the primary model (already loaded)
// Add more models here if loaded in LM Studio
const DEFAULT_MODEL_CONFIGS: ModelConfig[] = [
  { name: 'qwen3.6-27b', model: 'qwen3.6-27b-mtp', temperature: 0.3, maxTokens: 4096 },
];

let MODEL_CONFIGS: ModelConfig[] = [...DEFAULT_MODEL_CONFIGS];

const RESULTS_DIR = path.join(__dirname, 'spike-results');
const TIMEOUT_MS = 300_000; // 5 minutes per request (27B model can be slow with reasoning)

// ── Health check & model auto-detection ─────────────────────────────────

interface LmStudioModel {
  key: string;
  display_name: string;
  type: string;
  loaded_instances: Array<{ id: string }>;
}

async function checkLmStudioHealth(): Promise<{ available: boolean; models: LmStudioModel[]; loadedModels: string[]; error?: string }> {
  try {
    const response = await fetch(LM_STUDIO_MODELS_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { available: false, models: [], loadedModels: [], error: `HTTP ${response.status}` };
    }
    const data = await response.json() as { models?: LmStudioModel[] };
    const models = data.models ?? [];
    const loadedModels = models
      .filter(m => m.type === 'llm' && m.loaded_instances && m.loaded_instances.length > 0)
      .map(m => m.key);
    return { available: true, models, loadedModels };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: false, models: [], loadedModels: [], error: msg };
  }
}

function matchModelConfigs(availableModels: LmStudioModel[], loadedModels: string[]): ModelConfig[] {
  const matched: ModelConfig[] = [];

  for (const config of DEFAULT_MODEL_CONFIGS) {
    // Check if model is loaded (preferred)
    if (loadedModels.includes(config.model)) {
      matched.push(config);
      continue;
    }
    // Check if model exists (not loaded but available)
    if (availableModels.some(m => m.key === config.model)) {
      matched.push({ ...config, model: config.model }); // will try to load on first call
      continue;
    }
    // Try partial match on loaded models
    const partial = loadedModels.find(m =>
      m.toLowerCase().includes(config.model.split(':')[0].toLowerCase())
    );
    if (partial) {
      matched.push({ ...config, model: partial });
      continue;
    }
  }

  // If no default models matched, use all loaded LLM models
  if (matched.length === 0 && loadedModels.length > 0) {
    for (const modelId of loadedModels) {
      const name = modelId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(0, 20);
      matched.push({ name, model: modelId, temperature: 0.3, maxTokens: 4096 });
    }
  }

  return matched;
}

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

  // LM Studio native API format
  const body = {
    model: modelConfig.model,
    system_prompt: systemPrompt,
    input: userMessage,
    temperature: modelConfig.temperature,
  };

  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(LM_STUDIO_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${response.statusText} ${errorText}`);
    }

    const data = await response.json() as {
      output?: Array<{ type: string; content: string }>;
      stats?: { tokens_per_second?: number };
    };

    // Extract message content from LM Studio response
    // output array contains { type: "reasoning", content: "..." } and { type: "message", content: "..." }
    const messageOutput = (data.output ?? []).find(o => o.type === 'message');
    const content = messageOutput?.content ?? '';

    const tps = data.stats?.tokens_per_second;
    if (tps) {
      console.log(`  (${tps.toFixed(1)} tokens/s)`);
    }

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
  // ── Health check ─────────────────────────────────────────────────────
  console.log('Checking LM Studio connection...');
  const health = await checkLmStudioHealth();
  if (!health.available) {
    console.error(`\n❌ LM Studio not reachable at ${LM_STUDIO_BASE}`);
    console.error(`   Error: ${health.error}`);
    console.error('\n   Please ensure:');
    console.error('   1. LM Studio is running');
    console.error('   2. Local Server is started');
    console.error('   3. At least one model is loaded');
    process.exit(1);
  }
  console.log(`✓ LM Studio connected. Loaded models: ${health.loadedModels.join(', ') || '(none)'}`);

  // Auto-detect and match models
  MODEL_CONFIGS = matchModelConfigs(health.models, health.loadedModels);
  if (MODEL_CONFIGS.length === 0) {
    console.error('\n❌ No matching models found.');
    console.error('   Loaded: ' + health.loadedModels.join(', '));
    console.error('   Available: ' + health.models.map(m => m.key).join(', '));
    process.exit(1);
  }
  console.log(`✓ Using models: ${MODEL_CONFIGS.map(m => `${m.name} (${m.model})`).join(', ')}\n`);

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

        const { parsed: parsedOutput, error: parseError } = error
          ? { parsed: null, error: null }
          : parseOutput(rawOutput);
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

  // ── Generate human rating sheet ──────────────────────────────────────

  const ratingSheetPath = path.join(RESULTS_DIR, 'human-rating-sheet.md');
  generateHumanRatingSheet(allResults, ratingSheetPath);
  console.log(`\nHuman rating sheet written to ${ratingSheetPath}`);
  console.log('   → Open this file and fill in the "Abstraction (1-5)" column for each row');
}

function generateHumanRatingSheet(results: SpikeResult[], filePath: string): void {
  const lines: string[] = [];
  lines.push('# Human Rating Sheet — Distiller Grounding Spike');
  lines.push('');
  lines.push('## Instructions');
  lines.push('');
  lines.push('For each row, read the LLM output and rate its **abstraction level** (1-5):');
  lines.push('');
  lines.push('| Score | Meaning |');
  lines.push('|-------|---------|');
  lines.push('| 1 | Specific code patch ("change line 45 in auth.ts") |');
  lines.push('| 2 | Rule-level constraint ("always read files before editing") |');
  lines.push('| 3 | Scenario-level advice ("when modifying unfamiliar code, survey first") |');
  lines.push('| 4 | Domain-level principle ("evidence must precede action in all code modifications") |');
  lines.push('| 5 | Cross-domain abstraction ("decisions require validated premises regardless of domain") |');
  lines.push('');
  lines.push('Also check: **Is the axiom reference correct?** (should match expected violation, not fabricated)');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group by fixture for easier comparison
  for (let i = 0; i < SPIKE_FIXTURES.length; i++) {
    const fixture = SPIKE_FIXTURES[i];
    const fixtureResults = results.filter(r => r.fixtureIndex === i);

    lines.push(`## ${i + 1}. ${fixture.name}`);
    lines.push(`**Scenario**: ${fixture.description}`);
    lines.push(`**Expected axiom**: ${fixture.expectedAxiomViolation ?? 'none (noise)'}`);
    lines.push('');

    // Table header
    lines.push('| Variant | Model | Kind | Axiom Ref | GroundedOn | Fabricated? | Abstraction (1-5) | Notes |');
    lines.push('|---------|-------|------|-----------|------------|-------------|-------------------|-------|');

    for (const r of fixtureResults) {
      const kinds = r.recommendationKinds.join(', ') || '(parse failed)';
      const axiomRefs = r.axiomRefs.join(', ') || '—';
      const groundedOn = r.hasGroundedOn ? 'Yes' : 'No';
      const fabricated = r.fabricatedAxiomRefs.length > 0 ? `⚠ ${r.fabricatedAxiomRefs.join(', ')}` : 'No';
      const parseNote = r.parseError ? ' [PARSE FAILED]' : '';
      const errorNote = r.error ? ' [REQUEST ERROR]' : '';

      lines.push(`| ${r.promptVariant} | ${r.model} | ${kinds}${parseNote}${errorNote} | ${axiomRefs} | ${groundedOn} | ${fabricated} | _fill_ | _fill_ |`);
    }

    lines.push('');

    // Include raw output excerpts for each result
    for (const r of fixtureResults) {
      lines.push(`<details>`);
      lines.push(`<summary>${r.promptVariant}/${r.model} raw output (${r.latencyMs}ms)</summary>`);
      lines.push('');
      lines.push('```text');
      // Show first 500 chars of raw output, or error
      if (r.error) {
        lines.push(`REQUEST ERROR: ${r.error}`);
      } else if (r.parseError) {
        lines.push(`PARSE ERROR: ${r.parseError}`);
        lines.push('');
        lines.push(r.rawOutput.slice(0, 800));
      } else {
        // Show parsed recommendations
        const parsed = r.parsedOutput;
        if (parsed) {
          const recs = parsed.recommendations;
          const summary = parsed.summary;
          const rootCause = parsed.rootCause;
          const notes = parsed.ambiguityNotes;
          lines.push(`Summary: ${typeof summary === 'string' ? summary : '(none)'}`);
          lines.push(`RootCause: ${typeof rootCause === 'string' ? rootCause : '(none)'}`);
          lines.push(`AmbiguityNotes: ${JSON.stringify(notes)}`);
          lines.push(`Recommendations:`);
          if (Array.isArray(recs)) {
            for (const rec of recs) {
              if (typeof rec === 'object' && rec !== null) {
                lines.push(`  - kind=${rec.kind}: ${rec.description}`);
                if (rec.abstractedPrinciple) lines.push(`    abstractedPrinciple: ${rec.abstractedPrinciple}`);
              }
            }
          }
        }
      }
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Summary section
  lines.push('## Summary (fill in after rating all rows)');
  lines.push('');
  lines.push('| Metric | Baseline | Grounded | Delta |');
  lines.push('|--------|----------|----------|-------|');
  lines.push('| principle kind count | _fill_ | _fill_ | _fill_ |');
  lines.push('| rule kind count | _fill_ | _fill_ | _fill_ |');
  lines.push('| Average abstraction | _fill_ | _fill_ | _fill_ |');
  lines.push('| Fabricated axiom refs | _fill_ | _fill_ | _fill_ |');
  lines.push('');
  lines.push('## GO / NO-GO');
  lines.push('');
  lines.push('- [ ] **GO** — Grounded prompt produces >=30% more "principle" kind, zero fabricated refs, avg abstraction >=1pt higher');
  lines.push('- [ ] **NO-GO** — Drop Q3/Q6, keep Q1+Q2 only');
  lines.push('');
  lines.push('Rationale: _fill_');

  fs.writeFileSync(filePath, lines.join('\n'));
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
