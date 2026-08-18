import { describe, it, expect } from 'vitest';
import net from 'node:net';
import {
  PiAiRuntimeAdapter,
  buildLlmPrompt,
  resolveLlmClassificationPayload,
} from '@principles/core/runtime-v2';

/**
 * P0-A E2E: 真实 PiAiRuntimeAdapter × llama.cpp × typed structured output
 * (MVP_CORE_LOOP_CONTRACT INV-01 / Gate A)。
 *
 * 审计背景 (ISSUE-001/ISSUE-024): 修复前 Stage2 对任何 provider 结构性不可用,
 * 且测试只用 mock classifier,从未走真实 adapter payload 路径。本文件用真实
 * adapter + 本机 llama.cpp (127.0.0.1:8080) 复现审计 Case: 模型正确返回分类
 * → 系统必须产生有效 correction classification。
 *
 * llama.cpp 不可达时 skip(带明确 reason)——真实链路证明只在本机/有本地模型
 * 的环境成立;其他 provider 未逐个实测,不声称全修复。
 */

const LLAMACPP_BASE_URL = process.env.PD_TEST_LLAMACPP_URL ?? 'http://127.0.0.1:8080/v1';
const LLAMACPP_MODEL = process.env.PD_TEST_LLAMACPP_MODEL ?? 'qwen3.8-27b-llamacpp';
const SEMANTIC_CORRECTION =
  '我希望你以后遇到这种情况先确认我的意图，而不是直接替我做决定。';

// skipIf 在 test 收集期求值(beforeAll 太晚),用 top-level await 完成探测。
const llamaReachable: boolean = await new Promise<boolean>((resolve) => {
  const url = new URL(LLAMACPP_BASE_URL);
  const socket = net.connect({ host: url.hostname, port: Number(url.port ?? 80) });
  socket.setTimeout(1500);
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  socket.on('timeout', () => { socket.destroy(); resolve(false); });
});

function makeAdapter(baseUrl: string, timeoutMs: number): PiAiRuntimeAdapter {
  return new PiAiRuntimeAdapter({
    provider: 'llamacpp',
    model: LLAMACPP_MODEL,
    apiKeyEnv: 'LLAMACPP_API_KEY',
    timeoutMs,
    baseUrl,
    workspace: process.env.TEMP ?? '/tmp',
  });
}

async function runClassification(
  adapter: PiAiRuntimeAdapter,
  text: string,
  outputSchemaRef?: string,
  timeoutMs = 60_000,
): Promise<{ status: string; payload: unknown }> {
  const handle = await adapter.startRun({
    agentSpec: { agentId: 'signal-collector', schemaVersion: '1' },
    inputPayload: { prompt: buildLlmPrompt(text) },
    contextItems: [],
    timeoutMs,
    ...(outputSchemaRef ? { outputSchemaRef } : {}),
  });
  let status = await adapter.pollRun(handle.runId);
  const deadline = Date.now() + timeoutMs + 30_000;
  while (status.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    status = await adapter.pollRun(handle.runId);
  }
  if (status.status !== 'succeeded') {
    return { status: status.status, payload: null };
  }
  const output = await adapter.fetchOutput(handle.runId);
  return { status: status.status, payload: output?.payload };
}

describe('Signal Stage2 × real PiAiRuntimeAdapter (E2E, llama.cpp)', () => {
  it.skipIf(!llamaReachable)(
    'typed path: 语义纠正 → structured payload → valid correction classification',
    { timeout: 120_000 },
    async () => {
      const adapter = makeAdapter(LLAMACPP_BASE_URL, 60_000);
      const { status, payload } = await runClassification(
        adapter,
        SEMANTIC_CORRECTION,
        'signal-classification-output-v1',
      );

      expect(status).toBe('succeeded');
      const resolved = resolveLlmClassificationPayload(payload);
      expect(resolved.path).toBe('structured');
      expect(resolved.value).not.toBeNull();
      expect(resolved.value?.is_feedback).toBe(true);
      expect(resolved.value?.type).toBe('correction');
      expect(resolved.value?.confidence).toBeGreaterThan(0.5);
    },
  );

  it.skipIf(!llamaReachable)(
    '无 schema ref 的 legacy 路径也已可解析 (对象 payload 不再被丢弃)',
    { timeout: 120_000 },
    async () => {
      const adapter = makeAdapter(LLAMACPP_BASE_URL, 60_000);
      const { status, payload } = await runClassification(adapter, SEMANTIC_CORRECTION);

      expect(status).toBe('succeeded');
      // 修复前: payload 是对象但消费方只收 string → 恒 invalid (ISSUE-001)。
      // 修复后: 对象 payload 走 canonical structured 守卫,同样有效。
      const resolved = resolveLlmClassificationPayload(payload);
      expect(resolved.value?.is_feedback).toBe(true);
      expect(resolved.value?.type).toBe('correction');
    },
  );

  it('unavailable runtime: 连接失败 → run failed, 不产生有效 classification', { timeout: 30_000 }, async () => {
    const adapter = makeAdapter('http://127.0.0.1:9/v1', 5_000);
    await expect(
      runClassification(adapter, SEMANTIC_CORRECTION, 'signal-classification-output-v1'),
    ).rejects.toThrow();
  });

  it('timeout: 超短预算 → startRun 抛 timeout, classification 不可得 (host 侧 catch 降级)', { timeout: 60_000 }, async () => {
    const adapter = makeAdapter(LLAMACPP_BASE_URL, 1);
    // adapter 的真实行为: 超时在 startRun 内以 PDRuntimeError[timeout] 抛出,
    // host 的 classifier catch 后记录 SIGNAL_LLM_FAILED 并返回 null (降级)。
    await expect(
      runClassification(adapter, SEMANTIC_CORRECTION, 'signal-classification-output-v1', 1),
    ).rejects.toThrow(/timed out|timeout/i);
  });
});
