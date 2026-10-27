/**
 * bash-risk.ts — PRI-1047 Owner review R6 #1: 宿主 bash 命令风险分类的
 * 单一实现（P4 One Source of Truth）。
 *
 * 修复前的问题链：
 *   - 只有 OpenClaw 插件接了 enrichment provider（其 `_getBashRisk` 是
 *     插件私有）；Codex 宿主路径无 provider，`derived.bashRisk` 恒为
 *     'unknown'；
 *   - golden-trace 回放夹具把 bashRisk 硬编码为 'unknown'，
 *     not_approved × 只读命令 的组合从未被任何系统验证覆盖；
 *   - 旧正则把 `git commit` 判成 safe（不匹配任何变更子串）——一个
 *     名为"safe = 宿主判定只读"的信号绝不能覆盖 git 写操作。
 *
 * 本模块被三方共用以保证同一判定：
 *   1. host-runtime 生产 gate（未接 provider 时的确定性默认，替代 unknown）；
 *   2. OpenClaw 插件 enrichment（保持其工具集门槛语义）；
 *   3. golden-trace 合成输入（回放与生产同口径分类）。
 *
 * 纯函数、无 I/O；`safe` 的语义是「宿主判定的只读调查命令」。
 */

/** 既有生产正则原样保留（无词边界，保守偏向变更判定——与 OpenClaw 行为逐字节一致）。 */
const DANGEROUS_RE = /\brm\s+-rf\b|\bchmod\b|\bchown\b|>\s*\/dev\//;
const BASE_MUTATION_RE = /(?:>|>>|sed|rm|mv|mkdir|touch|cp|npm|yarn|pnpm|pip|cargo)/;
/** 新增变更词（词边界精确匹配）：git 变更子命令 + 常见写入工具。 */
const GIT_MUTATION_RE = /\bgit\s+(?:add|commit|push|pull|fetch|merge|rebase|reset|restore|checkout|switch|clean|apply|am|cherry-pick|revert|tag|stash|branch|worktree|rm|mv|init|clone|submodule)\b/;
const EXTRA_MUTATION_RE = /\b(?:tee|truncate|shred|patch|ln|kill|pkill|killall|gem|brew|apt|apt-get|choco|winget)\b/;
/** 任意代码执行（node -e / python -c 等）不是只读调查——具备变更能力。
 * 系统反事实恰以这两类命令验证 denied→block（R6 修复轮实测暴露）。 */
const ARBITRARY_CODE_EXEC_RE = /\b(?:node|deno|bun)\s+(?:-e|--eval)\b|\b(?:python|python3)\s+(?:-c|--command)\b|\b(?:ruby|perl)\s+(?:-e|--eval)\b/;

export type BashRiskLevel = 'safe' | 'normal' | 'dangerous' | 'unknown';

/** 纯命令文本分类；空串/异常交由调用方判 unknown。 */
export function classifyCommandRisk(command: string): 'safe' | 'normal' | 'dangerous' {
  if (DANGEROUS_RE.test(command)) return 'dangerous';
  if (BASE_MUTATION_RE.test(command) || GIT_MUTATION_RE.test(command) || EXTRA_MUTATION_RE.test(command) || ARBITRARY_CODE_EXEC_RE.test(command)) return 'normal';
  return 'safe';
}

/**
 * 按 (工具是否 execute 类, 参数) 分类。非 execute 类工具（read/search/write/…）
 * 的 bashRisk 恒为 unknown——该字段只描述 shell 命令。
 */
export function classifyBashRisk(isExecuteKind: boolean, params: unknown): BashRiskLevel {
  if (!isExecuteKind) return 'unknown';
  try {
    const p = typeof params === 'object' && params !== null && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const command = typeof p.command === 'string' ? p.command : typeof p.args === 'string' ? p.args : '';
    if (command === '') return 'unknown';
    return classifyCommandRisk(command);
  } catch {
    return 'unknown';
  }
}
