import type {
  OverviewResponse,
  SampleDetailResponse,
  SamplesResponse,
  ThinkingModelDetailResponse,
  ThinkingOverviewResponse,
  EvolutionTasksResponse,
  EvolutionEventsResponse,
  EvolutionTraceResponse,
  EvolutionStatsResponse,
} from './types';

const GATEWAY_TOKEN_KEY = 'pd_gateway_token';

/**
 * 初始化 Gateway Token
 * 1. 优先从 URL 参数 ?token=xxx 获取
 * 2. 其次从 localStorage 获取
 */
export function initGatewayToken(): string | null {
  // 1. 尝试从 URL 参数获取
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get('token');
  if (urlToken) {
    localStorage.setItem(GATEWAY_TOKEN_KEY, urlToken);
    // 清理 URL 中的 token 参数（安全考虑）
    urlParams.delete('token');
    const newUrl = urlParams.toString()
      ? `${window.location.pathname}?${urlParams.toString()}`
      : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
    return urlToken;
  }

  // 2. 从 localStorage 获取
  return localStorage.getItem(GATEWAY_TOKEN_KEY);
}

/**
 * 获取当前 Gateway Token
 */
export function getGatewayToken(): string | null {
  return localStorage.getItem(GATEWAY_TOKEN_KEY);
}

/**
 * 设置 Gateway Token
 */
export function setGatewayToken(token: string): void {
  localStorage.setItem(GATEWAY_TOKEN_KEY, token);
}

/**
 * 清除 Gateway Token
 */
export function clearGatewayToken(): void {
  localStorage.removeItem(GATEWAY_TOKEN_KEY);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const token = getGatewayToken();

  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> ?? {}),
  };

  // 添加 Authorization header
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    credentials: 'same-origin',
    headers,
    ...init,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  getOverview(): Promise<OverviewResponse> {
    return requestJson('/plugins/principles/api/overview');
  },
  listSamples(search: URLSearchParams): Promise<SamplesResponse> {
    return requestJson(`/plugins/principles/api/samples?${search.toString()}`);
  },
  getSampleDetail(sampleId: string): Promise<SampleDetailResponse> {
    return requestJson(`/plugins/principles/api/samples/${encodeURIComponent(sampleId)}`);
  },
  reviewSample(sampleId: string, decision: 'approved' | 'rejected', note?: string): Promise<unknown> {
    return requestJson(`/plugins/principles/api/samples/${encodeURIComponent(sampleId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, note }),
    });
  },
  getThinkingOverview(): Promise<ThinkingOverviewResponse> {
    return requestJson('/plugins/principles/api/thinking');
  },
  getThinkingModelDetail(modelId: string): Promise<ThinkingModelDetailResponse> {
    return requestJson(`/plugins/principles/api/thinking/models/${encodeURIComponent(modelId)}`);
  },
  exportCorrections(mode: 'raw' | 'redacted'): string {
    return `/plugins/principles/api/export/corrections?mode=${mode}`;
  },
  // Evolution API
  getEvolutionTasks(search: URLSearchParams): Promise<EvolutionTasksResponse> {
    return requestJson(`/plugins/principles/api/evolution/tasks?${search.toString()}`);
  },
  getEvolutionEvents(search: URLSearchParams): Promise<EvolutionEventsResponse> {
    return requestJson(`/plugins/principles/api/evolution/events?${search.toString()}`);
  },
  getEvolutionTrace(traceId: string): Promise<EvolutionTraceResponse> {
    return requestJson(`/plugins/principles/api/evolution/trace/${encodeURIComponent(traceId)}`);
  },
  getEvolutionStats(): Promise<EvolutionStatsResponse> {
    return requestJson('/plugins/principles/api/evolution/stats');
  },
};
