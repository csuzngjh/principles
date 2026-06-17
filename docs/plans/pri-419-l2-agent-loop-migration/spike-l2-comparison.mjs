// PRI-419 P1.4 — L2 3-arm comparison: run L2 dreamer on dogfood scenarios
//
// Purpose: Compare L2 agent-loop output against the L1 baseline (QUALITY-SUMMARY.md).
// L2 gives the dreamer read-only tools (read_principles, read_artifact) plus the
// ability to reason over multiple turns, so we expect better Grounding and 贴合度.
//
// Usage:
//   set PD_SPIKE_PROVIDER=sensenova
//   set PD_SPIKE_MODEL=deepseek-v4-flash
//   set PD_SPIKE_BASE_URL=https://token.sensenova.cn/v1
//   node spike-l2-comparison.mjs [dogfood-id]   (omit dogfood-id to run all 7)
//
// Output: per-scenario JSON saved to l2-outputs/<dogfood-id>.l2.json

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { runAgentLoop } from '@earendil-works/pi-agent-core';

const PROVIDER = process.env.PD_SPIKE_PROVIDER || 'sensenova';
const MODEL_ID = process.env.PD_SPIKE_MODEL || 'deepseek-v4-flash';
const BASE_URL = process.env.PD_SPIKE_BASE_URL || 'https://token.sensenova.cn/v1';
const API_KEY = process.env.SENSENOVA_API_KEY;
const TARGET = process.argv[2]; // optional: specific dogfood id

if (!API_KEY) {
  console.error('FAIL: set SENSENOVA_API_KEY');
  process.exit(2);
}

const DOGFOOD_DIR = 'D:/Code/principles/docs/plans/quality-dogfood-output';
const OUTPUT_DIR = DOGFOOD_DIR + '/l2-outputs';
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Build a minimal Model object (same as resolveL2Model in l2-agent-loop-adapter.ts) ──
const model = {
  id: MODEL_ID,
  name: MODEL_ID,
  api: 'openai-completions',
  provider: PROVIDER,
  baseUrl: BASE_URL,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: true,
    maxTokensField: 'max_tokens',
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: 'deepseek',
    supportsStrictMode: false,
  },
};

// ── Tool definitions (2 read-only + 1 submit_output) ──

// In-memory artifact store: keyed by sourceTaskId, value = JSON string
const fakeArtifactStore = new Map();

function registerArtifact(sourceTaskId, contentJson) {
  fakeArtifactStore.set(sourceTaskId, {
    artifactId: `pi-art-${sourceTaskId}`,
    sourceTaskId,
    contentJson: typeof contentJson === 'string' ? contentJson : JSON.stringify(contentJson),
  });
}

function buildTools(dogfoodId, outputCapture) {
  const readArtifactTool = {
    label: 'Read artifact',
    name: 'read_artifact',
    description: 'Read a pipeline artifact by artifactId or sourceTaskId to verify the evidence chain.',
    parameters: {
      type: 'object',
      properties: {
        sourceTaskId: { type: 'string', description: 'The sourceTaskId to look up artifacts for.' },
        artifactId: { type: 'string', description: 'Specific artifact ID (optional).' },
      },
    },
    execute: async (_id, params) => {
      const key = params.sourceTaskId || params.artifactId;
      const artifact = fakeArtifactStore.get(key);
      if (artifact) {
        return { content: [{ type: 'text', text: artifact.contentJson }] };
      }
      // Also search by artifactId prefix
      for (const [, a] of fakeArtifactStore) {
        if (a.artifactId === key || a.artifactId.startsWith(key)) {
          return { content: [{ type: 'text', text: a.contentJson }] };
        }
      }
      return { content: [{ type: 'text', text: `No artifact found for: ${key}` }] };
    },
  };

  const readPrinciplesTool = {
    label: 'Read principles',
    name: 'read_principles',
    description: 'Read the core axioms (T-01..T-10) and already-internalized principles.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            coreAxioms: [
              { id: 'T-01', statement: 'Do not use `as` to bypass runtime validation.' },
              { id: 'T-02', statement: 'Validate external input before use.' },
              { id: 'T-03', statement: 'Fail loud on missing required fields.' },
              { id: 'T-04', statement: 'Validate array element types.' },
              { id: 'T-05', statement: 'Prefer Object.hasOwn() over `in` operator.' },
              { id: 'T-06', statement: 'Maintain consistent provenance in lineage and evidence fields.' },
              { id: 'T-07', statement: 'Distinguish current, next, and recorded state in retry loops.' },
              { id: 'T-08', statement: 'Use bounded safe serialization for preview/telemetry.' },
              { id: 'T-09', statement: 'Graceful degradation must include an observable reason.' },
              { id: 'T-10', statement: 'Always verify changes match established patterns in the codebase.' },
            ],
            internalizedPrinciples: [],
          }, null, 2),
        }],
      };
    },
  };

  const submitOutputTool = {
    label: 'Submit output',
    name: 'submit_output',
    description: 'Submit your final DreamerOutputV1 JSON. You MUST call this exactly once when done.',
    parameters: {
      type: 'object',
      properties: {
        valid: { type: 'boolean' },
        taskId: { type: 'string' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              candidateIndex: { type: 'number' },
              badDecision: { type: 'string' },
              betterDecision: { type: 'string' },
              rationale: { type: 'string' },
              confidence: { type: 'number' },
              riskLevel: { type: 'string' },
              strategicPerspective: { type: 'string' },
            },
          },
        },
        contextRefs: { type: 'array', items: { type: 'string' } },
        sourcePainId: { type: 'string' },
        generatedAt: { type: 'string' },
      },
      required: ['valid', 'taskId', 'candidates', 'contextRefs', 'generatedAt'],
    },
    execute: async (_id, params) => {
      outputCapture.output = params;
      return { content: [{ type: 'text', text: 'Output submitted.' }], details: params, terminate: true };
    },
  };

  return [readArtifactTool, readPrinciplesTool, submitOutputTool];
}

// ── Parse dogfood markdown to extract diagnosis JSON ──

function extractDiagnosis(markdown) {
  // Find the Diagnosis: Root Cause Analysis JSON block
  const match = markdown.match(/## Diagnosis: Root Cause Analysis\n\n```json\n([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractDistiller(markdown) {
  const match = markdown.match(/## Diagnosis: Distiller Output\n\n```json\n([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function extractPainId(markdown) {
  const match = markdown.match(/- \*\*Pain ID\*\*:\s*(\S+)/);
  return match ? match[1] : null;
}

function extractPainReason(markdown) {
  const match = markdown.match(/- \*\*Reason\*\*:\s*(.+)/);
  return match ? match[1].trim() : null;
}

// ── Build dreamer prompt (matches DreamerPromptBuilder.buildPrompt) ──

function buildDreamerPrompt(taskId, predecessorOutput, contextRefs) {
  const promptInput = {
    taskId,
    contextHash: 'standalone-test',
    contextRefs,
    predecessorOutput,
    dreamerInstruction: `You are a Dreamer agent in a principle internalization pipeline. Your role is to generate alternative decision candidates based on the predecessor's diagnosis analysis.

PROTOCOL:
1. Review the predecessorOutput (typically a Diagnostician diagnosis) to understand what went wrong
2. For each identified root cause, generate 1-5 alternative decision candidates
3. Each candidate must describe: what was done wrong (badDecision), what should have been done instead (betterDecision), and why (rationale)
4. Assign a confidence score (0.0 to 1.0) and risk level (low, medium, or high) to each candidate
5. Provide a strategic perspective for each candidate

CRITICAL: You MUST use the submit_output tool to submit your DreamerOutputV1 JSON. Do NOT output the JSON as free text — call submit_output with the complete object. The loop terminates only after you call submit_output.

CONSTRAINTS:
- You MUST call submit_output to submit your output — do NOT output raw JSON as free text
- candidates MUST have 1-5 items
- candidateIndex MUST be a number (0-based)
- badDecision, betterDecision, rationale, strategicPerspective MUST be non-empty strings
- confidence MUST be a number between 0.0 and 1.0
- riskLevel MUST be exactly one of: "low", "medium", "high"
- contextRefs MUST be copied from the input contextRefs array
- generatedAt MUST be the current ISO-8601 timestamp
- valid MUST be true on success
- sourcePrincipleId is OPTIONAL — only include if you can identify a specific existing principle. Do NOT invent placeholder values.
- sourcePainId is an optional string`,
  };
  return JSON.stringify(promptInput);
}

// ── Run L2 for a single dogfood scenario ──

async function runDogfoodL2(dogfoodId) {
  const filePath = `${DOGFOOD_DIR}/${dogfoodId}.md`;
  if (!existsSync(filePath)) {
    console.error(`SKIP: ${filePath} not found`);
    return null;
  }

  const markdown = readFileSync(filePath, 'utf-8');
  const diagnosis = extractDiagnosis(markdown);
  const distiller = extractDistiller(markdown);
  const painId = extractPainId(markdown);
  const painReason = extractPainReason(markdown);

  if (!diagnosis) {
    console.error(`FAIL: no diagnosis found in ${dogfoodId}.md`);
    return null;
  }

  // Register artifacts: the diagnosis is the key predecessor
  const diagnosisTaskId = diagnosis.taskId || `diag_${dogfoodId}`;
  if (distiller) {
    registerArtifact(distiller.taskId || `distiller_${dogfoodId}`, distiller);
  }
  registerArtifact(diagnosisTaskId, diagnosis);

  // Build the dreamer predecessorOutput — use distiller if available, else diagnosis
  const predecessorOutput = distiller || diagnosis;
  const contextRefs = diagnosis.contextRefs || diagnosis.evidence?.map(e => e.sourceRef) || [painId || dogfoodId];
  const taskId = `l2-dreamer-${dogfoodId}-${Date.now()}`;

  const dreamerPrompt = buildDreamerPrompt(taskId, predecessorOutput, contextRefs);
  const toolInstruction = `
--- Tool protocol (L2 mode) ---
You have read-only tools to ground your output:
  - read_principles: read the core axioms (T-01..T-10) + already-internalized principles. Call BEFORE proposing candidates.
  - read_artifact: read a predecessor pipeline artifact by artifactId or sourceTaskId to verify the evidence chain.
  - submit_output: submit your final DreamerOutputV1. You MUST call this exactly once with a complete object; the loop stops after you call it.
Do not emit your final answer as free text — call submit_output.`;

  const messages = [
    { role: 'user', content: dreamerPrompt + toolInstruction, timestamp: Date.now() },
  ];

  const outputCapture = { output: null };
  const tools = buildTools(dogfoodId, outputCapture);
  let turnCount = 0;
  const MAX_TURNS = 8;

  const agentContext = {
    systemPrompt: '',
    messages,
    tools,
  };

  const loopConfig = {
    model,
    apiKey: API_KEY,
    convertToLlm: (msgs) => msgs.map(m => {
      if (m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') return m;
      throw new Error(`Unsupported role: ${m.role}`);
    }),
    beforeToolCall: async (ctx) => {
      const whitelist = new Set(['read_artifact', 'read_principles', 'submit_output']);
      if (!whitelist.has(ctx.toolCall.name)) {
        return { block: true, reason: `tool '${ctx.toolCall.name}' not in whitelist` };
      }
      return undefined;
    },
    shouldStopAfterTurn: () => {
      turnCount += 1;
      return outputCapture.output !== null || turnCount >= MAX_TURNS;
    },
  };

  console.log(`\n=== ${dogfoodId}: running L2 (${painId}) ===`);
  console.log(`  Pain: ${(painReason || '').substring(0, 80)}...`);
  console.log(`  Turn cap: ${MAX_TURNS}`);

  const start = Date.now();
  try {
    const transcript = await runAgentLoop(
      messages,
      agentContext,
      loopConfig,
      async (event) => {
        if (event.type === 'tool_execution_start') {
          console.log(`  [turn ${turnCount + 1}] tool: ${event.toolName}`);
        }
      },
      AbortSignal.timeout(300_000),
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // Extract output
    const result = outputCapture.output;
    if (result) {
      const output = {
        dogfoodId,
        painId,
        taskId,
        generatedAt: new Date().toISOString(),
        turnCount,
        elapsed: `${elapsed}s`,
        output: result,
      };
      writeFileSync(`${OUTPUT_DIR}/${dogfoodId}.l2.json`, JSON.stringify(output, null, 2));
      console.log(`  PASS: ${elapsed}s, ${turnCount} turns`);
      return output;
    }

    // Fallback: try to extract JSON from last assistant message
    for (let i = transcript.length - 1; i >= 0; i--) {
      const msg = transcript[i];
      if (msg.role !== 'assistant') continue;
      const content = msg.content;
      if (typeof content === 'string') {
        try {
          const parsed = JSON.parse(content);
          const output = {
            dogfoodId, painId, taskId,
            generatedAt: new Date().toISOString(),
            turnCount,
            elapsed: `${elapsed}s`,
            fallback: true,
            output: parsed,
          };
          writeFileSync(`${OUTPUT_DIR}/${dogfoodId}.l2.json`, JSON.stringify(output, null, 2));
          console.log(`  FALLBACK: ${elapsed}s, ${turnCount} turns`);
          return output;
        } catch { /* not JSON */ }
      }
    }

    console.log(`  FAIL: no output captured (${elapsed}s, ${turnCount} turns)`);
    return { dogfoodId, status: 'failed', turnCount, elapsed: `${elapsed}s` };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`  ERROR: ${err.message} (${elapsed}s)`);
    return { dogfoodId, status: 'error', error: err.message, elapsed: `${elapsed}s` };
  }
}

// ── Main ──

async function main() {
  const allIds = ['dogfood-01', 'dogfood-02', 'dogfood-03', 'dogfood-04', 'dogfood-05', 'dogfood-06', 'dogfood-07'];
  const targets = TARGET ? [TARGET] : allIds;

  // Run specified scenarios
  const results = [];
  for (const id of targets) {
    const result = await runDogfoodL2(id);
    if (result) results.push(result);
  }

  // Summary
  console.log('\n=== L2 Comparison Results ===');
  for (const r of results) {
    const status = r.output ? 'OUTPUT' : (r.status || 'FAILED');
    const detail = r.output
      ? `${r.output.valid !== false ? 'valid' : 'invalid'} candidates=${r.output.candidates?.length || 0}`
      : (r.error || r.status);
    console.log(`  ${r.dogfoodId}: ${status} — ${detail}`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
