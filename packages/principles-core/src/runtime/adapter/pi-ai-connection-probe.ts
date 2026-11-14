/**
 * Optional live connection check for the console's provider form (PRI-1213).
 *
 * Two-stage probe, cheapest first:
 *   1. the provider's model-list endpoint (no tokens spent);
 *   2. only if that endpoint is not supported/unavailable, one tiny chat
 *      completion (`maxTokens: 16`, no retries).
 *
 * Classification matters more than the wording: the Owner must be able to tell
 * "the network cannot reach the host" from "the host answered and rejected the
 * key" from "the provider returned an upstream error". Every message is
 * redacted with `redactSecretsFromText` before it leaves this module — the key
 * must never appear in a log, an HTTP response or the UI.
 */
import { completeSimple } from '@earendil-works/pi-ai/compat';
import type { Context } from '@earendil-works/pi-ai';
import { resolveModel } from './pi-ai-runtime-adapter.js';
import { redactSecretsFromText, resolveProviderApiKey } from '../config/pd-credentials.js';

const MODELS_TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_LENGTH = 500;

export type ProviderProbeKind =
  | 'ok'
  | 'missing_credential'
  | 'invalid_target'
  | 'invalid_credential'
  | 'network'
  | 'upstream';

export interface ProviderConnectionProbeInput {
  provider: string;
  model: string;
  apiKeyEnv: string;
  /** Advanced/custom endpoint. When omitted the catalog endpoint is used. */
  baseUrl?: string;
}

export interface ProviderConnectionProbeResult {
  ok: boolean;
  kind: ProviderProbeKind;
  /** Which stage produced the verdict. */
  stage: 'target' | 'credential' | 'models' | 'chat';
  httpStatus?: number;
  /** Redacted. Upstream text is preserved when the provider returned one. */
  message: string;
  nextAction?: string;
  latencyMs: number;
}

type FetchLike = typeof fetch;

interface ProbeDeps {
  resolveApiKey?: typeof resolveProviderApiKey;
  fetchImpl?: FetchLike;
  /** Test seam: the chat fallback must not require a real network call in unit tests. */
  completeSimpleImpl?: typeof completeSimple;
}

function clampMessage(text: string, secrets: readonly string[]): string {
  const redacted = redactSecretsFromText(text, secrets).replace(/\s+/g, ' ').trim();
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`
    : redacted;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractUpstreamMessage(raw: string): string {
  const text = raw.trim();
  if (text === '') return '';
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed !== undefined) {
      const { error } = parsed;
      if (typeof error === 'string') return error;
      const nested = asRecord(error);
      if (nested !== undefined) {
        const { message } = nested;
        if (typeof message === 'string' && message.trim() !== '') return message;
      }
      const { message } = parsed;
      if (typeof message === 'string' && message.trim() !== '') return message;
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return text;
}

function networkFailureMessage(error: unknown): string {
  const err = error as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = typeof err?.cause?.code === 'string' ? err.cause.code : undefined;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return '请求超时：目标主机在预算内没有响应';
  }
  const cause = typeof err?.cause?.message === 'string' ? err.cause.message : '';
  if (cause !== '') return code !== undefined ? `${code}: ${cause}` : cause;
  return typeof err?.message === 'string' && err.message.trim() !== ''
    ? err.message
    : '网络请求失败';
}

function looksLikeAuthFailure(text: string): boolean {
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[\s_-]*api[\s_-]*key|authentication/i.test(text);
}

function looksLikeNetworkFailure(text: string): boolean {
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|fetch failed|network|socket hang up|getaddrinfo/i.test(
    text,
  );
}

function modelsEndpoint(api: string, baseUrl: string): { url: string; headers: Record<string, string> } | undefined {
  const base = baseUrl.replace(/\/+$/, '');
  if (api === 'openai-completions' || api === 'openai-responses' || api === 'azure-openai-responses') {
    return {
      url: `${base}/models`,
      headers: { authorization: '__AUTH__' },
    };
  }
  if (api === 'anthropic-messages') {
    // Anthropic's catalog baseUrl is the bare host; custom Anthropic-compatible
    // bases commonly already end in /v1.
    const url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
    return {
      url,
      headers: {
        'x-api-key': '__API_KEY__',
        'anthropic-version': '2023-06-01',
      },
    };
  }
  // google-generative-ai takes the key in the query string, which violates the
  // "key never in a URL" rule. Skip the list probe and go straight to chat.
  return undefined;
}

async function probeModelList(input: {
  api: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
  secrets: readonly string[];
}): Promise<
  | { status: 'ok'; message: string; httpStatus: number }
  | { status: 'unsupported' }
  | { status: 'failed'; kind: ProviderProbeKind; httpStatus?: number; message: string }
> {
  const { api, baseUrl, apiKey, fetchImpl, secrets } = input;
  const endpoint = modelsEndpoint(api, baseUrl);
  if (endpoint === undefined) return { status: 'unsupported' };

  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [name, value] of Object.entries(endpoint.headers)) {
    if (value === '__AUTH__') headers[name] = `Bearer ${apiKey}`;
    else if (value === '__API_KEY__') headers[name] = apiKey;
    else headers[name] = value;
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint.url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: 'failed',
      kind: 'network',
      message: networkFailureMessage(error),
    };
  }

  const rawBody = await response.text().catch(() => '');
  const upstream = clampMessage(extractUpstreamMessage(rawBody), secrets);

  if (response.ok) {
    let count: number | undefined;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      const data =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { data?: unknown; models?: unknown }).data ??
            (parsed as { models?: unknown }).models
          : undefined;
      if (Array.isArray(data)) count = data.length;
    } catch {
      // count is optional; a 2xx is enough
    }
    return {
      status: 'ok',
      httpStatus: response.status,
      message:
        count !== undefined
          ? `模型列表可用（${String(count)} 个模型）`
          : `模型列表可用（HTTP ${String(response.status)}）`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: 'failed',
      kind: 'invalid_credential',
      httpStatus: response.status,
      message: upstream !== '' ? upstream : `认证失败（HTTP ${String(response.status)}）`,
    };
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { status: 'unsupported' };
  }
  return {
    status: 'failed',
    kind: 'upstream',
    httpStatus: response.status,
    message: upstream !== '' ? upstream : `上游返回 HTTP ${String(response.status)}`,
  };
}

export async function probeProviderConnection(
  input: ProviderConnectionProbeInput,
  deps: ProbeDeps = {},
): Promise<ProviderConnectionProbeResult> {
  const startedAt = Date.now();
  const finish = (
    result: Omit<ProviderConnectionProbeResult, 'latencyMs' | 'ok'> & { ok?: boolean },
  ): ProviderConnectionProbeResult => ({
    ...result,
    ok: result.ok ?? result.kind === 'ok',
    latencyMs: Date.now() - startedAt,
  });

  let model;
  try {
    model = resolveModel(input.provider, input.model, input.baseUrl);
  } catch (error) {
    return finish({
      kind: 'invalid_target',
      stage: 'target',
      message: clampMessage(error instanceof Error ? error.message : String(error), []),
      nextAction: '检查供应商与模型是否匹配，或改用高级自定义端点。',
    });
  }

  const resolveApiKey = deps.resolveApiKey ?? resolveProviderApiKey;
  const resolved = resolveApiKey(input.apiKeyEnv);
  if (resolved.value === null) {
    return finish({
      kind: 'missing_credential',
      stage: 'credential',
      message:
        resolved.error !== undefined
          ? clampMessage(resolved.error, [])
          : `未找到 ${input.apiKeyEnv}：环境变量与 ~/.pd/credentials.yaml 都没有值`,
      nextAction: '在控制台为该供应商保存 API Key。',
    });
  }
  const apiKey = resolved.value;
  const secrets = [apiKey];

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const listed = await probeModelList({
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey,
    fetchImpl,
    secrets,
  });
  if (listed.status === 'ok') {
    return finish({
      kind: 'ok',
      stage: 'models',
      httpStatus: listed.httpStatus,
      message: listed.message,
    });
  }
  if (listed.status === 'failed') {
    return finish({
      kind: listed.kind,
      stage: 'models',
      ...(listed.httpStatus !== undefined ? { httpStatus: listed.httpStatus } : {}),
      message: clampMessage(listed.message, secrets),
      nextAction:
        listed.kind === 'invalid_credential'
          ? '检查 API Key 是否正确、是否属于该供应商。'
          : listed.kind === 'network'
            ? '检查网络、代理或自定义端点地址是否可达。'
            : '上游服务返回错误，稍后重试或检查供应商状态。',
    });
  }

  // Minimal chat completion — the fallback when the provider has no usable
  // model-list endpoint. No retries, 16 output tokens.
  const context: Context = {
    messages: [
      {
        role: 'user',
        content: 'Reply with the single word: ok',
        timestamp: Date.now(),
      },
    ],
  };
  const complete = deps.completeSimpleImpl ?? completeSimple;
  try {
    const response = await complete(model, context, {
      apiKey,
      maxTokens: 16,
      maxRetries: 0,
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS + 2_000),
    });
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      const message = clampMessage(
        typeof response.errorMessage === 'string' && response.errorMessage.trim() !== ''
          ? response.errorMessage
          : `上游返回 stopReason=${response.stopReason}`,
        secrets,
      );
      const kind: ProviderProbeKind = looksLikeAuthFailure(message)
        ? 'invalid_credential'
        : looksLikeNetworkFailure(message)
          ? 'network'
          : 'upstream';
      return finish({
        kind,
        stage: 'chat',
        message,
        nextAction:
          kind === 'invalid_credential'
            ? '检查 API Key 是否正确、是否属于该供应商。'
            : kind === 'network'
              ? '检查网络、代理或自定义端点地址是否可达。'
              : '上游服务返回错误，稍后重试或检查供应商状态。',
      });
    }
    return finish({
      kind: 'ok',
      stage: 'chat',
      message: '连接成功（最小 chat 请求通过）',
    });
  } catch (error) {
    const raw = networkFailureMessage(error);
    const kind: ProviderProbeKind = looksLikeAuthFailure(raw)
      ? 'invalid_credential'
      : looksLikeNetworkFailure(raw)
        ? 'network'
        : 'upstream';
    return finish({
      kind,
      stage: 'chat',
      message: clampMessage(raw, secrets),
      nextAction:
        kind === 'invalid_credential'
          ? '检查 API Key 是否正确、是否属于该供应商。'
          : kind === 'network'
            ? '检查网络、代理或自定义端点地址是否可达。'
            : '上游服务返回错误，稍后重试或检查供应商状态。',
    });
  }
}
