# User Pain Engine 可执行开发任务清单

> 基于 `docs/design/user-pain-engine.md (v1.2.0)` 的工程化落地拆解。
> 目标：将“设计方案”转成可逐步交付、可验证、可回滚的开发任务。

---

## 0. 范围定义（本轮实现边界）

### In Scope
- Prompt 注入（共情约束）
- `llm_output` 情绪信号识别与计分
- 来源校验、去重、限流、分级惩罚
- 事件审计字段扩展
- `before_message_write` 内部标签净化
- `/pd-status` 情绪事件可观测指标（最小集）

### Out of Scope（后续阶段）
- 正向奖励通道（`USER_DELIGHT_DETECTED`）
- 多模型 ensemble 情绪校验
- 跨会话长期个性化情绪画像

---

## 1. 里程碑计划（建议按 PR 拆分）

- **M1（基础链路可跑通）**：P0-1 ~ P0-4
- **M2（风控完整）**：P0-5 ~ P0-8
- **M3（体验与可观测）**：P1-1 ~ P1-7
- **M4（稳定性与优化）**：P2-1 ~ P2-3

---

## 2. 任务分解（Backlog）

## P0（必须项，先做）

### P0-1 Prompt 注入共情约束
**目标文件**
- `packages/openclaw-plugin/src/hooks/prompt.ts`

**实现内容**
- 在 `before_prompt_build` 中新增/合并共情引擎指令。
- 稳定规则注入 `prependSystemContext`；动态提醒放 `prependContext`。
- 新增开关：`empathy_engine.enabled`（默认 true）。
- 明确“安抚协议”模板：不是只道歉，而是“承认情绪 + 安抚短句 + 纠偏承诺 + 让用户选择”。

**验收标准**
- 当开关开启时，注入文本稳定存在且不破坏原有 prompt 结构。
- 注入内容中包含“安抚协议”四要素，而非仅道歉。
- 当开关关闭时，不注入任何共情相关指令。

**测试**
- 单测：`prompt` hook 输出快照测试（开/关两种配置）。
- 单测：安抚协议文案存在性断言（四要素关键词）。
- 回归：不影响已有 Evolution/Trust 注入逻辑。

---

### P0-2 `llm_output` 基础情绪识别器（MVP）
**目标文件**
- `packages/openclaw-plugin/src/hooks/llm.ts`

**实现内容**
- 新增 `extractEmpathySignal(text)`：
  - 优先识别结构化片段（例如 `<empathy signal="...">` 或约定 JSON 片段）
  - fallback 识别 legacy 标签 `[EMOTIONAL_DAMAGE_DETECTED]`
- 产出统一对象：
  - `detected`, `severity`, `confidence`, `reason`, `mode`

**验收标准**
- 对规范输入可稳定识别。
- 对无关文本不会误报 `detected=true`。

**测试**
- 单测：10+ 组输入（结构化/legacy/空文本/噪声）。

---

### P0-3 情绪惩罚分级映射
**目标文件**
- `packages/openclaw-plugin/src/hooks/llm.ts`
- `packages/openclaw-plugin/src/core/config.ts`（或配置服务）

**实现内容**
- 新增配置节点（默认值）：
  - `empathy_penalties.mild=10`
  - `empathy_penalties.moderate=25`
  - `empathy_penalties.severe=40`
- 新增 `mapSeverityToPenalty()`

**验收标准**
- severity → 分值映射稳定且可配置覆盖。
- 配置缺失时回退默认值并记录一次 warning。

**测试**
- 单测：默认值、覆盖值、非法值回退。

---

### P0-4 接入 pain 记录链路
**目标文件**
- `packages/openclaw-plugin/src/hooks/llm.ts`
- `packages/openclaw-plugin/src/core/event-log.ts`

**实现内容**
- 在命中情绪信号后执行：
  - `trackFriction(...)`
  - `eventLog.recordPainSignal(...)`
- 增加 `source: 'user_empathy'` 分类。

**验收标准**
- 触发后 GFI 实际增加。
- pain 事件可在日志中查到。

**测试**
- 集成测试：模拟 `llm_output` 事件，验证 GFI 与日志落盘。

---

### P0-5 来源校验（assistant vs user manual）
**目标文件**
- `packages/openclaw-plugin/src/hooks/llm.ts`

**实现内容**
- 仅对 assistant 输出信号走主惩罚链路。
- 用户主动注入标签走 `manual_pain_request`（低权重或仅审计）。

**验收标准**
- assistant 信号触发主惩罚。
- user 注入不会按同权重触发。

**测试**
- 单测：origin 分支覆盖。

---

### P0-6 去重 + 限流
**目标文件**
- `packages/openclaw-plugin/src/hooks/llm.ts`
- 会话状态/缓存模块（必要时新增）

**实现内容**
- `dedupe_window_ms`（默认 60000）
- `rate_limit.max_per_turn`（默认 40）
- `rate_limit.max_per_hour`（默认 120）

**验收标准**
- 短时间重复信号只记一次。
- 高频触发不超过上限。

**测试**
- 单测：窗口命中、跨窗口、每轮/每小时上限。

---

### P0-7 审计字段扩展
**目标文件**
- `packages/openclaw-plugin/src/core/event-log.ts`
- `packages/openclaw-plugin/src/types/event-types.ts`

**实现内容**
- pain signal 增加字段：
  - `origin`
  - `severity`
  - `confidence`
  - `detection_mode`
  - `deduped`
  - `trigger_text_excerpt`

**验收标准**
- 新字段序列化后可读、可回放。
- 旧数据结构兼容（不崩溃）。

**测试**
- 单测：schema 兼容与默认值补齐。

---

### P0-8 配置模板与初始化迁移
**目标文件**
- `packages/openclaw-plugin/templates/pain_settings.json`
- `packages/openclaw-plugin/src/core/init.ts`
- `packages/openclaw-plugin/src/core/migration.ts`

**实现内容**
- 将 empathy 配置默认值加入模板。
- 老用户升级场景自动补齐缺省配置（不覆盖用户已配置值）。

**验收标准**
- 新安装有完整配置。
- 老安装升级后配置可平滑迁移。

**测试**
- 单测：初始化复制、迁移补齐、幂等性。

---

## P1（重要项，M3）

### P1-1 `before_message_write` 标签净化
**目标文件**
- `packages/openclaw-plugin/src/index.ts`
- `packages/openclaw-plugin/src/hooks/message-sanitize.ts`（新增）

**实现内容**
- 注册 `before_message_write` hook。
- 对 assistant message 做内部标签清洗（删除/替换）。

**验收标准**
- 用户可见消息不出现内部控制标签。
- 不影响原始分析链路所需信息。

**测试**
- 单测：message 改写；非 assistant message 不误改。

---

### P1-2 `/pd-status` 指标扩展（最小可用）
**目标文件**
- `packages/openclaw-plugin/src/commands/status*.ts`（按实际文件）

**实现内容**
- 增加情绪事件面板：
  - 24h 触发次数
  - severity 分布
  - dedupe 命中率

**验收标准**
- 指标可正确读取 event log。

**测试**
- 单测：统计计算正确。

---

### P1-3 误触发回滚命令
**目标文件**
- `packages/openclaw-plugin/src/commands/pain.ts`（或新增命令）

**实现内容**
- 提供最近一次情绪惩罚回滚能力（有审计记录）。

**验收标准**
- 回滚后 GFI 反向修正，并记录 `rollback_reason`。

**测试**
- 集成测试：触发→回滚→校验状态。

---

### P1-4 情绪安抚话术策略与配置化
**目标文件**
- `packages/openclaw-plugin/src/hooks/prompt.ts`
- `packages/openclaw-plugin/templates/pain_settings.json`

**实现内容**
- 增加 `empathy_soothing_templates` 配置，按 `mild/moderate/severe` 选择响应模板。
- 增加 anti-repetition 机制（最近 N 轮避免重复同一句安抚话术）。

**验收标准**
- 不同 severity 下能输出不同强度安抚语。
- 连续 3 轮触发不出现完全相同安抚句。

**测试**
- 单测：模板选择逻辑与去重逻辑。

---

### P1-5 文档同步
**目标文件**
- `docs/design/user-pain-engine.md`
- `packages/openclaw-plugin/docs/COMMAND_REFERENCE*.md`
- `packages/openclaw-plugin/ADVANCED_CONFIG_ZH.md`

**实现内容**
- 将“方案”更新为“已实现能力 + 配置说明 + 限制说明”。

**验收标准**
- 文档与代码一致，无“承诺未实现项”。

---

### P1-6 Empathy Panel（`/pd-status` 交互增强）
**目标文件**
- `packages/openclaw-plugin/src/commands/status*.ts`
- `packages/openclaw-plugin/src/core/event-log.ts`

**实现内容**
- 新增面板区块：
  - 情绪温度计（24h severity 分布）
  - 最近触发原因（含 origin）
  - 纠偏进度卡（承诺动作执行状态）
  - 回滚入口提示

**验收标准**
- `/pd-status` 可直接解释“为什么被惩罚、现在该怎么办”。

**测试**
- 单测：统计聚合与展示文案快照。

---

### P1-7 快捷指令集（`/pd-empathy`）
**目标文件**
- `packages/openclaw-plugin/src/commands/`（新增 `empathy.ts`）
- `packages/openclaw-plugin/src/index.ts`

**实现内容**
- 新增命令：
  - `/pd-empathy status`
  - `/pd-empathy calm`
  - `/pd-empathy rollback`
  - `/pd-empathy config`
  - `/pd-empathy mute <minutes>`
- 命令输出统一采用“状态 + 建议下一步”格式。

**验收标准**
- 命令可执行且具备权限/参数校验。
- `mute` 到期自动恢复惩罚策略。

**测试**
- 单测：参数解析、状态读写、超时恢复。
- 集成测试：命令触发后对惩罚链路的行为影响。

---

## P2（增强项，M4）

### P2-1 检测质量评估脚本
- 离线样本集评估 precision/recall，辅助调参。

### P2-2 A/B 试验开关
- 固定分值 vs 分级分值。

### P2-3 正向奖励通道
- `USER_DELIGHT_DETECTED` 与 trust 修复联动。

---

## 3. 建议 PR 切分（避免大爆炸）

- **PR-1**: P0-1, P0-2（只做注入 + 识别，不改计分）
- **PR-2**: P0-3, P0-4（计分接入）
- **PR-3**: P0-5, P0-6（风控）
- **PR-4**: P0-7, P0-8（审计与配置迁移）
- **PR-5**: P1-1（消息净化）
- **PR-6**: P1-2, P1-3, P1-4, P1-5（可观测 + 回滚 + 安抚配置 + 文档）
- **PR-7**: P1-6, P1-7（交互面板 + 快捷指令）

每个 PR 要求：
- 必须附带对应测试
- 必须更新变更说明
- 必须给出回滚策略

---

## 4. Definition of Done（整体）

满足以下条件才算功能落地完成：
1. 情绪识别能稳定触发且误报受控。
2. GFI 惩罚具备来源校验/去重/限流/分级。
3. 事件日志可审计、可回放、可回滚。
4. 用户界面无内部控制标签污染。
5. `/pd-status` 可以解释“为什么被惩罚”。
6. 文档与代码一致，包含配置与运维说明。
7. 用户可通过面板/快捷指令主动查看与干预情绪引擎行为。

---

## 5. 风险与回滚预案

### 风险
- 误触发导致 GFI 偏高
- 配置缺失导致行为异常
- 历史日志结构兼容问题

### 回滚
- 提供 feature flag：`empathy_engine.enabled=false`
- 保留 legacy 逻辑开关：`empathy_engine.legacy_tag_only=true`
- 保留数据迁移前备份

---

## 6. 建议首周执行顺序

Day 1-2: PR-1  
Day 3: PR-2  
Day 4: PR-3  
Day 5: PR-4  

第二周进入 PR-5/PR-6。



补充：第三周进入 PR-7（交互面板 + 快捷指令）。
