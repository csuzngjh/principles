# PD 错误处理架构 (Error Handling Architecture)

> **状态**: Active
> **最后更新**: 2026-05-09
> **代码实现**: `packages/principles-core/src/runtime-v2/error-categories.ts`

---

## 1. 错误分类体系

PD Runtime V2 使用统一的错误分类体系。所有 PD 组件、适配器、CLI 命令和事件**必须**使用这些类别，不得发明本地错误码。

### 1.1 PDErrorCategory（17 个内部错误码）

| 错误类别 | 说明 | 典型场景 |
|---------|------|---------|
| `runtime_unavailable` | 运行时不可用 | 适配器初始化失败、连接断开 |
| `capability_missing` | 能力缺失 | 运行时不支持结构化 JSON 输出 |
| `input_invalid` | 输入无效 | Task 参数校验失败 |
| `lease_conflict` | 租约冲突 | 并发写入同一 Task |
| `lease_expired` | 租约过期 | Diagnostician 执行超时 |
| `execution_failed` | 执行失败 | 模型返回错误 |
| `timeout` | 超时 | 适配器调用超时 |
| `cancelled` | 已取消 | 用户主动取消 |
| `output_invalid` | 输出无效 | Diagnostician 输出解析失败 |
| `artifact_commit_failed` | 资产提交失败 | 候选写入磁盘失败 |
| `max_attempts_exceeded` | 超过最大重试 | 重试策略耗尽 |
| `context_assembly_failed` | 上下文组装失败 | Pain Chain 查询异常 |
| `history_not_found` | 历史未找到 | 查询不存在的 Run |
| `trajectory_ambiguous` | 轨迹模糊 | 多条轨迹匹配 |
| `storage_unavailable` | 存储不可用 | SQLite 连接失败 |
| `workspace_invalid` | 工作区无效 | 工作区路径不存在 |
| `query_invalid` | 查询无效 | Read Model 查询参数错误 |

### 1.2 FAILURE_CATEGORY_MAP（6 个用户可见类别）

17 个内部错误码映射为 6 个用户可见类别，用于 CLI trace 和 pain-record 命令：

| 用户可见类别 | 对应内部错误码 |
|-------------|--------------|
| `runtime_unavailable` | `runtime_unavailable`, `lease_conflict`, `lease_expired`, `execution_failed`, `context_assembly_failed`, `history_not_found`, `trajectory_ambiguous`, `query_invalid` |
| `config_missing` | `capability_missing`, `input_invalid`, `workspace_invalid` |
| `runtime_timeout` | `timeout`, `cancelled`, `max_attempts_exceeded` |
| `output_invalid` | `output_invalid` |
| `artifact_missing` | `artifact_commit_failed` |
| `ledger_write_failed` | `storage_unavailable` |

---

## 2. 核心错误类

### 2.1 PDRuntimeError

```typescript
class PDRuntimeError extends Error {
  readonly category: PDErrorCategory;
  readonly details?: Record<string, unknown>;

  constructor(category: PDErrorCategory, message: string, details?: Record<string, unknown>) {
    super(`[${category}] ${message}`);
    this.name = 'PDRuntimeError';
    this.category = category;
    this.details = details;
  }
}
```

**使用规范**:
- 适配器和服务在 runtime-v2 路径中应抛出 `PDRuntimeError` 而非通用 `Error`
- `category` 必须是 `PDErrorCategory` 的合法值（`isPDErrorCategory()` 可用于运行时校验，但 `PDRuntimeError` constructor 本身不做校验）
- `details` 用于附加上下文（如 taskId、runId、painSignalId）

### 2.2 已废弃的错误体系

以下旧错误体系已被 `PDRuntimeError` + `PDErrorCategory` 取代：
- `TrinityRuntimeFailureCode`（openclaw-plugin）→ 已废弃
- `TaskResolution`（openclaw-plugin）→ 已废弃（legacy marker-file 值保留为 legacy-only）
- `PdError` 类层级（openclaw-plugin）→ 可包装 `PDErrorCategory`

---

## 3. 错误传播策略

### 3.1 传播原则

1. **向上传播**：错误从底层组件向上传播到调用方
2. **分类包装**：捕获的未知错误应包装为 `PDRuntimeError`，选择最匹配的 `PDErrorCategory`
3. **不吞没**：除非明确设计降级路径，否则不应吞没错误

### 3.2 常见映射

| 底层错误 | 包装为 |
|---------|--------|
| 适配器连接失败 | `PDRuntimeError('runtime_unavailable', ...)` |
| 模型调用超时 | `PDRuntimeError('timeout', ...)` |
| 输出解析失败 | `PDRuntimeError('output_invalid', ...)` |
| SQLite 写入失败 | `PDRuntimeError('storage_unavailable', ...)` |
| 租约获取失败 | `PDRuntimeError('lease_conflict', ...)` |

---

## 4. 降级路径

> **说明**: 以下降级路径描述的是**目标规范 / recommended behavior**，而非当前所有路径的完整实现状态。标注了 ✅ 的路径已有代码实现，标注为 🎯 的路径是推荐行为但尚未统一实现。

### 4.1 Pain Chain 降级

```
PainSignalBridge
    │
    ├── 正常路径: PainSignal → Task → Run → Candidate → Ledger
    │
    └── 降级路径:
        ├── Bridge 调用失败 → PDRuntimeError('runtime_unavailable') → 返回 skipped ✅
        ├── Lease 超时 → PDRuntimeError('lease_expired') → RecoverySweep 重试 ✅
        └── 上下文组装失败 → PDRuntimeError('context_assembly_failed') → 返回 partial 🎯
```

### 4.2 Diagnostician 降级

```
DiagnosticianRunner
    │
    ├── 正常路径: Prompt → Output → Validate → Commit
    │
    └── 降级路径:
        ├── 超时 → PDRuntimeError('timeout') → RunnerResult.status = 'timed_out' ✅
        ├── 解析失败 → PDRuntimeError('output_invalid') → 尝试修复 → 仍失败则返回 ✅
        └── 最大重试 → PDRuntimeError('max_attempts_exceeded') → 返回失败 ✅
```

### 4.3 Storage 降级

```
Store Operations
    │
    ├── 正常路径: SQLite 同步写入 → 返回成功
    │
    └── 降级路径:
        ├── 写入失败 → PDRuntimeError('storage_unavailable') → 调用方决定重试或失败 🎯
        ├── 读取失败 → ResilientContextAssembler / ResilientHistoryQuery 自动重试 ✅
        └── 锁获取失败 → PDRuntimeError('lease_conflict') → 等待重试 🎯
```

> **注意**: `Resilient*` 包装器（`ResilientContextAssembler`、`ResilientHistoryQuery`）是读侧/上下文降级包装，不是通用写入重试。SQLite store 写失败通常直接抛出 `PDRuntimeError('storage_unavailable')`，由调用方决定重试策略。

---

## 5. 相关文档

| 文档 | 说明 |
|------|------|
| [PD_SYSTEM_ARCHITECTURE.md](./PD_SYSTEM_ARCHITECTURE.md) | 系统架构蓝图 |
| [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md) | 数据存储架构 |
| [ADR-0001](../adr/0001-runtime-v2-service-boundaries.md) | Runtime V2 Service Boundaries |
