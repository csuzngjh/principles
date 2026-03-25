/**
 * CURRENT_FOCUS 历史版本管理
 *
 * 功能：
 * - 压缩时备份当前版本到历史目录
 * - 清理过期历史版本
 * - 读取历史版本（用于 full 模式）
 * - 工作记忆提取与合并（压缩后恢复上下文）
 */
/**
 * 文件输出记录
 */
export interface FileArtifact {
    path: string;
    action: 'created' | 'modified' | 'deleted';
    description: string;
}
/**
 * 工作记忆快照
 */
export interface WorkingMemorySnapshot {
    lastUpdated: string;
    artifacts: FileArtifact[];
    currentTask?: {
        description: string;
        status: 'in_progress' | 'blocked' | 'reviewing' | 'completed';
        progress: number;
    };
    activeProblems: Array<{
        problem: string;
        approach?: string;
    }>;
    nextActions: string[];
}
/**
 * 获取历史目录路径
 */
export declare function getHistoryDir(focusPath: string): string;
/**
 * 从 CURRENT_FOCUS.md 提取版本号
 * 支持整数和小数版本（如 v1, v1.1, v1.2）
 */
export declare function extractVersion(content: string): string;
/**
 * 从 CURRENT_FOCUS.md 提取更新日期
 */
export declare function extractDate(content: string): string;
/**
 * 备份当前版本到历史目录
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param content 当前内容
 * @returns 备份文件路径，失败返回 null
 */
export declare function backupToHistory(focusPath: string, content: string): string | null;
/**
 * 清理过期历史版本
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param maxFiles 最大保留数量
 */
export declare function cleanupHistory(focusPath: string, maxFiles?: number): void;
/**
 * 获取历史版本列表
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param count 获取数量
 * @returns 历史版本内容数组（按时间倒序）
 */
export declare function getHistoryVersions(focusPath: string, count?: number): string[];
/**
 * 压缩 CURRENT_FOCUS.md
 *
 * @param focusPath CURRENT_FOCUS.md 的完整路径
 * @param newContent 新内容
 * @returns 压缩后的信息
 */
export declare function compressFocus(focusPath: string, newContent: string): {
    backupPath: string | null;
    cleanedCount: number;
};
/**
 * 智能摘要提取
 *
 * 优先提取关键章节，确保不丢失重要信息
 * 对于非结构化内容，回退到简单的行截取
 *
 * @param content CURRENT_FOCUS.md 内容
 * @param maxLines 最大行数
 */
export declare function extractSummary(content: string, maxLines?: number): string;
/**
 * 从会话消息中提取工作记忆
 *
 * @param messages 会话消息数组（OpenClaw 格式）
 * @param workspaceDir 工作区目录（用于生成相对路径）
 * @returns 提取的工作记忆快照
 */
export declare function extractWorkingMemory(messages: Array<{
    role?: string;
    content?: string | unknown[];
}>, workspaceDir?: string): WorkingMemorySnapshot;
/**
 * 解析 CURRENT_FOCUS.md 中的 Working Memory 章节
 */
export declare function parseWorkingMemorySection(content: string): WorkingMemorySnapshot | null;
/**
 * 将工作记忆合并到 CURRENT_FOCUS.md 内容中
 *
 * @param content 原始内容
 * @param snapshot 工作记忆快照
 * @returns 合并后的内容
 */
export declare function mergeWorkingMemory(content: string, snapshot: WorkingMemorySnapshot): string;
/**
 * 生成工作记忆注入字符串（用于 prompt 注入）
 */
export declare function workingMemoryToInjection(snapshot: WorkingMemorySnapshot | null): string;
