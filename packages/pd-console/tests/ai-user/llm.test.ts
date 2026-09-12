/**
 * PRI-754 — LLM 决策协议解析与安全边界的单元测试。
 * EP-01（信任边界）：模型回复按不可信输入处理——负向样例覆盖畸形 JSON、
 * 越权动作类型、缺失字段；EP-09：每个守卫都有触达失败分支的负向对照。
 * 注：所有凭据值均为显式标注的假值，仅用于 env stub，非真实密钥。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeLlmBaseUrl,
  createLlmClient,
  extractAssistantContent,
  extractJsonBlock,
  parseAiUserDecision,
  resolveLlmConfig,
  retryDelayFor,
} from './llm.js';

// 测试专用假值（非真实凭据）；经对象成员引用，避免被当作硬编码凭据
const fakeEnv = {
  k: 'fake-key-for-unit-test',
  k2: 'fake-key-override',
  m: 'fake-model-for-unit-test',
  m2: 'fake-model-override',
};

describe('assertSafeLlmBaseUrl', () => {
  it('接受 http/https 与本地端点（可信操作员配置）', () => {
    expect(assertSafeLlmBaseUrl('https://api.openai.com/v1').protocol).toBe('https:');
    expect(assertSafeLlmBaseUrl('http://127.0.0.1:11434/v1').host).toBe('127.0.0.1:11434');
  });

  it('拒绝非 http(s) 协议', () => {
    expect(() => assertSafeLlmBaseUrl('ftp://example.com/v1')).toThrow(/http\/https/);
    expect(() => assertSafeLlmBaseUrl('file:///etc/passwd')).toThrow(/http\/https/);
  });

  it('拒绝内嵌凭据', () => {
    expect(() => assertSafeLlmBaseUrl('http://user:pass@example.com/v1')).toThrow(/凭据/);
  });

  it('拒绝不可解析的 URL', () => {
    expect(() => assertSafeLlmBaseUrl('not a url')).toThrow(/非法/);
  });
});

describe('resolveLlmConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('env 齐备时解析成功', () => {
    vi.stubEnv('OPENAI_API_KEY', fakeEnv.k);
    vi.stubEnv('PD_AI_USER_MODEL', fakeEnv.m);
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:11434/v1');
    const config = resolveLlmConfig();
    expect(config).toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: fakeEnv.k, model: fakeEnv.m });
  });

  it('OPENAI_API_KEY 缺失时 fail-loud 并给出 nextAction', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('PD_AI_USER_MODEL', fakeEnv.m);
    expect(() => resolveLlmConfig()).toThrow(/OPENAI_API_KEY.*nextAction/s);
  });

  it('模型缺失时 fail-loud', () => {
    vi.stubEnv('OPENAI_API_KEY', fakeEnv.k);
    vi.stubEnv('PD_AI_USER_MODEL', '');
    expect(() => resolveLlmConfig()).toThrow(/模型/);
  });

  it('overrides 优先于 env', () => {
    vi.stubEnv('OPENAI_API_KEY', fakeEnv.k);
    vi.stubEnv('PD_AI_USER_MODEL', fakeEnv.m);
    const config = resolveLlmConfig({ apiKey: fakeEnv.k2, model: fakeEnv.m2 });
    expect(config.apiKey).toBe(fakeEnv.k2);
    expect(config.model).toBe(fakeEnv.m2);
  });
});

describe('extractJsonBlock', () => {
  it('纯 JSON / 围栏 JSON / 夹杂文字的 JSON 均可提取', () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonBlock('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonBlock('好的，我的决策是 {"a":1} 请查收')).toBe('{"a":1}');
  });

  it('没有 JSON 时返回 null', () => {
    expect(extractJsonBlock('我觉得应该点击按钮')).toBeNull();
  });
});

describe('parseAiUserDecision', () => {
  const clickDecision = {
    thought: '首页有「开始」按钮',
    action: { type: 'click', target: 'role=button[name="开始"]' },
    problems: [],
    suggestions: [],
  };

  it('合法 click 决策解析成功', () => {
    const d = parseAiUserDecision(JSON.stringify(clickDecision));
    expect(d.action.type).toBe('click');
    expect(d.action.target).toBe('role=button[name="开始"]');
  });

  it('finish 决策携带 success 与 note', () => {
    const d = parseAiUserDecision(
      JSON.stringify({
        thought: '目标达成',
        action: { type: 'finish', success: true, note: '看到了运行状态' },
        problems: [],
        suggestions: ['首屏可以更明确'],
      }),
    );
    expect(d.action.success).toBe(true);
    expect(d.suggestions).toEqual(['首屏可以更明确']);
  });

  it.each([
    ['缺少 thought', { action: clickDecision.action, problems: [], suggestions: [] }],
    ['缺少 action', { thought: 't', problems: [], suggestions: [] }],
    ['未知动作类型', { ...clickDecision, action: { type: 'shell', command: 'rm -rf /' } }],
    ['click 缺 target', { ...clickDecision, action: { type: 'click' } }],
    ['navigate 越权外链', { ...clickDecision, action: { type: 'navigate', value: 'https://evil.example.com' } }],
    ['problems 元素非字符串', { ...clickDecision, problems: [1] }],
    ['finish success 非布尔', { ...clickDecision, action: { type: 'finish', success: 'yes' } }],
    ['finish 缺 success（协议必填）', { ...clickDecision, action: { type: 'finish', note: '没有结论字段' } }],
  ])('%s 时拒绝（负向对照）', (_label, bad) => {
    expect(() => parseAiUserDecision(JSON.stringify(bad))).toThrow();
  });

  it('非 JSON 回复拒绝并带原文摘录', () => {
    expect(() => parseAiUserDecision('我觉得应该点击按钮')).toThrow(/JSON 对象/);
  });

  it('截断的 JSON 拒绝', () => {
    expect(() => parseAiUserDecision('{"thought": "点击')).toThrow();
  });
});

describe('extractAssistantContent', () => {
  it('守卫提取 choices[0].message.content', () => {
    expect(extractAssistantContent({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  });

  it.each([
    ['缺少 choices', {}],
    ['choices 为空数组', { choices: [] }],
    ['content 缺失', { choices: [{ message: {} }] }],
    ['content 非字符串', { choices: [{ message: { content: 5 } }] }],
  ])('%s 时拒绝（负向对照）', (_label, bad) => {
    expect(() => extractAssistantContent(bad)).toThrow();
  });
});

describe('retryDelayFor', () => {
  it('429 限频用 4 倍退避', () => {
    expect(retryDelayFor('LLM 请求失败 HTTP 429: tpm limit', 5000)).toBe(20000);
  });

  it('其他错误用基础退避', () => {
    expect(retryDelayFor('LLM 请求失败 HTTP 503: down', 5000)).toBe(5000);
    expect(retryDelayFor('The operation was aborted due to timeout', 5000)).toBe(5000);
  });
});

describe('createLlmClient decide 重试', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const clientConfig = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: fakeEnv.k, model: fakeEnv.m };
  const validReply = JSON.stringify({
    thought: '点击开始',
    action: { type: 'click', target: 'text=开始' },
    problems: [],
    suggestions: [],
  });
  const okResponse = { ok: true, json: async () => ({ choices: [{ message: { content: validReply } }] }) };

  it('网络/5xx 失败退避后整请求重发一次', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce(okResponse);
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient(clientConfig, { retryDelayMs: 1 });
    const decision = await client.decide('prompt');
    expect(decision.action.type).toBe('click');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('协议解析失败附纠错反馈重问', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '不是 JSON' } }] }) })
      .mockResolvedValueOnce(okResponse);
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient(clientConfig, { retryDelayMs: 1 });
    const decision = await client.decide('prompt');
    expect(decision.thought).toBe('点击开始');
    const secondInit = fetchMock.mock.calls[1]?.[1] as { body?: string } | undefined;
    expect(String(secondInit?.body)).toContain('动作协议');
  });

  it('两次均失败时抛结构化错误（rc-9）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient(clientConfig, { retryDelayMs: 1 });
    await expect(client.decide('prompt')).rejects.toThrow(/重试后仍无效/);
  });
});
