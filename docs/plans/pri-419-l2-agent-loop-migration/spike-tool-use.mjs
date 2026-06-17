// PRI-419 P1.0a — Tool-use spike (manual gate)
//
// Purpose: verify the target model supports NATIVE function-calling before any L2
// code ships. A multi-turn agent loop multiplies LLM calls 3–5×; a model without
// native tool-use degrades the loop into prompt-induced JSON "tool calls" and is
// NOT a real agent loop. This spike is the precondition gate per ADR-0014
// Amendment (2026-06-16) §B.5.
//
// This is a STANDALONE script — it does NOT live in the PD test suite and does NOT
// depend on PD installing pi-agent-core yet. It imports the L2 API straight from
// the pi-mono workspace build so we can validate the contract against a real model
// before committing to the dependency upgrade.
//
// Prereqs:
//   1. Build pi-mono:  cd D:\Code\pi-mono && npm run build   (or just packages/ai + packages/agent)
//   2. Set credentials, e.g.:
//        set PD_SPIKE_PROVIDER=anthropic
//        set PD_SPIKE_MODEL=claude-sonnet-4-20250514
//        set ANTHROPIC_API_KEY=...
//      (or a SenseNova / openai-compatible endpoint via PD_SPIKE_BASE_URL)
//        set PD_SPIKE_PROVIDER=openai
//        set PD_SPIKE_MODEL=sensenova-deepseek-v4-flash
//        set PD_SPIKE_BASE_URL=https://...
//        set OPENAI_API_KEY=...
//
// Run:
//   node docs/plans/pri-419-l2-agent-loop-migration/spike-tool-use.mjs
//
// Exit code 0 = model passed the tool-use gate; non-zero = it did not.
//
// PASS criteria (all three, printed in the verdict):
//   1. The model emitted at least one real tool_call (not just text mentioning a tool).
//   2. The loop consumed the tool result and continued.
//   3. The model called submit_output (or produced a final answer) after seeing the tool result.
// A model that only echoes JSON-shaped text instead of issuing a structured tool_call FAILS.

import { getModel } from 'file:///D:/Code/pi-mono/packages/ai/dist/index.js';
import { agentLoop } from 'file:///D:/Code/pi-mono/packages/agent/dist/index.js';
import { Type } from 'typebox';

const PROVIDER = process.env.PD_SPIKE_PROVIDER;
const MODEL_ID = process.env.PD_SPIKE_MODEL;
const BASE_URL = process.env.PD_SPIKE_BASE_URL;

if (!PROVIDER || !MODEL_ID) {
  console.error('FAIL: set PD_SPIKE_PROVIDER and PD_SPIKE_MODEL (and the matching *_API_KEY).');
  process.exit(2);
}

// Resolve the API key the same way pi-ai's known providers expect it.
const apiKey =
  process.env[`${PROVIDER.toUpperCase()}_API_KEY`] ??
  process.env.OPENAI_API_KEY ??
  process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(`FAIL: no API key found for provider '${PROVIDER}'.`);
  process.exit(2);
}

// --- Two read-only tools, mirroring the real PD tool shape ---
const getSquareSchema = Type.Object({ n: Type.Number({ description: 'The number to square' }) });

const getSquareTool = {
  label: 'Get square',
  name: 'get_square',
  description: 'Returns the square of a number. Use it to verify arithmetic.',
  parameters: getSquareSchema,
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: `${params.n} squared is ${params.n * params.n}` }],
    details: { result: params.n * params.n },
  }),
};

const submitOutputSchema = Type.Object({
  answer: Type.String({ description: 'The final answer, grounded in the tool result.' }),
});
let captured = null;
const submitOutputTool = {
  label: 'Submit output',
  name: 'submit_output',
  description: 'Submit your final answer after checking with get_square.',
  parameters: submitOutputSchema,
  execute: async (_id, params) => {
    captured = params;
    return {
      content: [{ type: 'text', text: 'Output submitted.' }],
      details: params,
      terminate: true,
    };
  },
};

// --- Run the loop with shouldStopAfterTurn controlling termination ---
const model = BASE_URL ? getModel(PROVIDER, MODEL_ID, { baseUrl: BASE_URL }) : getModel(PROVIDER, MODEL_ID);

let turnCount = 0;
const toolsInvoked = {};
const config = {
  model,
  apiKey,
  tools: [getSquareTool, submitOutputTool],
  convertToLlm: (msgs) => msgs, // AgentMessage[] already maps to Message[] for this minimal case
  beforeToolCall: async (ctx) => {
    toolsInvoked[ctx.toolCall.name] = (toolsInvoked[ctx.toolCall.name] ?? 0) + 1;
    return undefined; // allow
  },
  // Terminate when submit_output captured output, or hard cap at 5 turns.
  shouldStopAfterTurn: () => {
    turnCount += 1;
    return captured !== null || turnCount >= 5;
  },
};

const context = {
  systemPrompt:
    'You are a math assistant. To answer, you MUST call the get_square tool to verify, then call submit_output with the verified answer. Do not guess.',
  messages: [{ role: 'user', content: 'What is 7 squared? Verify with get_square, then submit_output.', timestamp: Date.now() }],
  tools: [getSquareTool, submitOutputTool],
};

console.log(`Spike: provider=${PROVIDER} model=${MODEL_ID} baseUrl=${BASE_URL ?? '(default)'}`);

const stream = agentLoop(context.messages, context, config, AbortSignal.timeout(120_000));
for await (const ev of stream) {
  if (ev.type === 'tool_execution_start') {
    console.log(`  [turn ${turnCount + 1}] tool_call: ${ev.toolName} args=${JSON.stringify(ev.args)}`);
  }
  if (ev.type === 'tool_execution_end') {
    console.log(`  [turn ${turnCount + 1}] tool_result: ${ev.toolName} isError=${ev.isError}`);
  }
}
const finalMessages = await stream;

// --- Verdict ---
const issuedRealToolCall = (toolsInvoked['get_square'] ?? 0) > 0;
const consumedAndContinued = turnCount >= 2; // at least one tool turn + one more turn
const submitted = captured !== null;

console.log('---');
console.log(`turnCount=${turnCount} toolsInvoked=${JSON.stringify(toolsInvoked)} submitted=${submitted}`);
console.log(`criteria: real_tool_call=${issuedRealToolCall} consumed_and_continued=${consumedAndContinued} submitted=${submitted}`);

if (issuedRealToolCall && consumedAndContinued && submitted) {
  console.log(`PASS: ${PROVIDER}/${MODEL_ID} supports native tool-use — L2 loop is viable.`);
  console.log(`captured=${JSON.stringify(captured)}`);
  process.exit(0);
} else {
  console.log(`FAIL: ${PROVIDER}/${MODEL_ID} did NOT complete the tool-use gate.`);
  console.log('If the model only echoed text instead of issuing a structured tool_call, it lacks native function-calling.');
  process.exit(1);
}
