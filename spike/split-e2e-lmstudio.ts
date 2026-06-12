/**
 * split-e2e-lmstudio.ts — Standalone LM Studio e2e test for the split diagnostician pipeline.
 *
 * Reads all fixture files from split-e2e-fixtures/ (R1-R7 real + S1-S4 synthetic),
 * runs the 3-stage split pipeline (RootCause → Distiller → Router) against LM Studio,
 * validates outputs with TypeBox schemas, and generates a summary report.
 *
 * Usage:
 *   npx tsx spike/split-e2e-lmstudio.ts [--filter R1] [--core-grounding]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Imports from @principles/core (compiled dist) ──────────────────────────
import { RootCausePromptBuilder, buildRootCauseProtocolInstruction } from '../packages/principles-core/dist/runtime-v2/diagnostician/rootcause-prompt-builder.js';
import { DistillerPromptBuilder, buildDistillerProtocolInstruction } from '../packages/principles-core/dist/runtime-v2/diagnostician/distiller-prompt-builder.js';
import { RouterPromptBuilder } from '../packages/principles-core/dist/runtime-v2/diagnostician/router-prompt-builder.js';
import { DiagRootCauseOutputV1Schema } from '../packages/principles-core/dist/runtime-v2/diagnostician/diag-rootcause-output.js';
import { DiagDistillerOutputV1Schema } from '../packages/principles-core/dist/runtime-v2/diagnostician/diag-distiller-output.js';
import { DiagnosticianOutputV1Schema } from '../packages/principles-core/dist/runtime-v2/diagnostician-output.js';
import { Value } from '@sinclair/typebox/value';
import { extractJsonObject, repairMalformedJson } from '../packages/principles-core/dist/runtime-v2/adapter/json-extractor.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface FixtureEvidence {
  sourceRef: string;
  note: string;
}

interface FixtureProvenance {
  trigger?: string;
  prNumber?: number;
}

interface FixtureContextPayload {
  sourcePainId: string;
  reasonSummary: string;
  severity: string;
  evidence?: FixtureEvidence[];
  provenance?: FixtureProvenance;
  source?: string;
  sessionIdHint?: string;
  agentIdHint?: string;
  provenanceReason?: string;
}

interface Fixture {
  id: string;
  painId: string;
  source: string;
  description: string;
  coveredAxioms: string[];
  isSynthetic?: boolean;
  contextPayload: FixtureContextPayload;
  monolithOutput: Record<string, unknown> | null;
  _meta?: Record<string, unknown>;
}

interface StageResult {
  stage: string;
  passed: boolean;
  schemaValid: boolean;
  jsonRepairNeeded: boolean;
  timeMs: number;
  output: Record<string, unknown> | null;
  errors: string[];
}

interface FixtureResult {
  fixtureId: string;
  fixtureDescription: string;
  coveredAxioms: string[];
  isSynthetic: boolean;
  stages: StageResult[];
  totalTimeMs: number;
  monolithComparison: string | null;
}

// ── Config ─────────────────────────────────────────────────────────────────

const LM_STUDIO_URL = 'http://localhost:12341/v1/chat/completions';
const LM_STUDIO_MODEL = 'qwen3.6-27b-mtp';
const LLM_TIMEOUT_MS = 900_000; // 15 minutes — split pipeline runs 3 stages sequentially
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'split-e2e-fixtures',
);
const RESULTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'split-e2e-results.json',
);
const REPORT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'split-e2e-report.md',
);

// ── CLI arg parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filterArg = args.find(a => a.startsWith('--filter='));
const filterIdx = args.indexOf('--filter');
const filter = filterArg ? filterArg.split('=')[1] : (filterIdx >= 0 && filterIdx + 1 < args.length && !args[filterIdx + 1].startsWith('--') ? args[filterIdx + 1] : null);
const coreGrounding = args.includes('--core-grounding');
const langArg = args.find(a => a.startsWith('--lang='));
const outputLanguage: 'zh-CN' | 'en' | undefined = langArg ? (langArg.split('=')[1] as 'zh-CN' | 'en') : undefined;

// ── LM Studio call ─────────────────────────────────────────────────────────

async function callLmStudio(prompt: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  // Chain external signal if provided
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  try {
    console.log(`  [callLmStudio] Sending ${prompt.length} chars to ${LM_STUDIO_URL}...`);
    const fetchStart = Date.now();
    const response = await fetch(LM_STUDIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LM_STUDIO_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });
    console.log(`  [callLmStudio] Response received in ${Date.now() - fetchStart}ms, status=${response.status}`);

    if (!response.ok) {
      throw new Error(`LM Studio HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    if (!choices || choices.length === 0) {
      throw new Error('LM Studio returned no choices');
    }
    return choices[0].message.content;
  } finally {
    clearTimeout(timeout);
  }
}

// ── JSON extraction & validation ───────────────────────────────────────────

function parseAndValidate(
  raw: string,
  schema: Parameters<typeof Value.Check>[0],
  stageName: string,
): { output: Record<string, unknown> | null; schemaValid: boolean; jsonRepairNeeded: boolean; errors: string[] } {
  const errors: string[] = [];
  let output: Record<string, unknown> | null = null;
  let jsonRepairNeeded = false;

  // Step 1: Try direct JSON parse
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      output = parsed;
    }
  } catch {
    // Step 2: Try extractJsonObject
    output = extractJsonObject(raw);
    if (!output) {
      // Step 3: Try repairMalformedJson
      output = repairMalformedJson(raw);
      if (output) {
        jsonRepairNeeded = true;
      }
    } else {
      // extractJsonObject succeeded — check if it needed repair-like logic
      jsonRepairNeeded = raw.includes('```');
    }
  }

  if (!output) {
    errors.push(`${stageName}: Failed to extract JSON from LLM output`);
    return { output: null, schemaValid: false, jsonRepairNeeded: false, errors };
  }

  // Schema validation
  const schemaValid = Value.Check(schema, output);
  if (!schemaValid) {
    const schemaErrors = [...Value.Errors(schema, output)];
    const messages = schemaErrors.slice(0, 5).map(e => `${e.path}: ${e.message}`);
    errors.push(`${stageName} schema validation failed: ${messages.join('; ')}`);
  }

  return { output, schemaValid, jsonRepairNeeded, errors };
}

// ── Build DiagnosticianContextPayload from fixture ─────────────────────────

function buildContextPayload(fixture: Fixture) {
  const cp = fixture.contextPayload;
  const taskId = `diag-${fixture.painId}`;
  const contextId = `ctx-${fixture.painId}`;

  return {
    contextId,
    contextHash: `hash-${fixture.painId}`,
    taskId,
    workspaceDir: '/workspace',
    sourceRefs: (cp.evidence ?? []).map(e => e.sourceRef),
    diagnosisTarget: {
      reasonSummary: cp.reasonSummary,
      source: cp.source || fixture.source,
      severity: cp.severity,
      painId: cp.sourcePainId,
      sessionIdHint: cp.sessionIdHint,
      provenance: cp.provenance?.trigger === 'code_review'
        ? 'owner_reported_no_host_trace' as const
        : 'owner_reported_no_host_trace' as const,
      provenanceReason: cp.provenanceReason || 'Synthetic fixture — no host trace',
      evidence: (cp.evidence ?? []).map(e => ({
        sourceRef: e.sourceRef,
        note: e.note,
      })),
    },
    conversationWindow: [],
    ambiguityNotes: [`Fixture: ${fixture.id} — ${fixture.description}`],
  };
}

// ── Run one fixture through the 3-stage pipeline ───────────────────────────

async function runFixture(fixture: Fixture, signal?: AbortSignal): Promise<FixtureResult> {
  const stages: StageResult[] = [];
  const fixtureStart = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Fixture: ${fixture.id} — ${fixture.description}`);
  console.log(`Covered axioms: ${fixture.coveredAxioms.join(', ')}`);
  console.log(`${'═'.repeat(60)}`);

  // ── Stage A: Root Cause ────────────────────────────────────────────────
  const stageAStart = Date.now();
  let stageA: StageResult;

  try {
    const payload = buildContextPayload(fixture);
    const builder = new RootCausePromptBuilder({ coreGrounding });
    const { message } = builder.buildPrompt(payload as never, { coreGrounding, outputLanguage });

    console.log(`  [Stage A] Sending to LM Studio...`);
    const rawA = await callLmStudio(message, signal);
    const parsedA = parseAndValidate(rawA, DiagRootCauseOutputV1Schema, 'Stage A');

    stageA = {
      stage: 'A-RootCause',
      passed: parsedA.schemaValid,
      schemaValid: parsedA.schemaValid,
      jsonRepairNeeded: parsedA.jsonRepairNeeded,
      timeMs: Date.now() - stageAStart,
      output: parsedA.output,
      errors: parsedA.errors,
    };
    console.log(`  [Stage A] ${parsedA.schemaValid ? '✓ PASSED' : '✗ FAILED'} (${stageA.timeMs}ms, repair=${parsedA.jsonRepairNeeded})`);
    if (parsedA.errors.length > 0) {
      console.log(`  [Stage A] Errors: ${parsedA.errors.join('; ')}`);
    }
  } catch (err) {
    stageA = {
      stage: 'A-RootCause',
      passed: false,
      schemaValid: false,
      jsonRepairNeeded: false,
      timeMs: Date.now() - stageAStart,
      output: null,
      errors: [`Stage A call failed: ${err instanceof Error ? err.message : String(err)}`],
    };
    console.log(`  [Stage A] ✗ CALL FAILED: ${stageA.errors[0]}`);
  }
  stages.push(stageA);

  // ── Stage B: Distiller ─────────────────────────────────────────────────
  const stageBStart = Date.now();
  let stageB: StageResult;

  if (!stageA.output) {
    stageB = {
      stage: 'B-Distiller',
      passed: false,
      schemaValid: false,
      jsonRepairNeeded: false,
      timeMs: 0,
      output: null,
      errors: ['Skipped: Stage A produced no output'],
    };
    console.log(`  [Stage B] SKIPPED (Stage A failed)`);
  } else {
    try {
      const rootCauseArtifactId = `artifact-rc-${fixture.painId}`;
      const rootCauseOutput = stageA.output as never;
      const distillerBuilder = new DistillerPromptBuilder({ coreGrounding });
      const { message: msgB } = distillerBuilder.buildPrompt(
        { rootCauseArtifactId, rootCauseOutput, coreGrounding },
        { coreGrounding, outputLanguage },
      );

      console.log(`  [Stage B] Sending to LM Studio...`);
      const rawB = await callLmStudio(msgB, signal);
      const parsedB = parseAndValidate(rawB, DiagDistillerOutputV1Schema, 'Stage B');

      stageB = {
        stage: 'B-Distiller',
        passed: parsedB.schemaValid,
        schemaValid: parsedB.schemaValid,
        jsonRepairNeeded: parsedB.jsonRepairNeeded,
        timeMs: Date.now() - stageBStart,
        output: parsedB.output,
        errors: parsedB.errors,
      };
      console.log(`  [Stage B] ${parsedB.schemaValid ? '✓ PASSED' : '✗ FAILED'} (${stageB.timeMs}ms, repair=${parsedB.jsonRepairNeeded})`);
      if (parsedB.errors.length > 0) {
        console.log(`  [Stage B] Errors: ${parsedB.errors.join('; ')}`);
      }
    } catch (err) {
      stageB = {
        stage: 'B-Distiller',
        passed: false,
        schemaValid: false,
        jsonRepairNeeded: false,
        timeMs: Date.now() - stageBStart,
        output: null,
        errors: [`Stage B call failed: ${err instanceof Error ? err.message : String(err)}`],
      };
      console.log(`  [Stage B] ✗ CALL FAILED: ${stageB.errors[0]}`);
    }
  }
  stages.push(stageB);

  // ── Stage C: Router ────────────────────────────────────────────────────
  const stageCStart = Date.now();
  let stageC: StageResult;

  if (!stageA.output || !stageB.output) {
    stageC = {
      stage: 'C-Router',
      passed: false,
      schemaValid: false,
      jsonRepairNeeded: false,
      timeMs: 0,
      output: null,
      errors: [`Skipped: ${!stageA.output ? 'Stage A' : 'Stage B'} produced no output`],
    };
    console.log(`  [Stage C] SKIPPED (upstream stage failed)`);
  } else {
    try {
      const rootCauseArtifactId = `artifact-rc-${fixture.painId}`;
      const distillerArtifactId = `artifact-dist-${fixture.painId}`;
      const routerBuilder = new RouterPromptBuilder();
      const { message: msgC } = routerBuilder.buildPrompt({
        rootCauseArtifactId,
        rootCauseOutput: stageA.output as never,
        distillerArtifactId,
        distillerOutput: stageB.output as never,
      }, { outputLanguage });

      console.log(`  [Stage C] Sending to LM Studio...`);
      const rawC = await callLmStudio(msgC, signal);
      const parsedC = parseAndValidate(rawC, DiagnosticianOutputV1Schema, 'Stage C');

      stageC = {
        stage: 'C-Router',
        passed: parsedC.schemaValid,
        schemaValid: parsedC.schemaValid,
        jsonRepairNeeded: parsedC.jsonRepairNeeded,
        timeMs: Date.now() - stageCStart,
        output: parsedC.output,
        errors: parsedC.errors,
      };
      console.log(`  [Stage C] ${parsedC.schemaValid ? '✓ PASSED' : '✗ FAILED'} (${stageC.timeMs}ms, repair=${parsedC.jsonRepairNeeded})`);
      if (parsedC.errors.length > 0) {
        console.log(`  [Stage C] Errors: ${parsedC.errors.join('; ')}`);
      }
    } catch (err) {
      stageC = {
        stage: 'C-Router',
        passed: false,
        schemaValid: false,
        jsonRepairNeeded: false,
        timeMs: Date.now() - stageCStart,
        output: null,
        errors: [`Stage C call failed: ${err instanceof Error ? err.message : String(err)}`],
      };
      console.log(`  [Stage C] ✗ CALL FAILED: ${stageC.errors[0]}`);
    }
  }
  stages.push(stageC);

  // ── Monolith comparison ────────────────────────────────────────────────
  let monolithComparison: string | null = null;
  if (fixture.monolithOutput && stageC.output) {
    const monoSummary = (fixture.monolithOutput as Record<string, unknown>).summary as string | undefined;
    const splitSummary = (stageC.output as Record<string, unknown>).summary as string | undefined;
    if (monoSummary && splitSummary) {
      monolithComparison = `Monolith: "${monoSummary.slice(0, 80)}..." | Split: "${splitSummary.slice(0, 80)}..."`;
    }
  }

  return {
    fixtureId: fixture.id,
    fixtureDescription: fixture.description,
    coveredAxioms: fixture.coveredAxioms,
    isSynthetic: fixture.isSynthetic ?? false,
    stages,
    totalTimeMs: Date.now() - fixtureStart,
    monolithComparison,
  };
}

// ── Load fixtures ──────────────────────────────────────────────────────────

function loadFixtures(): Fixture[] {
  const files = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json'));
  const fixtures: Fixture[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
    const fixture = JSON.parse(raw) as Fixture;

    // Apply filter
    if (filter && fixture.id !== filter) continue;

    fixtures.push(fixture);
  }

  // Sort: R1-R7 first, then S1-S4
  fixtures.sort((a, b) => {
    const aIsSynthetic = a.isSynthetic ? 1 : 0;
    const bIsSynthetic = b.isSynthetic ? 1 : 0;
    if (aIsSynthetic !== bIsSynthetic) return aIsSynthetic - bIsSynthetic;
    return a.id.localeCompare(b.id);
  });

  return fixtures;
}

// ── Report generation ──────────────────────────────────────────────────────

function generateReport(results: FixtureResult[]): string {
  const lines: string[] = [];

  lines.push('# Split Diagnostician E2E Test Report');
  lines.push('');
  lines.push(`**Date**: ${new Date().toISOString()}`);
  lines.push(`**Model**: ${LM_STUDIO_MODEL}`);
  lines.push(`**Core Grounding**: ${coreGrounding ? 'ON' : 'OFF'}`);
  lines.push(`**Fixtures**: ${results.length}`);
  lines.push('');

  // ── Per-fixture summary ────────────────────────────────────────────────
  lines.push('## Per-Fixture Results');
  lines.push('');

  for (const r of results) {
    const allPassed = r.stages.every(s => s.passed);
    const icon = allPassed ? '✅' : '❌';
    const kind = r.isSynthetic ? 'synthetic' : 'real';

    lines.push(`### ${icon} ${r.fixtureId} (${kind}) — ${r.fixtureDescription}`);
    lines.push(`- Axioms: ${r.coveredAxioms.join(', ')}`);
    lines.push(`- Total time: ${(r.totalTimeMs / 1000).toFixed(1)}s`);
    lines.push('');

    lines.push('| Stage | Schema Valid | Repair Needed | Time |');
    lines.push('|-------|-------------|---------------|------|');
    for (const s of r.stages) {
      const valid = s.schemaValid ? '✓' : '✗';
      const repair = s.jsonRepairNeeded ? 'yes' : 'no';
      lines.push(`| ${s.stage} | ${valid} | ${repair} | ${(s.timeMs / 1000).toFixed(1)}s |`);
    }
    lines.push('');

    if (r.stages.some(s => s.errors.length > 0)) {
      lines.push('**Errors**:');
      for (const s of r.stages) {
        for (const e of s.errors) {
          lines.push(`- ${e}`);
        }
      }
      lines.push('');
    }

    if (r.monolithComparison) {
      lines.push(`**Monolith comparison**: ${r.monolithComparison}`);
      lines.push('');
    }
  }

  // ── Aggregate stats ────────────────────────────────────────────────────
  lines.push('## Aggregate Statistics');
  lines.push('');

  const stageNames = ['A-RootCause', 'B-Distiller', 'C-Router'];
  for (const name of stageNames) {
    const stageResults = results.map(r => r.stages.find(s => s.stage === name)!).filter(Boolean);
    const passed = stageResults.filter(s => s.passed).length;
    const total = stageResults.length;
    const avgTime = stageResults.reduce((sum, s) => sum + s.timeMs, 0) / (total || 1);
    const repairCount = stageResults.filter(s => s.jsonRepairNeeded).length;

    lines.push(`### ${name}`);
    lines.push(`- Success rate: ${passed}/${total} (${total > 0 ? ((passed / total) * 100).toFixed(0) : 0}%)`);
    lines.push(`- Average time: ${(avgTime / 1000).toFixed(1)}s`);
    lines.push(`- JSON repair needed: ${repairCount}/${total}`);
    lines.push('');
  }

  // ── Monolith comparison summary ────────────────────────────────────────
  const withMonolith = results.filter(r => r.monolithComparison !== null);
  if (withMonolith.length > 0) {
    lines.push('## Monolith vs Split Comparison');
    lines.push('');
    for (const r of withMonolith) {
      lines.push(`- **${r.fixtureId}**: ${r.monolithComparison}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Split Diagnostician E2E Test — LM Studio');
  console.log(`URL: ${LM_STUDIO_URL}`);
  console.log(`Model: ${LM_STUDIO_MODEL}`);
  console.log(`Core grounding: ${coreGrounding}`);
  console.log(`Output language: ${outputLanguage ?? '(default: English)'}`);
  console.log(`Filter: ${filter ?? '(none)'}`);
  console.log('');

  // Load fixtures
  const fixtures = loadFixtures();
  console.log(`Loaded ${fixtures.length} fixture(s): ${fixtures.map(f => f.id).join(', ')}`);

  if (fixtures.length === 0) {
    console.log('No fixtures to run. Exiting.');
    process.exit(0);
  }

  // Check LM Studio connectivity
  console.log('\nChecking LM Studio connectivity...');
  try {
    const healthResp = await fetch('http://localhost:12341/v1/models', {
      signal: AbortSignal.timeout(5000),
    });
    if (!healthResp.ok) {
      throw new Error(`HTTP ${healthResp.status}`);
    }
    const models = await healthResp.json() as Record<string, unknown>;
    console.log(`LM Studio is reachable. Available models: ${JSON.stringify(models)}`);
  } catch (err) {
    console.error(`\n❌ Cannot reach LM Studio at ${LM_STUDIO_URL}`);
    console.error(`   Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error('   Make sure LM Studio is running with a model loaded on port 12341.');
    process.exit(1);
  }

  // Run fixtures
  const results: FixtureResult[] = [];
  const abortController = new AbortController();

  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, aborting...');
    abortController.abort();
  });

  for (const fixture of fixtures) {
    if (abortController.signal.aborted) break;

    try {
      const result = await runFixture(fixture, abortController.signal);
      results.push(result);
    } catch (err) {
      console.error(`\n❌ Fixture ${fixture.id} failed with unhandled error: ${err}`);
      results.push({
        fixtureId: fixture.id,
        fixtureDescription: fixture.description,
        coveredAxioms: fixture.coveredAxioms,
        isSynthetic: fixture.isSynthetic ?? false,
        stages: [
          { stage: 'A-RootCause', passed: false, schemaValid: false, jsonRepairNeeded: false, timeMs: 0, output: null, errors: [`Unhandled: ${err instanceof Error ? err.message : String(err)}`] },
        ],
        totalTimeMs: 0,
        monolithComparison: null,
      });
    }
  }

  // Write results JSON
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\nResults written to: ${RESULTS_PATH}`);

  // Generate and write report
  const report = generateReport(results);
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`Report written to: ${REPORT_PATH}`);

  // Print summary
  const totalPassed = results.filter(r => r.stages.every(s => s.passed)).length;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`SUMMARY: ${totalPassed}/${results.length} fixtures passed all stages`);
  console.log(`${'═'.repeat(60)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
