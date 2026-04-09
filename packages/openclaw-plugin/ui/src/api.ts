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
  OverviewHealthResponse,
  CentralHealthResponse,
  EvolutionPrinciplesResponse,
  FeedbackGfiResponse,
  EmpathyEvent,
  FeedbackGateBlock,
  GateStatsResponse,
  GateBlockItem,
} from './types';

const GATEWAY_TOKEN_KEY = 'pd_gateway_token';
const OPENCLAW_SETTINGS_KEY = 'openclaw.control.settings.v1';

/**
 * 从 OpenClaw 主控面板的设置中读取 token
 */
function getOpenClawToken(): string | null {
  try {
    const raw = localStorage.getItem(OPENCLAW_SETTINGS_KEY);
    if (!raw) return null;
    const settings = JSON.parse(raw);
    // OpenClaw 存储 token 在 settings.token 或 settings.gatewayUrl 的 hash 中
    return settings?.token || null;
  } catch {
    return null;
  }
}

/**
 * 初始化 Gateway Token
 * 1. 优先从 URL 参数 ?token=xxx 获取
 * 2. 其次从 PD 自己的 localStorage 获取
 * 3. 最后从 OpenClaw 主控面板的设置中获取（共享认证）
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

  // 2. 从 PD 自己的 localStorage 获取
  const pdToken = localStorage.getItem(GATEWAY_TOKEN_KEY);
  if (pdToken) return pdToken;

  // 3. 尝试从 OpenClaw 主控面板共享
  const openclawToken = getOpenClawToken();
  if (openclawToken) {
    // 缓存到 PD 的 localStorage
    localStorage.setItem(GATEWAY_TOKEN_KEY, openclawToken);
    return openclawToken;
  }

  return null;
}

/**
 * 获取当前 Gateway Token
 * 优先从 PD localStorage，其次从 OpenClaw 共享
 */
export function getGatewayToken(): string | null {
  const pdToken = localStorage.getItem(GATEWAY_TOKEN_KEY);
  if (pdToken) return pdToken;
  return getOpenClawToken();
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
  getOverview(days?: number): Promise<OverviewResponse> {
    const params = days ? `?days=${days}` : '';
    return requestJson(`/plugins/principles/api/overview${params}`);
  },
  getCentralOverview(days?: number): Promise<OverviewResponse & { centralInfo?: { workspaceCount: number; enabledWorkspaceCount: number; workspaces: string[]; enabledWorkspaces: string[] } }> {
    const params = days ? `?days=${days}` : '';
    return requestJson(`/plugins/principles/api/central/overview${params}`);
  },
  syncCentral(): Promise<{ synced: Record<string, number>; timestamp: string }> {
    return requestJson('/plugins/principles/api/central/sync', { method: 'POST' });
  },
  getWorkspaceConfigs(): Promise<{
    configs: Array<{ workspaceName: string; enabled: boolean; displayName: string | null; syncEnabled: boolean }>;
    workspaces: Array<{ name: string; path: string; lastSync: string | null; config: null | { workspaceName: string; enabled: boolean; displayName: string | null; syncEnabled: boolean } }>;
  }> {
    return requestJson('/plugins/principles/api/central/workspaces');
  },
  updateWorkspaceConfig(workspaceName: string, updates: { enabled?: boolean; displayName?: string | null; syncEnabled?: boolean }): Promise<unknown> {
    return requestJson(`/plugins/principles/api/central/workspaces/${encodeURIComponent(workspaceName)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },
  addCustomWorkspace(name: string, path: string): Promise<{ success: boolean; workspace: string }> {
    return requestJson('/plugins/principles/api/central/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, path }),
    });
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
  getEvolutionStats(days?: number): Promise<EvolutionStatsResponse> {
    const params = days ? `?days=${days}` : '';
    return requestJson(`/plugins/principles/api/evolution/stats${params}`);
  },
  // Health & Circuit API (Phase 5)
  getOverviewHealth(): Promise<OverviewHealthResponse> {
    return requestJson('/plugins/principles/api/overview/health');
  },
  getCentralHealth(): Promise<CentralHealthResponse> {
    return requestJson('/plugins/principles/api/central/health');
  },
  getEvolutionPrinciples(): Promise<EvolutionPrinciplesResponse> {
    return requestJson('/plugins/principles/api/evolution/principles');
  },
  getFeedbackGfi(): Promise<FeedbackGfiResponse> {
    return requestJson('/plugins/principles/api/feedback/gfi');
  },
  getEmpathyEvents(limit?: number): Promise<EmpathyEvent[]> {
    const params = limit ? `?limit=${limit}` : '';
    return requestJson(`/plugins/principles/api/feedback/empathy-events${params}`);
  },
  getFeedbackGateBlocks(limit?: number): Promise<FeedbackGateBlock[]> {
    const params = limit ? `?limit=${limit}` : '';
    return requestJson(`/plugins/principles/api/feedback/gate-blocks${params}`);
  },
  getGateStats(): Promise<GateStatsResponse> {
    return requestJson('/plugins/principles/api/gate/stats');
  },
  getGateBlocks(limit?: number): Promise<GateBlockItem[]> {
    const params = limit ? `?limit=${limit}` : '';
    return requestJson(`/plugins/principles/api/gate/blocks${params}`);
  },
};
