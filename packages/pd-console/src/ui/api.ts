import type {
  ApiResponse,
  TaskZones,
  TaskEvidence,
  SystemStatus,
  ActivityEvent,
} from "../types.js";

function getToken(): string | null {
  return sessionStorage.getItem("pd_token");
}

function setToken(token: string): void {
  sessionStorage.setItem("pd_token", token);
}

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<ApiResponse<T>> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...headers,
        ...(options?.headers as Record<string, string> | undefined),
      },
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const parsed = await response.json() as { error?: string };
        if (parsed && typeof parsed.error === 'string') {
          errorMessage = parsed.error;
        }
      } catch {
        // ignore parse errors
      }
      return { success: false, error: errorMessage };
    }

    const data: T = await response.json() as T;
    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

async function fetchTasks(): Promise<ApiResponse<TaskZones>> {
  return request<TaskZones>("/api/tasks");
}

async function fetchTaskEvidence(id: string): Promise<ApiResponse<TaskEvidence>> {
  return request<TaskEvidence>(`/api/tasks/${id}/evidence`);
}

async function approveTask(
  id: string,
): Promise<ApiResponse<{ success: boolean }>> {
  return request<{ success: boolean }>(`/api/tasks/${id}/approve`, {
    method: "POST",
  });
}

async function rejectTask(
  id: string,
): Promise<ApiResponse<{ success: boolean }>> {
  return request<{ success: boolean }>(`/api/tasks/${id}/reject`, {
    method: "POST",
  });
}

async function cleanupTask(
  id: string,
): Promise<ApiResponse<{ success: boolean }>> {
  return request<{ success: boolean }>(`/api/tasks/${id}/cleanup`, {
    method: "POST",
  });
}

async function fetchStatus(): Promise<ApiResponse<SystemStatus>> {
  return request<SystemStatus>("/api/status");
}

async function fetchActivity(): Promise<ApiResponse<ActivityEvent[]>> {
  return request<ActivityEvent[]>("/api/activity");
}

export {
  getToken,
  setToken,
  request,
  fetchTasks,
  fetchTaskEvidence,
  approveTask,
  rejectTask,
  cleanupTask,
  fetchStatus,
  fetchActivity,
};
