/**
 * signal-keywords-api — 信号关键词 API 层
 *
 * 调用 OpenClaw 插件的信号关键词管理端点。
 * 功能分阶段交付：
 * - Phase 1：只读（fetch keywords + pending）
 * - Phase 2：读写（update / admit / reject）
 *
 * 当前 Phase 1 实现；写方法为 stub，返回"未实现"错误。
 *
 * ERR entries:
 * - rc-1: 所有响应经 validator 校验
 * - rc-2: 无 `as` bypass
 * - rc-9: 降级/失败路径含 reason
 */

import type { ApiResponse } from '../../types.js';
import type {
  UnifiedKeywordStore,
  PendingTermStore,
  UpdateKeywordStoreRequest,
  AdmitPendingTermRequest,
  SignalKeyword,
  PendingSignalTerm,
} from './signal-keywords-types.js';

// ── 端点路径（当 plugin I/O 模块实现后启用） ──────────────────────────────────
// const KEYWORDS_BASE = '/api/plugins/principles/signal-keywords';

// ── SignalKeywordsPage 直接调用的列表函数 ──────────────────────────────────────

/**
 * 获取所有活跃关键词列表（SignalKeywordsPage 使用）
 *
 * 当前 Phase 1: 端点未实现，返回 stub 错误。
 * Phase 2 需对接 /api/plugins/principles/signal-keywords 端点。
 */
export async function listActiveSignalKeywords(
  _signal?: AbortSignal,
): Promise<ApiResponse<SignalKeyword[]>> {
  void _signal;
  return {
    success: false,
    error: '信号关键词管理端点在当前版本中尚未实现（server-side plugin I/O 模块未部署）',
    reason: 'endpoint_not_implemented',
    nextAction: '请等待后续版本更新后再使用此功能',
  };
}

/**
 * 获取待确认信号词列表（SignalKeywordsPage 使用）
 *
 * 当前 Phase 1: 端点未实现，返回 stub 错误。
 * Phase 2 需对接 /api/plugins/principles/signal-keywords/pending 端点。
 */
export async function listPendingSignalTerms(
  _signal?: AbortSignal,
): Promise<ApiResponse<PendingSignalTerm[]>> {
  void _signal;
  return {
    success: false,
    error: '信号关键词管理端点在当前版本中尚未实现（server-side plugin I/O 模块未部署）',
    reason: 'endpoint_not_implemented',
    nextAction: '请等待后续版本更新后再使用此功能',
  };
}

// ── Phase 1 读取词库（category 分类读取） ──────────────────────────────────────

/**
 * 获取指定分类的信号词库
 *
 * @param category - 分类（correction | empathy）
 * @param signal - 允许外部中止
 */
export async function fetchKeywordStore(
  category: 'correction' | 'empathy',
  signal?: AbortSignal,
): Promise<ApiResponse<UnifiedKeywordStore>> {
  // Phase 1: 端点未实现，返回可识别的降级错误（rc-9）
  // 见 Task 4 实施说明：server-side 端点不在本 PR 范围内
  void category;
  void signal;
  return {
    success: false,
    error: '信号关键词管理端点在当前版本中尚未实现（server-side plugin I/O 模块未部署）',
    reason: 'endpoint_not_implemented',
    nextAction: '请等待后续版本更新后再使用此功能',
  };
}

/**
 * 获取 PendingTerm 候选池
 *
 * @param signal - 允许外部中止
 */
export async function fetchPendingTerms(
  signal?: AbortSignal,
): Promise<ApiResponse<PendingTermStore>> {
  void signal;
  return {
    success: false,
    error: '信号关键词管理端点在当前版本中尚未实现（server-side plugin I/O 模块未部署）',
    reason: 'endpoint_not_implemented',
    nextAction: '请等待后续版本更新后再使用此功能',
  };
}

// ── 写操作（Phase 2 stubs） ───────────────────────────────────────────────────

/**
 * 更新信号词库
 *
 * Phase 2 实现，当前返回"未实现"。
 */
export async function updateKeywordStore(
  _req: UpdateKeywordStoreRequest,
  _signal?: AbortSignal,
): Promise<ApiResponse<{ version: number }>> {
  return {
    success: false,
    error: '写操作在当前版本中尚未实现',
    reason: 'endpoint_not_implemented',
    nextAction: '请等待后续版本更新后再使用此功能',
  };
}

/**
 * 审批一个 PendingTerm（移入词库）
 *
 * Phase 2 实现，当前返回"未实现"。
 */
export async function admitPendingTerm(
  _req: AdmitPendingTermRequest,
  _signal?: AbortSignal,
): Promise<ApiResponse<{ version: number }>> {
  return {
    success: false,
    error: '写操作在当前版本中尚未实现',
    reason: 'endpoint_not_implemented',
    nextAction: '请等待后续版本更新后再使用此功能',
  };
}

/**
 * 拒绝一个 PendingTerm（从候选池移除）
 *
 * Phase 2 实现，当前返回"未实现"。
 */
export async function rejectPendingTerm(
  _term: string,
  _signal?: AbortSignal,
): Promise<ApiResponse<{ version: number }>> {
  return {
    success: false,
    error: '写操作在当前版本中尚未实现',
    reason: 'endpoint_not_implemented',
    nextAction: '请等待后续版本更新后再使用此功能',
  };
}
