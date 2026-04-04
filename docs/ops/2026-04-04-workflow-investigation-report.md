# Workflow v1 Sprint System — 调查与评估报告

**日期**: 2026-04-04
**调查范围**: `scripts/ai-sprint-orchestrator/` 及所有 sprint 运行记录
**数据来源**: git 历史、timeline 日志、decision 文档、producer/reviewer 报告

---

## 一、执行概览

### 1.1 Sprint 运行统计

自 2026-04-03 起，共执行了 **15+ 个 sprint run**，分布如下：

| Sprint 任务 | 运行次数 | 最远进展 | 结果 |
|------------|---------|----------|------|
| `subagent-helper-deep-reflect` | ~5 次 | 2 阶段完整跑完（investigate → architecture-cut） | halted (max rounds) |
| `subagent-helper-empathy-verify` | ~10 次 | 1 轮 producer 完成，reviewer 崩溃 | halted (spawn ENOENT / agent crash) |
| `workflow-validation-minimal` | 1 次 | 1 轮 producer 完成，reviewer_b 崩溃 | halted (missing reports) |

### 1.2 完成状态

- **0 个 sprint 达到 completed 状态**
- **所有 sprint 均 halted**，原因分布：
  - `max_rounds_exceeded`：4 次
  - `spawn ENOENT`（环境问题）：6 次
  - `agent crash`（iflow status 1）：3 次
  - `missing reports`：2 次

### 1.3 最有价值的一次运行

**`11:07 deep-reflect`** 是唯一产出有意义分析内容的 sprint：
- **investigate 阶段**：3 轮 → `advance`（2 个 reviewer 全部 APPROVE，维度评分 5/5/5 和 4/4/4）
- **architecture-cut 阶段**：5 轮 → `halt`（发现了 `OpenClawPluginApi` 不提供 sessionId 的硬约束）
- **产出物总量**：investigate 725 行 + architecture-cut 1140 行 = **1865 行分析报告**

---

## 二、发现并修复的 Workflow Bug（11 个）

按发现顺序排列：

### Bug #1: CONTRACT_RE 误解析（Critical）

**症状**：所有 sprint 的 contract 检查永远失败（contractDoneItems: 0/N），导致 investigate 无法 advance。

**根因**：正则 `[\s\S]*?`（非贪婪）+ 宽泛 lookahead `\n[A-Z][A-Z_ ]+:\s` 匹配到正文中的 "contract" 一词，捕获了 CODE_EVIDENCE 区域的 7 条代码注释而非 spec 的 5 条 deliverables。

**修复**（commit `e6e0dac`）：改为 `## CONTRACT` markdown 标题锚定 + 贪婪捕获到文件末尾。

**验证**：187/187 测试通过；真实 sprint 产出从 0/7 变为 11/11 DONE。

---

### Bug #2: Status Parser 只认 spec 格式（Suggestion）

**症状**：agent 写 `key: DONE — description` 被标为 UNKNOWN。

**根因**：只匹配 `status:\s*(DONE|PARTIAL|TODO)`，不兼容 agent 的输出格式变体。

**修复**（commit `cfbad0a` → `02c99c3` → `7b092af`）：添加 3 种 fallback 正则 + `statusGroup` 追踪正确捕获组。

| Fallback | 匹配格式 | 示例 |
|----------|----------|------|
| Primary | `key status: DONE` | `transport_audit status: DONE` |
| Fallback 1 | `key: DONE — description` | `transport_audit: DONE — runtime_direct only` |
| Fallback 2 | `key: DONE` | `transport_audit: DONE` |
| Fallback 3 | `key: DONE（行尾无内容）` | `transport_audit: DONE` |

**验证**：11 条 deliverables 全部正确识别为 DONE。

---

### Bug #3: SSH 断开杀死整个进程树（Critical）

**症状**：sprint 在 SSH 断开后全部进程死亡，sprint.json 状态仍为 `running`（幽灵状态）。

**根因**：SSH 断开发送 SIGHUP → bash 杀死子进程 → orchestrator 进程死亡 → 其子进程（acpx → agent）级联死亡。

**修复**（commit `1e189e5`）：
1. 模块级注册 `process.on('SIGHUP', () => {})` 忽略 SIGHUP
2. 所有 spawn 调用添加 `detached: true` 使子进程进入新会话组

---

### Bug #4: Windows 路径污染 Linux 环境（Critical）

**症状**：`spawn ENOENT`，但 acpx 二进制确实存在。

**根因**：Spec 文件中所有路径都是 Windows 格式（`D:/Code/principles`），当 orchestrator 传给 spawn 的 `cwd` 参数是 Windows 路径时，spawn 找不到目录直接报错。

**影响范围**：8 个 spec 文件，涉及 `workspace`、`branchWorkspace`、context 注释中的 openclaw 路径。

**修复**（commit `8382f78`）：批量替换所有 `D:/Code/*` → `/home/csuzngjh/code/*`。

---

### Bug #5: 跨环境路径不兼容（Suggestion）

**症状**：在 Windows 创建的 spec 无法在 Linux 使用，反之亦然。

**根因**：Spec 文件硬编码绝对路径，没有环境适配。

**修复**（commit `6536dd0`）：在 `task-specs.mjs` 中新增 `PATH_MAP` + `normalizeSpecPaths()`，加载 spec 时自动转换：
- Linux: `D:/Code/principles` → `/home/csuzngjh/code/principles`
- Windows: `/home/csuzngjh/code/principles` → `D:/Code/principles`

---

### Bug #6: acpx 二进制路径解析失败（Suggestion）

**症状**：在 cron/nohup 环境下 PATH 不完整，`spawn('acpx', ...)` 找不到二进制。

**修复**（commit `f87ad18`）：
1. 模块启动时用 `spawnSync('which', ['acpx'])` 预解析完整路径
2. 用 `nodeBin`（`process.execPath`）直接执行 acpx，绕过 PATH 查找
3. `acpxEnv` 中设置完整 PATH（`/usr/local/bin:/usr/bin:/bin`）

---

### Bug #7: detached spawn ENOENT 未被捕获（Suggestion）

**症状**：`spawn()` 在 `detached: true` 模式下不抛同步异常，而是返回 `proc.pid = undefined` 并异步发 error 事件。

**根因**：Node.js 的 `spawn()` 在 `detached: true` 时的 ENOENT 行为与 `detached: false` 不同。

**修复**（commit `7c74502`）：所有 spawn 调用后检查 `if (!proc.pid)` 立即回退到 bare 'acpx' 字符串。

---

### Bug #8: 孤儿进程未清理（Suggestion）

**症状**：resume 时，前一次运行残留的 acpx queue-owner daemon 可能干扰新运行。

**根因**：acpx 的 queue-owner 进程是 `detached: true` + `unref()` 的 daemon，会脱离父进程生命周期。

**修复**（commit `e01c5bc`）：`reconcileRunState()` 中新增 `cleanupAcpxOrphans()`，执行 `acpx <agent> sessions close` 清理残留。

---

### Bug #9: 进程组 kill 不完整（Suggestion）

**症状**：`terminateProcessTree()` 只杀直接子进程，`detached: true` 的孙进程成为孤儿。

**修复**（commit `7b092af`）：Linux 用 `process.kill(-pid, 'SIGKILL')` 杀整个进程组（负 PID = 进程组），fallback 到直接 kill。

---

### Bug #10: 失败日志缺少退出码信息（Suggestion）

**症状**：agent 失败时只记录 `exitStatus`，不区分 timeout / crash / permission 等语义类型。

**修复**（commit `e01c5bc`）：
- 映射 acpx 退出码 → 语义错误类型
  - 3 = `timeout`
  - 4 = `no_session`
  - 5 = `permission_denied`
  - 130 = `interrupted`
  - 2 = `usage_error`
  - 1 = `runtime_error`
- 失败日志新增 `exitCode` 和 `errorType` 字段
- 异常对象附加 `acpxExitCode` 和 `acpxErrorType` 属性

---

### Bug #11: 启动前无预检（Suggestion）

**症状**：agent 二进制不存在时，sprint 等超时才发现。

**修复**（commit `e01c5bc`）：sprint 启动前 `which` 检查所有配置的 agent，失败立即报错。

---

### Bug #12: 缺少 acpx 原生特性利用（Enhancement）

**发现**：acpx 本身提供了 `--prompt-retries` 和 `--suppress-reads` 特性，但 orchestrator 未利用。

**修复**（commit `30f4539`）：
- `--prompt-retries 2`：acpx 原生指数退避重试（1s→2s→4s→...→30s）
- `--suppress-reads`：隐藏大文件读取内容，减少 stdout 体积

**跳过特性**：`--allowed-tools` 和 `--max-turns` — 不限制 agent 能力。

---

## 三、未修复的问题

### 问题 #1: Agent 格式合规率低

**表现**：
- Producer 偶尔缺少 spec 要求的章节（EVIDENCE、HYPOTHESIS_MATRIX）
- Reviewer 偶尔漏掉 MACRO_ANSWERS 章节
- Global Reviewer 偶尔漏掉 CODE_EVIDENCE

**归因**：**agent behavior issue**，不是 workflow bug。Spec 要求的章节格式 agent 不能 100% 遵守。

**影响**：触发 contract validation failure → revise → 消耗额外轮次。

**当前缓解**：
- contract validation 正确检测到缺失并拒绝
- revise 机制允许 agent 重新生成
- 但这意味着每个 sprint 至少多花 1-2 轮

**建议**：在 prompt 中更强调章节格式要求，或在 spec 中减少 required sections 数量。

---

### 问题 #2: Reviewer 过于温和

**表现**：在所有完成的 sprint 轮次中，reviewer verdict 几乎全是 **APPROVE**。

| 轮次 | Reviewer A | Reviewer B | Global Reviewer |
|------|-----------|-----------|-----------------|
| investigate r3 | APPROVE (5/5/5) | APPROVE (4/4/4) | N/A |
| architecture-cut r5 | APPROVE (4/4/5/5) | **REVISE** (4/3/4/4) | APPROVE |

**问题**：Reviewer 很少真正挑战 producer 的结论。architecture-cut 的 reviewer B 是唯一的 REVISE（指出了 contract inflation），但仍然被其他两个 APPROVE 淹没。

**影响**：失去了 multi-reviewer 系统的"阻尼器"价值——如果 reviewer 总是 APPROVE，那和单个 reviewer 没有区别。

**建议**：
- 调整 reviewer prompt，强制要求至少提出 1-2 个质疑
- 或在 spec 中增加"必须发现至少 N 个潜在问题"的要求

---

### 问题 #3: iflow agent 不稳定

**表现**：reviewer_b (iflow + glm-5) 在 3/5 次运行中崩溃退出（status 1，无错误日志）。

**影响**：导致 reviewer 缺位 → missing reports → sprint halted。

**当前缓解**：
- reviewer 超时独立计时，一个超时不阻塞另一个
- 但两个同时失败（iflow + claude）则无法恢复

**建议**：
- 调查 iflow 崩溃原因（可能是 API 连接问题）
- 或考虑切换 reviewer_b 到更稳定的 agent

---

### 问题 #4: 单次 sprint 成本极高

**数据**：deep-reflect sprint 跑了 2 个阶段 × 平均 4 轮 × 4 个角色 = 32 次 agent 调用。

| 阶段 | 轮次 | 角色调用 | 耗时 |
|------|------|---------|------|
| investigate | 3 轮 | 3 角色 × 3 = 9 | ~15 分钟 |
| architecture-cut | 5 轮 | 4 角色 × 5 = 20 | ~30 分钟 |

**影响**：每次 sprint 成本约 45 分钟 × agent 配额。对于一个小 bug 调查来说过于昂贵。

**建议**：
- 简单任务用 `workflow-validation-minimal` 的 1-stage 模式
- 复杂任务才用完整 6-stage 模式
- 考虑减少默认 maxRoundsPerStage（从 3 降到 2）

---

### 问题 #5: sprint 没有产生实际的代码变更

**观察**：所有 15+ 个 sprint run 中，**没有一次产生过代码提交**。

- investigate 阶段产出的是分析报告
- architecture-cut 产出的是架构设计文档
- 还没有跑到 implement-pass-1（实现阶段）

**原因**：
1. workflow 本身在正常工作（状态机、编排、决策都在执行）
2. 但 halt 发生在 implement 之前
3. 这意味着 sprint 系统目前只完成了"调查和设计"，没有完成"实施和验证"

**建议**：
- 下一步目标是让 sprint 跑到 `implement-pass-1` 阶段
- 为此需要先解决 agent 稳定性问题（reviewer crash）

---

## 四、acpx 特性深度分析

### 4.1 支持的 Agent/模型（18 种内置）

acpx 内置 18 种 agent 适配器，包括：codex、claude、pi、openclaw、iflow、gemini、cursor、copilot、droid、kilocode、kimi、kiro、opencode、qoder、qwen、trae。

### 4.2 可直接利用的特性

| 特性 | 说明 | 状态 |
|------|------|------|
| `--prompt-retries N` | 指数退避重试瞬态失败 | ✅ 已集成 |
| `--suppress-reads` | 隐藏文件读取内容，减少噪音 | ✅ 已集成 |
| `--format json` | 结构化输出替代 markdown | ⏸ 未集成（改输出格式影响大） |
| `--allowed-tools` | 限制 agent 工具 | ❌ 跳过（限制能力） |
| `--max-turns` | 限制最大轮次 | ❌ 跳过（限制能力） |
| `flow run` | TypeScript 工作流模块 | ⏸ 评估中（不适合多角色投票） |

### 4.3 acpx 不是我们的替代品

acpx 的 `flow run` 是线性 DAG（A → B → C），不支持：
- 多角色并行投票
- 合同验证和决策门控
- 阶段级 revise 重试

**结论**：acpx 是 agent runner，不是 orchestrator。我们的编排器需要保留。

---

## 五、成本效益分析

### 5.1 投入

| 项目 | 数量 |
|------|------|
| 代码修复 commit | 12 个 |
| 代码变更行数 | ~400 行 |
| Sprint 运行次数 | 15+ |
| Agent 调用次数 | 估计 100+ |
| 调查时间 | ~2 天 |

### 5.2 产出

| 项目 | 数量 | 价值 |
|------|------|------|
| 修复的 workflow bug | 11 个 + 1 个增强 | 高 |
| 有价值的分析报告 | 1 份（deep-reflect architecture-cut） | 高 |
| 发现的技术约束 | 1 个（OpenClawPluginApi 无 sessionId） | **非常高** |
| 完成的 sprint | 0 | 低 |

### 5.3 判断

**workflow 基础设施已就绪，但 agent 质量是瓶颈。**

- 状态机、编排、决策门控、合同验证全部正常工作
- 产出的分析报告质量高（architecture-cut 297 行，发现了关键约束）
- 但 agent 格式合规率低、reviewer 过于温和、iflow 崩溃
- 这些是 agent 质量问题，不是 workflow bug

---

## 六、建议的下一步

### 短期（本周）

1. **调整 reviewer prompt**：强制要求至少提出 1-2 个质疑
2. **减少 required sections**：从 8 个减少到 5 个，降低格式合规门槛
3. **调查 iflow 崩溃**：查看 iflow 内部日志

### 中期（两周内）

4. **让 sprint 跑到 implement-pass-1**：验证代码修改和 test 验证流程
5. **减少默认 maxRoundsPerStage**：从 3 降到 2，控制成本
6. **建立失败归因分类**：workflow bug / agent behavior / environment / spec issue

### 长期

7. **评估 flow run 替代部分 sprint**：简单任务用 flow，复杂任务用 sprint
8. **建立 sprint 质量评分体系**：不是跑了就行，要看产出是否有用
