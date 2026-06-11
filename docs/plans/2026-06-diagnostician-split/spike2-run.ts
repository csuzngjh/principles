/**
 * spike2-run.ts — Run Spike-2: Split Distiller vs Monolith comparison
 *
 * THROWAWAY script for Spike-2 (PRI-366).
 * Per §6 of 06-split-distiller-spike-plan.md.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=xxx DEEPSEEK_BASE_URL=https://api.deepseek.com npx tsx docs/plans/2026-06-diagnostician-split/spike2-run.ts
 *
 * Models:
 *   Weak:  qwen3.6-27b-mtp via LM Studio (localhost:12341)
 *   Strong: deepseek-v4-flash via OpenAI-compatible endpoint
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildRootCausePrompt, buildDistillerPrompt, isValidAxiomRef, findFabricatedAxiomRefs, countRuleLikeLeakage } from './spike2-split-prompt.js';
import type { RootCauseOutput, DistillerOutput } from './spike2-split-prompt.js';
import { buildBaselinePrompt } from './spike-distiller-prompt.js';
import { SPIKE_FIXTURES } from './spike-fixtures.js';
import type { DiagnosticianContextPayload } from '../../../packages/principles-core/src/runtime-v2/context-payload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Configuration ────────────────────────────────────────────────────────

const LM_STUDIO_BASE = 'http://localhost:12341';
const LM_STUDIO_CHAT_URL = `${LM_STUDIO_BASE}/api/v1/chat`;

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_CHAT_URL = `${DEEPSEEK_BASE_URL}/v1/chat/completions`;

const RESULTS_DIR = path.join(__dirname, 'spike-results');
const FIXTURES_DIR = path.join(__dirname, 'spike-fixtures-real');
const TIMEOUT_MS = 300_000; // 5 min per request

interface ModelConfig {
  name: string;
  model: string;
  temperature: number;
  useOpenAiFormat: boolean; // true for DeepSeek, false for LM Studio native
  apiKey?: string;
}

const MODEL_CONFIGS: ModelConfig[] = [
  { name: 'qwen3.6-27b', model: 'qwen3.6-27b-mtp', temperature: 0.3, useOpenAiFormat: false },
  { name: 'deepseek-v4-flash', model: 'deepseek-v4-flash', temperature: 0.3, useOpenAiFormat: true, apiKey: DEEPSEEK_API_KEY },
];

// ── Types ────────────────────────────────────────────────────────────────

interface FixtureData {
  name: string;
  description: string;
  expectedAxiomViolation?: string;
  source: 'real' | 'synthetic';
  realCode?: string;
  payload: DiagnosticianContextPayload;
  arm1Baseline?: {
    abstractedPrinciple: string;
    kind: string;
    groundedOn?: string | null;
  } | null;
}

interface StageAResult {
  rawOutput: string;
  parsed: RootCauseOutput | null;
  parseError: string | null;
  latencyMs: number;
  error: string | null;
}

interface StageBResult {
  rawOutput: string;
  parsed: DistillerOutput | null;
  parseError: string | null;
  latencyMs: number;
  error: string | null;
}

interface Arm1Result {
  abstractedPrinciple: string;
  source: 'production' | 're-run';
  latencyMs: number;
  error: string | null;
}

interface FixtureResult {
  fixtureName: string;
  fixtureSource: 'real' | 'synthetic';
  expectedAxiom: string | undefined;
  model: string;
  arm1: Arm1Result;
  stageA: StageAResult;
  stageB: StageBResult;
  arm3AbstractedPrinciple: string;
  arm3AxiomRef: string;
  arm3Fabricated: string[];
  arm1Leakage: { count: number; matches: string[] };
  arm3Leakage: { count: number; matches: string[] };
  axiomAccuracy: 'exact' | 'neighbor' | 'wrong' | 'none';
  totalLatencyMs: number;
}

// ── LLM API calls ────────────────────────────────────────────────────────

async function callLmStudio(systemPrompt: string, userMessage: string, model: string): Promise<{ rawOutput: string; latencyMs: number }> {
  const body = { model, system_prompt: systemPrompt, input: userMessage, temperature: 0.3 };
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(LM_STUDIO_CHAT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = await response.json() as { output?: Array<{ type: string; content: string }>; stats?: { tokens_per_second?: number } };
    const messageOutput = (data.output ?? []).find(o => o.type === 'message');
    const tps = data.stats?.tokens_per_second;
    if (tps) console.log(`  (${tps.toFixed(1)} tokens/s)`);
    return { rawOutput: messageOutput?.content ?? '', latencyMs: Date.now() - startTime };
  } finally { clearTimeout(timeoutId); }
}

async function callOpenAi(systemPrompt: string, userMessage: string, model: string, apiKey: string): Promise<{ rawOutput: string; latencyMs: number }> {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
  };
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${response.statusText} ${errText.slice(0, 200)}`);
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { rawOutput: data.choices?.[0]?.message?.content ?? '', latencyMs: Date.now() - startTime };
  } finally { clearTimeout(timeoutId); }
}

async function callLlm(systemPrompt: string, userMessage: string, modelConfig: ModelConfig): Promise<{ rawOutput: string; latencyMs: number }> {
  if (modelConfig.useOpenAiFormat) {
    if (!modelConfig.apiKey) throw new Error('DEEPSEEK_API_KEY not set');
    return callOpenAi(systemPrompt, userMessage, modelConfig.model, modelConfig.apiKey);
  }
  return callLmStudio(systemPrompt, userMessage, modelConfig.model);
}

// ── Output parsing ───────────────────────────────────────────────────────

function parseJsonOutput<T>(raw: string): { parsed: T | null; error: string | null } {
  // Try direct JSON parse
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed === 'object' && parsed !== null) return { parsed, error: null };
  } catch { /* fall through */ }

  // Try extracting from markdown fences
  const fencedMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(raw);
  if (fencedMatch?.[1]) {
    try {
      const parsed = JSON.parse(fencedMatch[1].trim());
      if (typeof parsed === 'object' && parsed !== null) return { parsed, error: null };
    } catch { /* fall through */ }
  }

  // Try balanced-bracket extraction
  let depth = 0, start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (typeof parsed === 'object' && parsed !== null) return { parsed, error: null };
        } catch { start = -1; }
      }
    }
  }
  return { parsed: null, error: 'Failed to parse LLM output as JSON' };
}

// ── Axiom accuracy (§4.3) ───────────────────────────────────────────────

// Neighbor axioms — axioms that are conceptually close
const AXIOM_NEIGHBORS: Record<string, string[]> = {
  'T-01': ['T-03'], // Survey Before Acting ↔ Evidence Over Assumption
  'T-02': ['T-01'], // Respect Constraints ↔ Survey Before Acting
  'T-03': ['T-01'], // Evidence Over Assumption ↔ Survey Before Acting
  'T-04': ['T-05'], // Reversible First ↔ Safety Rails
  'T-05': ['T-04'], // Safety Rails ↔ Reversible First
  'T-06': ['T-07'], // Simplicity First ↔ Minimal Change Surface
  'T-07': ['T-06'], // Minimal Change Surface ↔ Simplicity First
  'T-08': ['T-05'], // Pain As Signal ↔ Safety Rails
  'T-09': ['T-07'], // Divide And Conquer ↔ Minimal Change Surface
  'T-10': ['T-02'], // Memory Externalization ↔ Respect Constraints
};

function computeAxiomAccuracy(predicted: string, expected: string | undefined): 'exact' | 'neighbor' | 'wrong' | 'none' {
  if (!expected) return 'none';
  if (predicted === expected) return 'exact';
  const neighbors = AXIOM_NEIGHBORS[expected] || [];
  if (neighbors.includes(predicted)) return 'neighbor';
  return 'wrong';
}

// ── Health check ─────────────────────────────────────────────────────────

async function checkLmStudioHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${LM_STUDIO_BASE}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const data = await response.json() as { models?: Array<{ key: string; type: string; loaded_instances?: unknown[] }> };
    const loaded = (data.models ?? []).filter(m => m.type === 'llm' && m.loaded_instances && m.loaded_instances.length > 0);
    // Check if qwen3.6-27b is loaded (partial match)
    return loaded.some(m => m.key.toLowerCase().includes('qwen3.6'));
  } catch { return false; }
}

// ── Load fixtures ────────────────────────────────────────────────────────

function loadFixtures(): FixtureData[] {
  const fixtures: FixtureData[] = [];

  // Load real fixtures from spike-fixtures-real/
  if (fs.existsSync(FIXTURES_DIR)) {
    const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json') && f !== 'manifest.json');
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
      if (data.source === 'real') {
        fixtures.push(data as FixtureData);
      } else if (data.source === 'synthetic') {
        fixtures.push(data as FixtureData);
      }
    }
  }

  // If no real fixtures loaded, fall back to synthetic only
  if (fixtures.filter(f => f.source === 'real').length === 0) {
    console.warn('⚠ No real fixtures found. Run spike2-load-real-pains.cjs first.');
    console.warn('  Falling back to synthetic fixtures only.');
    const syntheticNames = ['irreversible-change', 'over-engineering', 'blast-radius-too-large', 'no-task-division', 'no-memory-externalization'];
    for (const sf of SPIKE_FIXTURES) {
      if (syntheticNames.includes(sf.name)) {
        fixtures.push({
          name: sf.name,
          description: sf.description,
          expectedAxiomViolation: sf.expectedAxiomViolation,
          source: 'synthetic',
          payload: sf.payload,
          arm1Baseline: null,
        });
      }
    }
  }

  return fixtures;
}

// ── Main execution ───────────────────────────────────────────────────────

async function main() {
  console.log('=== Spike-2: Split Distiller vs Monolith ===\n');

  // Health checks
  let lmStudioOk = false;
  try {
    const healthResp = await fetch(`${LM_STUDIO_BASE}/api/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (healthResp.ok) {
      const healthData = await healthResp.json() as { models?: Array<{ key: string; type: string; loaded_instances?: unknown[] }> };
      const loaded = (healthData.models ?? []).filter(m => m.type === 'llm' && m.loaded_instances && m.loaded_instances.length > 0);
      lmStudioOk = loaded.some(m => m.key.toLowerCase().includes('qwen3.6'));
      console.log(`✓ LM Studio connected. Loaded: ${loaded.map(m => m.key).join(', ')}`);
    }
  } catch {
    console.warn('⚠ LM Studio health check failed — will try on first request');
    lmStudioOk = true; // Assume OK, let it fail on actual request
  }
  if (!lmStudioOk) {
    console.warn('⚠ qwen3.6-27b not found as loaded — will try on first request');
    lmStudioOk = true; // Don't block, let it fail naturally
  }

  if (DEEPSEEK_API_KEY) {
    console.log(`✓ DeepSeek API key set (base: ${DEEPSEEK_BASE_URL})`);
  } else {
    console.warn('⚠ DEEPSEEK_API_KEY not set — deepseek-v4-flash runs will be skipped');
  }

  // Load fixtures
  const fixtures = loadFixtures();
  const realFixtures = fixtures.filter(f => f.source === 'real');
  const syntheticFixtures = fixtures.filter(f => f.source === 'synthetic');
  console.log(`\nFixtures: ${realFixtures.length} real + ${syntheticFixtures.length} synthetic = ${fixtures.length} total`);

  // Filter available models
  const availableModels = MODEL_CONFIGS.filter(m => {
    if (m.useOpenAiFormat && !m.apiKey) return false;
    if (!m.useOpenAiFormat && !lmStudioOk) return false;
    return true;
  });
  console.log(`Models: ${availableModels.map(m => m.name).join(', ')}\n`);

  if (availableModels.length === 0) {
    console.error('❌ No models available. Check LM Studio and DEEPSEEK_API_KEY.');
    process.exit(1);
  }

  // Ensure results directory exists
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // ── Run experiment ──────────────────────────────────────────────────

  const allResults: FixtureResult[] = [];
  let totalRuns = fixtures.length * availableModels.length;
  let completedRuns = 0;

  for (const modelConfig of availableModels) {
    for (const fixture of fixtures) {
      completedRuns++;
      console.log(`[${completedRuns}/${totalRuns}] ${fixture.source}/${fixture.name} × ${modelConfig.name}`);

      // ── Arm 1: Production monolith baseline ──────────────────────────
      let arm1: Arm1Result;
      if (fixture.source === 'real' && fixture.arm1Baseline?.abstractedPrinciple) {
        // Use stored production output
        arm1 = {
          abstractedPrinciple: fixture.arm1Baseline.abstractedPrinciple,
          source: 'production',
          latencyMs: 0,
          error: null,
        };
        console.log('  Arm1: using production baseline');
      } else {
        // Re-run monolith baseline (synthetic fixtures)
        try {
          const baselinePrompt = buildBaselinePrompt(fixture.payload);
          const arm1Result = await callLlm(
            baselinePrompt.diagnosticInstruction,
            JSON.stringify({
              taskId: fixture.payload.taskId,
              diagnosisTarget: fixture.payload.diagnosisTarget,
              conversationWindow: fixture.payload.conversationWindow,
              sourceRefs: fixture.payload.sourceRefs,
            }),
            modelConfig,
          );
          const parsed = parseJsonOutput(arm1Result.rawOutput);
          const recs = (parsed.parsed as Record<string, unknown>)?.recommendations;
          const principle = Array.isArray(recs) ? recs.find((r: Record<string, unknown>) => r.kind === 'principle') : null;
          arm1 = {
            abstractedPrinciple: principle?.abstractedPrinciple || principle?.description || '(no principle found)',
            source: 're-run',
            latencyMs: arm1Result.latencyMs,
            error: null,
          };
        } catch (err) {
          arm1 = { abstractedPrinciple: '', source: 're-run', latencyMs: 0, error: String(err) };
        }
      }

      // ── Arm 3: Split pipeline (Stage A → Stage B) ───────────────────
      // Stage A: Root Cause
      let stageA: StageAResult;
      try {
        const stageAPrompt = buildRootCausePrompt(fixture.payload);
        const stageAResult = await callLlm(stageAPrompt.systemPrompt, stageAPrompt.userMessage, modelConfig);
        const parsed = parseJsonOutput<RootCauseOutput>(stageAResult.rawOutput);
        stageA = { rawOutput: stageAResult.rawOutput, parsed: parsed.parsed, parseError: parsed.error, latencyMs: stageAResult.latencyMs, error: null };
      } catch (err) {
        stageA = { rawOutput: '', parsed: null, parseError: null, latencyMs: 0, error: String(err) };
      }

      // Stage B: Distiller (only if Stage A succeeded)
      let stageB: StageBResult;
      if (stageA.parsed) {
        try {
          const stageBPrompt = buildDistillerPrompt(stageA.parsed);
          const stageBResult = await callLlm(stageBPrompt.systemPrompt, stageBPrompt.userMessage, modelConfig);
          const parsed = parseJsonOutput<DistillerOutput>(stageBResult.rawOutput);
          stageB = { rawOutput: stageBResult.rawOutput, parsed: parsed.parsed, parseError: parsed.error, latencyMs: stageBResult.latencyMs, error: null };
        } catch (err) {
          stageB = { rawOutput: '', parsed: null, parseError: null, latencyMs: 0, error: String(err) };
        }
      } else {
        stageB = { rawOutput: '', parsed: null, parseError: 'Stage A failed', latencyMs: 0, error: 'Stage A failed' };
      }

      // ── Compute metrics ──────────────────────────────────────────────
      const arm3Principle = stageB.parsed?.abstractedPrinciple || '';
      const arm3AxiomRef = stageB.parsed?.groundedOnCorePrincipleId || '';
      const fabricated = stageB.parsed ? findFabricatedAxiomRefs(stageB.parsed) : [];
      const arm1Leakage = countRuleLikeLeakage(arm1.abstractedPrinciple);
      const arm3Leakage = countRuleLikeLeakage(arm3Principle);
      const axiomAccuracy = computeAxiomAccuracy(arm3AxiomRef, fixture.expectedAxiomViolation);

      const result: FixtureResult = {
        fixtureName: fixture.name,
        fixtureSource: fixture.source,
        expectedAxiom: fixture.expectedAxiomViolation,
        model: modelConfig.name,
        arm1,
        stageA,
        stageB,
        arm3AbstractedPrinciple: arm3Principle,
        arm3AxiomRef,
        arm3Fabricated: fabricated,
        arm1Leakage,
        arm3Leakage,
        axiomAccuracy,
        totalLatencyMs: stageA.latencyMs + stageB.latencyMs,
      };

      allResults.push(result);

      if (fabricated.length > 0) console.warn(`  ⚠ FABRICATED: ${fabricated.join(', ')}`);
      console.log(`  Arm1 leakage=${arm1Leakage.count} | Arm3 leakage=${arm3Leakage.count} | Axiom=${arm3AxiomRef} (${axiomAccuracy})`);

      // Brief pause
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // ── Generate outputs ──────────────────────────────────────────────────

  // 1. Summary JSON
  const summary = generateSummary(allResults, realFixtures.length, syntheticFixtures.length);
  fs.writeFileSync(path.join(RESULTS_DIR, 'spike2-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nSummary: spike2-summary.json`);

  // 2. Blind scoring sheet + key
  const { scoringMd, keyJson } = generateBlindScoring(allResults);
  fs.writeFileSync(path.join(RESULTS_DIR, 'spike2-blind-scoring.md'), scoringMd);
  fs.writeFileSync(path.join(RESULTS_DIR, 'spike2-key.json'), JSON.stringify(keyJson, null, 2));
  console.log(`Blind scoring: spike2-blind-scoring.md + spike2-key.json`);

  // 3. Print console summary
  printConsoleSummary(allResults);
}

// ── Generate summary JSON ────────────────────────────────────────────────

function generateSummary(results: FixtureResult[], realCount: number, syntheticCount: number) {
  const byModelAndSource: Record<string, {
    count: number;
    arm1AvgLeakage: number;
    arm3AvgLeakage: number;
    axiomExact: number;
    axiomNeighbor: number;
    axiomWrong: number;
    fabricatedCount: number;
    parseFailures: number;
    requestErrors: number;
    avgTotalLatencyMs: number;
  }> = {};

  for (const r of results) {
    const key = `${r.model}/${r.fixtureSource}`;
    if (!byModelAndSource[key]) {
      byModelAndSource[key] = { count: 0, arm1AvgLeakage: 0, arm3AvgLeakage: 0, axiomExact: 0, axiomNeighbor: 0, axiomWrong: 0, fabricatedCount: 0, parseFailures: 0, requestErrors: 0, avgTotalLatencyMs: 0 };
    }
    const s = byModelAndSource[key];
    s.count++;
    s.arm1AvgLeakage += r.arm1Leakage.count;
    s.arm3AvgLeakage += r.arm3Leakage.count;
    if (r.axiomAccuracy === 'exact') s.axiomExact++;
    if (r.axiomAccuracy === 'neighbor') s.axiomNeighbor++;
    if (r.axiomAccuracy === 'wrong') s.axiomWrong++;
    if (r.arm3Fabricated.length > 0) s.fabricatedCount++;
    if (r.stageA.parseError || r.stageB.parseError) s.parseFailures++;
    if (r.stageA.error || r.stageB.error) s.requestErrors++;
    s.avgTotalLatencyMs += r.totalLatencyMs;
  }

  for (const s of Object.values(byModelAndSource)) {
    if (s.count > 0) {
      s.arm1AvgLeakage = +(s.arm1AvgLeakage / s.count).toFixed(2);
      s.arm3AvgLeakage = +(s.arm3AvgLeakage / s.count).toFixed(2);
      s.avgTotalLatencyMs = Math.round(s.avgTotalLatencyMs / s.count);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    realFixtures: realCount,
    syntheticFixtures: syntheticCount,
    byModelAndSource,
    detailedResults: results.map(r => ({
      fixtureName: r.fixtureName,
      fixtureSource: r.fixtureSource,
      model: r.model,
      arm1AbstractedPrinciple: r.arm1.abstractedPrinciple,
      arm1Source: r.arm1.source,
      arm3AbstractedPrinciple: r.arm3AbstractedPrinciple,
      arm3AxiomRef: r.arm3AxiomRef,
      axiomAccuracy: r.axiomAccuracy,
      arm1Leakage: r.arm1Leakage.count,
      arm3Leakage: r.arm3Leakage.count,
      arm3Fabricated: r.arm3Fabricated,
      totalLatencyMs: r.totalLatencyMs,
      stageAParseError: r.stageA.parseError,
      stageBParseError: r.stageB.parseError,
      stageAError: r.stageA.error,
      stageBError: r.stageB.error,
    })),
  };
}

// ── Generate blind scoring sheet ─────────────────────────────────────────

function generateBlindScoring(results: FixtureResult[]): { scoringMd: string; keyJson: Record<string, { label: string; optionA: string; optionB: string }> } {
  const lines: string[] = [];
  const keyJson: Record<string, { label: string; optionA: string; optionB: string }> = {};

  lines.push('# Spike-2 Blind Abstraction Scoring');
  lines.push('');
  lines.push('Score each Option A/B on the 1-5 abstraction scale:');
  lines.push('');
  lines.push('| Score | Meaning |');
  lines.push('|-------|---------|');
  lines.push('| 1 | Specific code patch |');
  lines.push('| 2 | Rule-level constraint |');
  lines.push('| 3 | Scenario-level advice |');
  lines.push('| 4 | Domain-level principle |');
  lines.push('| 5 | Cross-domain abstraction |');
  lines.push('');
  lines.push('---');
  lines.push('');

  let rowIdx = 0;
  for (const r of results) {
    rowIdx++;
    const rowId = `row-${rowIdx}`;

    // Randomize A/B order
    const arm1First = Math.random() < 0.5;
    const optionA = arm1First ? r.arm1.abstractedPrinciple : r.arm3AbstractedPrinciple;
    const optionB = arm1First ? r.arm3AbstractedPrinciple : r.arm1.abstractedPrinciple;

    keyJson[rowId] = {
      label: `${r.fixtureSource}/${r.fixtureName} × ${r.model}`,
      optionA: arm1First ? 'Arm1 (Monolith)' : 'Arm3 (Split)',
      optionB: arm1First ? 'Arm3 (Split)' : 'Arm1 (Monolith)',
    };

    lines.push(`## ${rowId}: ${r.fixtureSource}/${r.fixtureName} × ${r.model}`);
    lines.push(`**Expected axiom**: ${r.expectedAxiom || 'none'}`);
    lines.push('');
    lines.push('| | Principle Text | Abstraction (1-5) |');
    lines.push('|--|----------------|-------------------|');
    lines.push(`| Option A | ${optionA.replace(/\|/g, '\\|')} | _fill_ |`);
    lines.push(`| Option B | ${optionB.replace(/\|/g, '\\|')} | _fill_ |`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('After scoring all rows, de-anonymize using spike2-key.json.');
  lines.push('');
  lines.push('| Metric | Arm 1 (Monolith) | Arm 3 (Split) | Delta |');
  lines.push('|--------|------------------|---------------|-------|');
  lines.push('| Average abstraction | _fill_ | _fill_ | _fill_ |');
  lines.push('| Rule-like leakage | _fill_ | _fill_ | _fill_ |');
  lines.push('| Axiom accuracy | _fill_ | _fill_ | _fill_ |');
  lines.push('');
  lines.push('## Split GO / NO-GO');
  lines.push('');
  lines.push('GO criteria (ALL must hold):');
  lines.push('- Arm 3 avg abstraction >= Arm 1 + 0.7');
  lines.push('- Arm 3 rule-like-leakage materially lower than Arm 1');
  lines.push('- Lift is larger for weak model (qwen3.6-27b) than strong model (deepseek-v4-flash)');
  lines.push('- Stage A root-cause quality does not regress');
  lines.push('');
  lines.push('- [ ] **GO** — Build T-F + T-G (split pipeline)');
  lines.push('- [ ] **NO-GO** — Ship only async + grounding + Q2 unify; defer T-F/T-G');
  lines.push('');
  lines.push('Rationale: _fill_');

  return { scoringMd: lines.join('\n'), keyJson };
}

// ── Console summary ──────────────────────────────────────────────────────

function printConsoleSummary(results: FixtureResult[]) {
  console.log('\n=== SPIKE-2 SUMMARY ===');
  console.log(`Total runs: ${results.length}`);

  for (const modelConfig of MODEL_CONFIGS.filter(m => results.some(r => r.model === m.name))) {
    const modelResults = results.filter(r => r.model === modelConfig.name);
    const realResults = modelResults.filter(r => r.fixtureSource === 'real');
    const synthResults = modelResults.filter(r => r.fixtureSource === 'synthetic');

    console.log(`\n--- ${modelConfig.name} ---`);

    for (const [label, subset] of [['REAL', realResults], ['Synthetic', synthResults]] as const) {
      if (subset.length === 0) continue;
      const arm1Leak = subset.reduce((s, r) => s + r.arm1Leakage.count, 0) / subset.length;
      const arm3Leak = subset.reduce((s, r) => s + r.arm3Leakage.count, 0) / subset.length;
      const exact = subset.filter(r => r.axiomAccuracy === 'exact').length;
      const neighbor = subset.filter(r => r.axiomAccuracy === 'neighbor').length;
      const wrong = subset.filter(r => r.axiomAccuracy === 'wrong').length;
      const fab = subset.filter(r => r.arm3Fabricated.length > 0).length;
      const parseFail = subset.filter(r => r.stageA.parseError || r.stageB.parseError).length;
      const reqErr = subset.filter(r => r.stageA.error || r.stageB.error).length;
      const avgLat = Math.round(subset.reduce((s, r) => s + r.totalLatencyMs, 0) / subset.length);

      console.log(`  ${label}: Arm1 leakage=${arm1Leak.toFixed(1)} | Arm3 leakage=${arm3Leak.toFixed(1)} | Axiom: ${exact}exact/${neighbor}neighbor/${wrong}wrong | Fab=${fab} | ParseFail=${parseFail} | ReqErr=${reqErr} | AvgLat=${avgLat}ms`);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Spike-2 run failed:', err);
  process.exit(1);
});
