import type {
  OverviewResponse,
  SampleDetailResponse,
  SamplesResponse,
  ThinkingModelDetailResponse,
  ThinkingOverviewResponse,
} from './types';

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
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
};
