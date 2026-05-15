# ADR-0007: pd-cli 与 pd-console 受众分离

> **状态**: Accepted
> **日期**: 2026-05-15
> **关联 ADR**: ADR-0001（服务边界）, ADR-0006（混合激活）
> **关联文档**: `PD_ARCHITECTURE_OVERVIEW.md` §2.2, `COMPONENTS.md` §5

## 1. 背景

PD 系统有两个用户交互入口：`pd-cli` 和 `pd-console`。这两个包同时存在，但**职责边界一直没有清晰定义**，造成的实际问题：

### 1.1 现状混乱

- `pd-cli` 与 `pd-console` 都试图覆盖"读取系统状态"的能力，导致功能重复
- 高风险写操作（比如批准 / 拒绝）的归属不明，曾经在 `pd-cli` 提供过 approve 命令，又被注释掉
- 文档对两者的描述不统一：有的说 cli 是 UX 入口，有的说 console 是入口
- 两个包的命令命名风格不一致，输出格式也不统一
- 团队在添加新功能时不知道该加到哪一边

### 1.2 用户实际诉求差异

经过调研，**两类用户的需求显著不同**：

| 维度 | AI 代理（OpenClaw / Codex / Gemini）| 人类（开发者 / 运维 / 研究员）|
|------|----------------------------------|--------------------------|
| 进入方式 | 命令行调用 | Web UI |
| 输入风格 | 结构化参数 + JSON | 表单、点击、可视化 |
| 输出消费 | JSON 解析 | 视觉浏览 |
| 操作场景 | 自动化任务（每秒级触发）| 交互式（每分钟级）|
| 典型操作 | 查询状态、记录信号、推动流水线 | 审批、复盘、调优、可视化 |
| 容错风格 | 失败即结构化报错 | 友好提示 + 上下文 |
| 高风险审批 | **不应**有审批权 | **必须**经过 |
| 长任务 | 不适合（CLI 短生命周期）| 适合（WebSocket 流）|

混合在一个入口处理这两类需求，会导致：
- CLI 输出既不够结构化（需考虑人类阅读）也不够丰富（受 stdout 限制）
- Console 又被迫支持自动化场景（如需要 token 鉴权）

---

## 2. 决策

**`pd-cli` 与 `pd-console` 按受众严格分离，互不重叠。**

### 2.1 角色定义

#### 2.1.1 pd-cli（for AI Agent）

- **目标用户**：在 PD 中运行的 AI 代理（OpenClaw 主代理、子代理、Codex CLI 代理、Gemini CLI 代理等）
- **设计目标**：结构化、低延迟、易自动化
- **进程模型**：单次执行（启动 → 处理 → 退出）
- **覆盖能力**：
  - **全部读侧能力**：所有 ReadModel 通过 CLI 命令暴露
  - **低风险写**：记录 PainSignal、入队 Pain → Diagnostician 任务、低风险通道激活查询
  - **触发流水线**：`pd runtime internalization-wake-once` 等
- **不允许**：
  - 高风险审批（approve / reject）
  - 配置篡改
  - 双人审批的任一步骤
  - 长连接 / 流式输出

#### 2.1.2 pd-console（for Human）

- **目标用户**：开发者、运维、安全审计员、研究员
- **设计目标**：可视化、交互式、低误操作率
- **进程模型**：长生命周期 Web Server（默认 `localhost:18789`）
- **覆盖能力**：
  - **全部读侧能力**：可视化展示所有 ReadModel
  - **高风险审批**：所有 ApprovalQueue 操作（approve / reject / second-confirm）
  - **配置变更**：通过明确确认的 UI 流程
  - **长任务流式输出**：流水线运行实时跟踪
  - **审计日志查询与导出**
- **不必支持**（避免重复 cli）：
  - 简单命令式自动化
  - 纯 JSON 输出（可有 API，但不是主要交互形式）

### 2.2 能力矩阵（明确归属）

| 能力 | pd-cli | pd-console | 备注 |
|------|--------|-----------|------|
| 查询任务状态 | ✅ | ✅ | 重叠：cli 是 JSON，console 是可视化 |
| 查询痛苦链 | ✅ | ✅ | 同上 |
| 查询健康度 | ✅ | ✅ | 同上 |
| 查询配置 | ✅ | ✅ | 同上 |
| 触发 wakeOnce | ✅ | ❌ | 自动化场景 |
| 记录 PainSignal | ✅ | ❌ | 通常由代理触发 |
| 列出待审批 | ✅（read-only）| ✅ | cli 仅查看，不操作 |
| **批准 / 拒绝审批** | ❌ | ✅ | 仅 console |
| **二次确认（model_training）** | ❌ | ✅ | 仅 console |
| 修改 config | ❌ | ✅ | 仅 console（带审计）|
| 查看审计日志 | ✅ | ✅ | cli 输出 JSON，console 可视化 |
| Pruning Review 操作 | ❌ | ✅ | 仅 console |
| Principle 回滚 | ❌ | ✅ | 仅 console（高风险）|
| Implementation 启用/禁用 | ❌ | ✅ | 仅 console（高风险）|
| 数据迁移（legacy import）| ✅ | ❌ | 自动化任务 |
| 启动流水线（manual run）| ✅ | ✅ | 都支持，console 提供 UI |
| 查看流水线进度 | ✅ | ✅ | console 流式更友好 |

**核心规则**：

- **读侧**：两边都可有，互不影响
- **低风险写**：偏 cli（自动化场景多）
- **高风险写**（影响代理行为或不可逆变更）：**仅 console**

### 2.3 实现约束

#### 2.3.1 强制约束（架构守护）

| ID | 约束 | 强制方式 |
|----|------|---------|
| AUD-1 | pd-cli **不得**调用 `ApprovalQueue.approve` / `.reject` / `.secondConfirm` | architecture-regression test |
| AUD-2 | pd-cli **不得**直接写入 `Ledger.principles[*].status = 'active'` 之外的写操作（绕过 ActivationDispatcher）| architecture-regression test |
| AUD-3 | pd-console **不得**做后台任务调度（这是 plugin / cli 的事）| architecture-regression test |
| AUD-4 | 任何审批操作必须通过 pd-console 的 `/approvals` UI | code review + ApprovalQueue 检查 actor.kind |
| AUD-5 | pd-cli 所有命令支持 `--json` 输出 | 命令模板强制 |
| AUD-6 | pd-cli 所有命令的 exit code 遵守约定（0/1/2）| 命令模板强制 |

#### 2.3.2 ApprovalQueue 的 actor 校验

```typescript
// @principles/core/runtime-v2/activation/approval-queue.ts
async approve(approvalId, approver, note?): Promise<...> {
  // ★ 强制：actor.kind must be 'human'
  // 通过校验 approver 来源（必须从 pd-console session 获取，不接受 cli flag）
  if (this.callerKind !== 'console') {
    throw new PDRuntimeError(
      'capability_missing',
      'Approval operations require human actor via pd-console',
    );
  }
  // ...
}
```

实现机制：
- `ApprovalQueue` 实例有 `callerKind: 'cli' | 'console' | 'system'` 标识
- pd-cli 创建实例时传 `callerKind = 'cli'`，限制在只读方法
- pd-console 创建实例时传 `callerKind = 'console'`，开启写入方法

### 2.4 命名规范

#### 2.4.1 pd-cli 命令命名

```
pd <noun> <verb> [args]
pd <verb> [args]               # 简单情况

例：
pd task list
pd task show <id>
pd diagnose run --pain <painId>
pd runtime internalization-wake-once
pd activation list             # 仅查看
pd activation status <artifactId>
```

输出格式：

```bash
pd task list                   # 文本（人类可读）
pd task list --json            # JSON（代理消费）
```

约定：

- 名词单数复数统一：列表用复数（`tasks`）
- 动词使用：list / show / run / record / query / verify
- 子命令层级最多 2 层
- 全局 flag：`--workspace`, `--json`, `--quiet`, `--verbose`

#### 2.4.2 pd-console 路由命名

```
/{noun}                        — 列表
/{noun}/{id}                   — 详情
/{noun}/{id}/{action}          — 操作

例：
/approvals
/approvals/{id}
/approvals/{id}/approve
/principles
/principles/{id}
/principles/{id}/rollback
```

### 2.5 输出格式约定

#### 2.5.1 pd-cli 的 JSON 输出

```json
{
  "ok": true,
  "command": "task.list",
  "data": [...],
  "meta": {
    "workspaceDir": "...",
    "timestamp": "...",
    "version": "1.10.X"
  }
}
```

错误输出：

```json
{
  "ok": false,
  "command": "task.show",
  "error": {
    "category": "input_invalid",
    "message": "Task not found",
    "details": { "taskId": "..." }
  }
}
```

Exit code：

| Code | 含义 |
|------|-----|
| 0 | 成功 |
| 1 | 用户错误（参数错、查不到等）|
| 2 | 系统错误（连接失败、内部 bug）|

#### 2.5.2 pd-console 的 REST API

为 UI 提供 JSON API，但**不**作为公开 API（仅自用）：

```
GET  /api/approvals                列表
GET  /api/approvals/:id            详情
POST /api/approvals/:id/approve    操作
```

### 2.6 鉴权与会话

#### 2.6.1 pd-cli

- 信任本地 OS 用户
- `actor.kind = 'agent'`，agentId 通过 `--agent <id>` 提供（必填）或从 `PD_AGENT_ID` 环境变量读取
- 不需要密码 / token

#### 2.6.2 pd-console

- 信任本地（`localhost`）连接
- 当前简化：单用户模式，通过 OS 用户名识别
- `actor.kind = 'human'`，userId 取自 OS 用户名
- 远程访问场景：未来可加 token 鉴权（不在本 ADR 范围）

---

## 3. 冲突解决

### 3.1 历史功能的归属调整

| 现状 | 调整 |
|------|-----|
| pd-cli 中曾有 approve / reject 命令（已注释）| 永久删除 |
| pd-cli 的 `pd activation list` | 保留（仅只读）|
| pd-cli 的 `pd config set`（如果存在）| 保留，但仅低风险字段；高风险字段必须经 console |
| pd-console 的批量自动化能力 | 删除，不要做 |
| pd-console 的命令式 API（无 UI）| 仅作为 UI 后端，不公开 |

### 3.2 新功能加在哪一边

判断流程：

```
功能涉及高风险操作？
   │ Yes → pd-console
   │ No
   ▼
功能是只读查询？
   │ Yes → 两边都加（cli 简洁，console 可视化）
   │ No
   ▼
功能需要长连接 / 流式输出？
   │ Yes → pd-console（cli 退化为触发器）
   │ No
   ▼
功能是自动化场景（CI / agent）？
   │ Yes → pd-cli
   │ No → pd-console
```

---

## 4. 后果（Consequences）

### 4.1 收益

- **职责清晰**：用户和开发者都知道找哪个工具
- **安全提升**：高风险操作天然集中在 console，便于加审计 / 鉴权
- **可演进**：未来加新功能不再纠结归属
- **减少冗余**：写侧操作不再重复实现
- **代理体验稳定**：cli 接口稳定，console 可灵活迭代 UI

### 4.2 代价

- **现有代码调整**：约 5-8 个文件需重构（移除 cli 写入命令）
- **培训成本**：团队需理解新的归属规则
- **文档更新**：所有提及 cli/console 的文档需对齐

### 4.3 不变项

- 两者继续共用 `@principles/core` 的 Store / ReadModel
- SQLite + 文件并发协调机制不变
- OpenClaw plugin 不受影响

---

## 5. 实施计划

### 阶段 1：清理（约 1 个 Sprint）
- [ ] 移除 pd-cli 中的 approve / reject / 高风险写命令（如有）
- [ ] 在 ApprovalQueue 添加 callerKind 校验
- [ ] 在 architecture-regression test 添加 AUD-1 ~ AUD-6

### 阶段 2：建立 console UI（约 2-3 个 Sprint）
- [ ] `/approvals` 路由（列表 + 详情）
- [ ] `/approvals/:id/approve` 与 `/approvals/:id/reject`
- [ ] `/approvals/:id/second-confirm`（仅 model_training）
- [ ] `/audit` 路由

### 阶段 3：补齐 cli 能力（约 1 个 Sprint）
- [ ] 所有命令支持 `--json`
- [ ] 命令输出格式统一（参见 §2.5.1）
- [ ] exit code 规范化
- [ ] 命令命名审计与重命名（如有不一致）

### 阶段 4：文档与守护（约 1 个 Sprint）
- [ ] 更新 README / OVERVIEW / COMPONENTS
- [ ] architecture-regression test 全部落地

---

## 6. 替代方案（已拒绝）

### 替代方案 A：单一入口（仅 cli 或仅 console）
**拒绝**：两类用户需求差异大，单入口必然有一方体验糟糕。

### 替代方案 B：cli 是 console 的子集
**拒绝**：自动化场景下 console 启动成本太高。

### 替代方案 C：让 cli 可以"模拟人类操作"
**拒绝**：违反"高风险必须人在回路"的核心安全原则。

### 替代方案 D：合并为一个包
**拒绝**：受众完全不同的两套 UI 强行合并会增加复杂度。

---

## 7. 关联

- ADR-0001: Runtime V2 Service Boundaries
- ADR-0006: 混合激活机制（强依赖 console 的审批 UI）
- `PD_ARCHITECTURE_OVERVIEW.md` §2.2（受众矩阵）
- `COMPONENTS.md` §5（cli / console 组件清单）
- `SECURITY_ARCHITECTURE.md` §4（审批控制）
