/**
 * 端到端验证（PRI-559）：TypeBox → json_schema 注入 → 本地 llamacpp
 *
 * 模拟 pi-ai-runtime-adapter.tryJsonModePath 的 onPayload 注入逻辑，
 * 用真实 PD schema（PhilosopherOutputV1）实测 llamacpp 的 json_schema 输出。
 */
import { Value } from '@sinclair/typebox/value';
import { PhilosopherOutputV1Schema } from '../src/runtime-v2/internalization/philosopher-output.js';
import { ScribeOutputV1Schema } from '../src/runtime-v2/internalization/scribe-output.js';
import { typeboxToOpenAIJsonSchema } from '../src/runtime-v2/adapter/schema-json-converter.js';

const BASE = 'http://127.0.0.1:8080/v1';

async function callLlamacpp(schemaRef: string, schema: unknown, userPrompt: string): Promise<{
  ok: boolean;
  missing?: string[];
  subMissing?: string[];
  finishReason?: string;
  error?: string;
  contentPreview?: string;
}> {
  const jsonSchema = typeboxToOpenAIJsonSchema(schema as never);
  const payload = {
    model: 'qwen3.8-27b',
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 2000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaRef, schema: jsonSchema },
    },
  };
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    return { ok: false, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}` };
  }
  const data = (await resp.json()) as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  const finishReason = data.choices?.[0]?.finish_reason;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'content not JSON', finishReason, contentPreview: content.slice(0, 200) };
  }
  const valid = Value.Check(schema as never, parsed);
  if (!valid) {
    const errors = [...Value.Errors(schema as never, parsed)].map((e) => `${e.path}: ${e.message}`).slice(0, 8);
    return { ok: false, error: `schema invalid: ${errors.join(' | ')}`, finishReason };
  }
  return { ok: true, finishReason };
}

async function main() {
  // 确认服务在线
  try {
    await fetch(`${BASE}/models`, { method: 'GET' });
  } catch {
    console.log('LLAMACPP_OFFLINE');
    process.exit(2);
  }

  const philosopherPrompt = `You are the Philosopher agent in a self-improving agent framework pipeline.
Read the following dreamer artifact and produce a principle candidate with philosophical analysis.

DREAMER ARTIFACT:
The dreamer observed that agents often generate alternative solutions before understanding the root cause of a problem. In repeated experiments, agents that jumped to solutions without diagnosis produced incorrect fixes 60% of the time, while agents that first diagnosed the root cause succeeded 85% of the time. The pattern is strongest in multi-stage pipelines where later stages depend on earlier outputs. The dreamer proposes a principle: always complete root cause diagnosis before generating alternatives.

TASK:
1. taskId: task-philosopher-e2e-001
2. sourceDreamerArtifactId: artifact-dreamer-e2e-001
3. thesis: distill the core philosophical claim from the artifact (1-2 sentences)
4. principleCandidate: title (short), rationale (2-4 sentences), scope (what situations it applies to), confidence (0-1)
5. risks: array of 2-3 risk strings
6. generatedAt: current ISO timestamp

Output ONLY valid JSON matching the schema. No markdown, no explanation.`;

  const scribePrompt = `You are the Scribe agent. Read the philosopher artifact and produce a formal principle draft.

PHILOSOPHER ARTIFACT:
Thesis: Agents must complete root cause diagnosis before generating alternatives. Principle candidate: title "Diagnose Before Generating Alternatives", rationale about multi-stage pipelines, scope: agent workflows with dependent stages, confidence 0.85. Risks: slower response times, over-diagnosis.

TASK:
1. taskId: task-scribe-e2e-001
2. sourcePhilosopherArtifactId: artifact-philosopher-e2e-001
3. principleDraft: title, statement (2-3 sentences), rationale (2-4 sentences), applicability (array of 2 strings), antiPatterns (array of 2 strings), confidence (0-1)
4. sourceTrace: philosopherArtifactId (dreamerArtifactId optional)
5. risks: array of 2 risk strings
6. generatedAt: current ISO timestamp

Output ONLY valid JSON matching the schema. No markdown, no explanation.`;

  // Philosopher × 3
  console.log('=== Philosopher (json_schema via converter, 3 runs) ===');
  for (let i = 0; i < 3; i++) {
    const r = await callLlamacpp('philosopher-output-v1', PhilosopherOutputV1Schema, philosopherPrompt);
    console.log(`  run ${i + 1}: ${r.ok ? 'OK' : 'FAIL'} ${r.error ?? ''} ${r.finishReason ?? ''}`);
  }

  // Scribe × 3（含 Optional 字段）
  console.log('=== Scribe (json_schema via converter, 3 runs) ===');
  for (let i = 0; i < 3; i++) {
    const r = await callLlamacpp('scribe-output-v1', ScribeOutputV1Schema, scribePrompt);
    console.log(`  run ${i + 1}: ${r.ok ? 'OK' : 'FAIL'} ${r.error ?? ''} ${r.finishReason ?? ''}`);
  }
}

main().catch((e) => {
  console.log('E2E_ERROR', e);
  process.exit(1);
});
