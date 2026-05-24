# 安全架构（Security Architecture）

> **状态**: Active
> **最后更新**: 2026-05-15
> **关联**: `PD_ARCHITECTURE_OVERVIEW.md` §6.1, `ACTIVATION_CHANNELS.md`, `ADR-0006`

> **ADR-0012 修订（2026-05-23）**: OpenClaw idle/night 触发正在退役。下方 `idle-trigger.yaml` 引用只代表历史审计对象；Runtime V2 执行策略由 PD-owned `runtime-scheduling.yaml` / SDK/operator 边界控制。

本文档定义 PD 系统的安全模型，覆盖工作区隔离、沙箱执行、审批控制、PII 保护、密钥管理、防滥用等维度。

---

## 1. 威胁模型（Threat Model）

PD 是**本地优先**的系统，但仍面临以下威胁：

### 1.1 威胁分类

| ID | 威胁 | 风险等级 | 来源 |
|----|------|---------|------|
| T-1 | LLM 生成恶意代码（RuleHost implementation）| 🔴 高 | code_tool_hook 通道 |
| T-2 | 训练数据污染模型权重 | 🔴 高 | model_training 通道 |
| T-3 | 跨工作区误操作（写错地方）| 🟠 中 | 多 workspace 环境 |
| T-4 | 敏感信息泄漏（PII / API Key）| 🟠 中 | trajectory / log / artifact |
| T-5 | 配置篡改导致安全策略失效 | 🟠 中 | activation.yaml 等 |
| T-6 | 审计日志被篡改 | 🟡 中 | 文件级别访问 |
| T-7 | 并发竞争导致数据损坏 | 🟡 中 | 多进程并发 |
| T-8 | 单点错误（单人审批就批准高风险）| 🔴 高 | 审批流程 |
| T-9 | 拒绝服务（队列堆积导致系统瘫痪）| 🟡 中 | Pain 信号洪水 |
| T-10 | 提示词注入污染 LLM 上下文 | 🟠 中 | 用户消息 / 代码注释 |

### 1.2 安全边界

PD **不**保护：

- 操作系统级安全（依赖 OS）
- 网络传输安全（无远程通信，除非用户显式启用）
- 物理安全（依赖部署环境）
- LLM 模型本身的安全性（依赖 LLM 供应商）

PD **保护**：

- 工作区数据隔离
- LLM 生成代码的执行沙箱
- 高风险变更的审批门控
- 敏感数据的脱敏与最小暴露
- 审计完整性

---

## 2. 工作区隔离（Workspace Isolation）

### 2.1 设计原则

每个 PD 实例**只**操作 `workspaceDir` 范围内的文件。**绝对**不允许跨工作区写入。

### 2.2 强制约束

| ID | 约束 | 强制方式 |
|----|------|---------|
| WS-1 | 所有写操作必须接收 `workspaceDir` 参数 | 类型签名强制（无 default） |
| WS-2 | `workspaceDir` 必须是绝对路径 | `validateWorkspaceDir()` 启动校验 |
| WS-3 | 不允许 `..` 或符号链接逃逸 | path resolve 后检查 prefix |
| WS-4 | 不同工作区使用独立 SQLite 文件 | 物理隔离 |
| WS-5 | Plugin Hook 必须验证 `workspaceDir` 在每个事件 | `resolveToolHookWorkspaceDirSafe()` |
| WS-6 | 跨工作区只读时必须显式声明 | 类型 `ReadOnlyWorkspaceRef` |

### 2.3 实施

#### 2.3.1 路径校验工具

```typescript
// @principles/core/path-resolver.ts
export function validateWorkspacePath(
  workspaceDir: string,
  targetPath: string
): { ok: boolean; reason?: string } {
  const absWorkspace = path.resolve(workspaceDir);
  const absTarget = path.resolve(targetPath);

  // 必须以 workspace 为前缀
  if (!absTarget.startsWith(absWorkspace + path.sep) && absTarget !== absWorkspace) {
    return { ok: false, reason: 'target_outside_workspace' };
  }

  // 不允许符号链接逃逸
  if (fs.existsSync(absTarget)) {
    const realPath = fs.realpathSync(absTarget);
    if (!realPath.startsWith(absWorkspace + path.sep) && realPath !== absWorkspace) {
      return { ok: false, reason: 'symlink_escape' };
    }
  }

  return { ok: true };
}
```

#### 2.3.2 启动健康检查

参见 `plugin/index.ts` 中的 `[PD:health]` 检查：在启动后 1 秒，验证 `resolveToolHookWorkspaceDirSafe()` 能正确解析。

### 2.4 多工作区下的并发协调

详见 `PD_SYSTEM_ARCHITECTURE.md` §4.4。要点：

- SQLite WAL 模式 + LeaseManager 跨进程协调
- atomic file write（write temp + rename）
- 审计日志通过 OS 文件 append 原子性

---

## 3. 沙箱执行（Code Implementation Sandboxing）

### 3.1 适用范围

仅适用于 **`code_tool_hook` 通道激活的 RuleHost implementation**。

LLM 生成的 JavaScript 代码不能直接在主进程上下文执行——必须经过 `node:vm` 受限沙箱。

### 3.2 沙箱设计

#### 3.2.1 受限 vm 上下文

```typescript
// @principles/core/runtime-v2/internalization/rule-implementation-runtime.ts (existing)

import * as vm from 'node:vm';

export function loadRuleImplementationModule(
  source: string,
  filename: string
): RuleImplementationModuleExports {
  const sandbox = {
    module: { exports: {} as any },
    exports: {} as any,
    // 严格白名单：仅暴露 helpers，不暴露任何全局
    require: undefined,
    process: undefined,
    Buffer: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    // 注入 helpers（在 evaluate 时再绑定具体输入）
  };

  const context = vm.createContext(sandbox, {
    name: filename,
    codeGeneration: { strings: false, wasm: false },
  });

  const script = new vm.Script(source, {
    filename,
    importModuleDynamically: undefined, // ★ 禁用动态导入
  });

  script.runInContext(context, {
    timeout: 1000, // 最多 1 秒
    breakOnSigint: true,
  });

  return sandbox.module.exports;
}
```

#### 3.2.2 helpers 白名单

```typescript
interface RuleHostHelpers {
  // 工具调用属性
  toolIs(name: string): boolean;
  pathMatches(pattern: string): boolean;

  // 上下文查询
  isRiskPath(): boolean;
  planStatus(): 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN';
  fileExists(path: string): boolean;     // ← 受限：仅检查 workspace 内
  hasFile(name: string): boolean;
  estimatedLineChanges(): number;

  // 系统状态
  currentGfi(): number;
  currentEpTier(): number;
  bashCommandRisk(): 'safe' | 'normal' | 'dangerous' | 'unknown';
}
```

**绝对禁止**通过 helpers 暴露：

- 任意文件 IO（`readFile`、`writeFile`、`unlink`）
- 网络访问（`fetch`、`http`、`net`）
- 子进程（`child_process`、`spawn`、`exec`）
- 动态导入（`import()`、`require()`）
- 反射元编程（`eval`、`Function`、`vm`）
- 进程管理（`process.exit`、`process.kill`）
- 文件系统遍历（`readdir`）

### 3.3 强制约束

| ID | 约束 | 强制方式 |
|----|------|---------|
| SBX-1 | 所有 LLM 生成代码必须在 `node:vm` 沙箱执行 | RuleHost 入口强制 |
| SBX-2 | 沙箱中禁用 `importModuleDynamically` | vm.Script 选项 |
| SBX-3 | 沙箱执行超时 ≤ 1000ms | vm.runInContext timeout |
| SBX-4 | helpers 是 `Object.freeze`d | runtime 强制 |
| SBX-5 | 代码必须先通过 `checkForbiddenPatterns` | activate 前 canActivate |
| SBX-6 | 同步执行，不允许 Promise 跨 turn | RuleHostResult 同步 |
| SBX-7 | 沙箱失败时 RuleHost 返回 `undefined`（保守降级，不阻塞调用）| `rule-host.ts` 已实现 |
| SBX-8 | code_tool_hook 默认走 shadow mode | RuleHostWriter 强制 |

### 3.4 禁用模式检测

```typescript
// @principles/core/runtime-v2/internalization/rule-code-validator.ts (existing)
const FORBIDDEN_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bprocess\./,
  /\bglobalThis\./,
  /\b__proto__\b/,
  /\bconstructor\s*\.\s*constructor\b/,
  /\bsetTimeout\b/,
  /\bsetInterval\b/,
  /\bfetch\b/,
  /\bXMLHttpRequest\b/,
  // ... 更多
];
```

### 3.5 GoldenTrace 验证（参见 ADR-0004）

激活 `code_tool_hook` 前必须通过 GoldenTrace replay：

- 至少 1 个 negative case（应该被 block / propose_correction）
- 至少 1 个 positive case（应该被 allow）
- 全部通过才允许进入 ApprovalQueue

### 3.6 Shadow Mode

详见 `ACTIVATION_CHANNELS.md` §3.4。激活后**默认 30 个调用周期**只观察不生效。如果误杀率超阈值（默认 5%），自动 deactivate。

---

## 4. 审批控制（Approval Control）

### 4.1 双人审批（Dual Approval）

适用通道：`model_training`（强制）

#### 4.1.1 强制约束

| ID | 约束 |
|----|------|
| APR-1 | 第一审批人和第二审批人**必须**不同（基于 userId 比对）|
| APR-2 | 二次确认前**必须**经过 24 小时冷却（不可绕过）|
| APR-3 | 任一审批人可在等待期间 reject 终止 |
| APR-4 | 配置不允许覆盖 `model_training` 强制双人 |
| APR-5 | 第一审批人不能与原 artifact 触发方相同（如果触发方是 human） |
| APR-6 | 审批操作必须写审计日志（参见 `OBSERVABILITY_ARCHITECTURE.md` §5.2）|

#### 4.1.2 实现位置

`@principles/core/runtime-v2/activation/approval-queue.ts`

```typescript
async secondConfirm(approvalId: string, secondApprover: string): Promise<...> {
  const approval = await this.get(approvalId);

  // APR-1: 第一审批人 ≠ 第二审批人
  if (approval.decidedBy === secondApprover) {
    throw new PDRuntimeError('input_invalid', 'Second approver must differ from first');
  }

  // APR-2: 24h 冷却
  const cooldownExpired = new Date() >= new Date(approval.cooldownExpiresAt);
  if (!cooldownExpired) {
    throw new PDRuntimeError('input_invalid', 'Cooldown not yet expired');
  }

  // ... 写入二次确认 + 审计日志
}
```

### 4.2 审批权限模型

#### 4.2.1 当前简化模型

PD 当前为**本地单用户**系统，权限模型简化：

- 单用户 = workspace 拥有者 = 默认审批人
- "不同审批人" 通过显式输入 `--user`（不同字符串）

#### 4.2.2 未来扩展（不在本 ADR 范围）

- RBAC：定义 reviewer / approver / admin 角色
- 审批人池：从用户列表中随机分配第二审批
- 权限委托：临时委托他人审批

---

## 5. PII 保护

### 5.1 PII 数据来源

| 来源 | 可能包含 PII |
|------|-------------|
| 用户消息（trajectory） | 姓名、邮箱、电话、地址 |
| 工作区文件路径 | 用户名（home dir）|
| 错误堆栈 | 路径、变量值 |
| LLM 输出 | 复述用户输入 |
| Audit log | actor.id（可能是邮箱）|

### 5.2 脱敏规范

#### 5.2.1 用户消息脱敏

```typescript
// @principles/core/pain-context-extractor.ts (existing)
function sanitizeUserMessage(text: string): string {
  return text
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<EMAIL>')
    .replace(/\b\+?[\d\s\-\(\)]{7,}\b/g, '<PHONE>')
    .replace(/\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, '<CARD>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>')
    // ... 其他规则
    ;
}
```

#### 5.2.2 路径脱敏

```typescript
function sanitizePath(absolutePath: string, workspaceDir: string): string {
  return absolutePath
    .replace(workspaceDir, '<WORKSPACE>')
    .replace(/\/Users\/[^/]+/g, '/Users/<USER>')
    .replace(/\/home\/[^/]+/g, '/home/<USER>')
    .replace(/C:\\Users\\[^\\]+/g, 'C:\\Users\\<USER>');
}
```

#### 5.2.3 强制约束

| ID | 约束 |
|----|------|
| PII-1 | 写入 PainSignal / Trajectory 前**必须**经过脱敏 |
| PII-2 | LLM prompt 注入前**必须**经过脱敏 |
| PII-3 | 错误堆栈写入 log 前路径必须脱敏 |
| PII-4 | Audit log 中的 `actor.id` 可保留原值（合规需要）|
| PII-5 | 训练数据导出前**必须**通过 PII 扫描（参见 `ACTIVATION_CHANNELS.md` §3.5）|
| PII-6 | 任何远程导出**必须**先脱敏 |

### 5.3 PII 扫描器

`@principles/core/runtime-v2/security/pii-scanner.ts`（待建）

```typescript
export interface PIIScanResult {
  hasViolations: boolean;
  violations: Array<{
    kind: 'email' | 'phone' | 'card' | 'ip' | 'name' | 'address';
    location: { sampleIndex: number; field: string };
    confidence: number;
  }>;
}

export function scanForPII(text: string | object): PIIScanResult { ... }
```

### 5.4 训练数据 PII 强制检查

`TrainingExporter.canActivate()` 必须调用 `scanForPII`：

```typescript
const piiCheck = await scanForPII(dataset);
if (piiCheck.hasViolations) {
  return { ok: false, reason: `PII detected: ${piiCheck.violations.length} violations` };
}
```

---

## 6. 密钥管理（Secrets Management）

### 6.1 设计原则

PD 自身**不存储**任何密钥。所有 LLM API key、第三方 service token 都通过**环境变量**传入。

### 6.2 强制约束

| ID | 约束 |
|----|------|
| SEC-1 | API key **必须**通过环境变量传入（如 `OPENAI_API_KEY`）|
| SEC-2 | **绝不**把 API key 写入文件（包括 config / log / audit）|
| SEC-3 | LLM 调用错误 log 不得包含 key 值（仅 key 名称）|
| SEC-4 | 密钥相关的 schema 字段标记为 `@sensitive` |
| SEC-5 | log 系统对包含 `key` / `token` / `secret` 子串的字段自动脱敏 |
| SEC-6 | 远程导出**必须**剔除 sensitive 字段 |

### 6.3 sensitive 字段自动脱敏

```typescript
// @principles/core/log-sanitizer.ts (待建)
const SENSITIVE_KEY_PATTERNS = /^(api[_-]?key|token|secret|password|credential|authorization)$/i;

function sanitizeForLog(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.test(k)) {
      result[k] = '<REDACTED>';
    } else {
      result[k] = sanitizeForLog(v);
    }
  }
  return result;
}
```

所有 logger 实现**必须**应用此脱敏。

### 6.4 配置文件中的密钥引用

```yaml
# config 中允许引用环境变量
runtime:
  pi_ai:
    api_key: ${PD_PIAI_API_KEY}     # 启动时解析
```

不允许：

```yaml
# ❌ 禁止
runtime:
  pi_ai:
    api_key: "sk-1234567890..."
```

启动时检测，如果发现疑似 key 字面量，**必须**报错退出。

---

## 7. 配置文件防篡改

### 7.1 关键配置

以下配置文件直接影响安全策略：

| 文件 | 影响 |
|------|-----|
| `activation.yaml` | 通道激活策略、审批流程 |
| `runtime-scheduling.yaml` | PD-owned 显式执行策略（legacy `idle-trigger.yaml` retired） |
| `internalization.yaml` | Runner 行为 |
| `observability.yaml` | 审计日志开关（不可关闭） |

### 7.2 强制约束

| ID | 约束 |
|----|------|
| CFG-1 | 修改安全相关配置**必须**通过 `pd-cli pd config set` |
| CFG-2 | 直接编辑文件不会被检测，但运行时校验会失败 |
| CFG-3 | 每次配置变更**必须**写入审计日志 |
| CFG-4 | 关键字段（如 `model_training.requires_second_confirmation`）写死在代码层，配置覆盖会被拒绝 |

### 7.3 不可被 config 覆盖的字段

参见 `ACTIVATION_CHANNELS.md` §7。要点：

- `code_tool_hook.mode = require_approval`（不可改）
- `code_tool_hook.shadow_mode_default = true`（不可改）
- `model_training.mode = require_approval`（不可改）
- `model_training.requires_second_confirmation = true`（不可改）
- `model_training.cooldown_hours = 24`（不可改）
- `model_training.second_approver_must_differ = true`（不可改）
- `model_training.pii_scan_required = true`（不可改）

实现位置：`activation-config-loader.ts`，加载后强制覆盖这些字段。

### 7.4 配置完整性校验

`pd-cli pd config verify` 命令：

```bash
pd config verify
# 输出：
# ✓ activation.yaml: ok
# ✗ runtime-scheduling.yaml: invalid (max_concurrent_runs out of range)
# ✓ internalization.yaml: ok
# ✓ observability.yaml: ok
# ! Found suspicious literal in `runtime.openai.api_key`. Use ${ENV_VAR} instead.
```

---

## 8. 审计日志完整性

参见 `OBSERVABILITY_ARCHITECTURE.md` §5。要点：

- append-only
- 同步写入（fsync）
- 写入失败必须中止业务
- 可选 hash chain 防篡改

---

## 9. 防滥用（Anti-Abuse）

### 9.1 速率限制

| 资源 | 限制 |
|------|-----|
| Pain signal 写入 | 每 session 1000/小时 |
| Diagnostician 任务创建 | 每 workspace 100/小时 |
| Internalization wakeOnce | 每 workspace 10/分钟 |
| Approval enqueue | 每 workspace 50/小时 |
| LLM 调用（per Adapter）| 由 RuntimeAdapter 自行限流 |

实现：`@principles/core/runtime-v2/rate-limiter.ts`（待建）

### 9.2 队列保护（防 DoS）

| 队列 | 上限 | 超过时行为 |
|------|-----|----------|
| `tasks` (status=pending) | 1000 / kind | reject 新 enqueue + 报警 |
| `approvals` (status=pending) | 200 / channel | reject 新 enqueue + 报警 |
| `events` 表 | 100,000 / day | 自动归档老数据 |

### 9.3 提示词注入防护

#### 9.3.1 风险

LLM 生成的内容（如 PIArtifact）会被作为 prompt 注入下游 Runner。如果上游 Runner 输出包含恶意指令，会污染下游。

#### 9.3.2 缓解

| 措施 | 实现 |
|------|-----|
| 输出 schema 强制（TypeBox） | 已实现 |
| 字段长度限制（max length per field） | 各 Validator 实施 |
| 危险关键词过滤（"ignore previous instructions"）| Validator 增强 |
| 上下文边界标记（明确 prompt 段落分隔）| 各 PromptBuilder |
| 拒绝包含 prompt-like 内容的输出 | DefaultValidator 增强 |

#### 9.3.3 强制约束

| ID | 约束 |
|----|------|
| INJ-1 | 任何 PIArtifact 字段长度 ≤ 10,000 字符 |
| INJ-2 | DiagnosticianValidator 检测危险 keyword 并拒绝 |
| INJ-3 | PromptBuilder 必须使用清晰的段落边界（如 `===USER MESSAGE===` / `===END USER MESSAGE===`）|
| INJ-4 | Runner 不得直接信任上游输出做关键决策（必经 Validator）|

---

## 10. 网络与远程通信

### 10.1 默认行为

PD **默认**不发起任何远程网络请求，除了：

- LLM API 调用（通过 RuntimeAdapter）
- 用户显式启用的 webhook / SIEM export

### 10.2 强制约束

| ID | 约束 |
|----|------|
| NET-1 | core 不允许引入 `node:http` / `fetch` 用于业务通信 |
| NET-2 | 任何远程导出**必须**经过白名单校验 |
| NET-3 | 远程导出**必须**先脱敏（PII / sensitive）|
| NET-4 | 远程导出**必须**走显式 config（默认关闭）|
| NET-5 | pd-console 默认只监听 `127.0.0.1` |

### 10.3 pd-console 网络绑定

```yaml
# {workspace}/.pd/config/console.yaml
console:
  bind_host: "127.0.0.1"     # 默认仅本地
  bind_port: 18789
  # 不建议改为 0.0.0.0，除非有外部认证保护
  cors:
    enabled: false
    allowed_origins: []
  authentication:
    enabled: false           # 默认关闭（本地单用户）
    type: none               # none | basic | token
```

如果用户改为 `0.0.0.0`，启动时**必须**输出醒目警告。

---

## 11. 工件不可变性

### 11.1 PIArtifact 不可变性

| ID | 约束 |
|----|------|
| ART-1 | PIArtifact 写入后 `contentJson` 不可变（除 `validationStatus` 字段外）|
| ART-2 | Artifact 删除是不允许的，仅可标记 `archived` |
| ART-3 | 修订需要新建 artifact + lineage 关联 |
| ART-4 | Ledger Principle 升级版本时保留历史（`version` 字段递增） |

### 11.2 Implementation 文件不可变性

激活后的 implementation 代码文件：

| ID | 约束 |
|----|------|
| IMPL-1 | `entry.ts` 写入后不允许直接修改 |
| IMPL-2 | 修订需要 deactivate + 新版本激活 |
| IMPL-3 | 删除需要先 deactivate + archive |
| IMPL-4 | 文件系统层面建议设置只读权限（OS 级别）|

---

## 12. 审计：人 / 代理 / 系统行为追溯

### 12.1 actor 标识

参见 `OBSERVABILITY_ARCHITECTURE.md` §5.3 的 `AuditLogEntry.actor`：

```typescript
actor: {
  kind: 'human' | 'agent' | 'system';
  id: string;
  sessionId?: string;
}
```

### 12.2 关键行为审计

| 行为 | 必须审计 |
|------|---------|
| 任何写操作 by `human` | ✅ |
| 高风险写操作 by `agent` | ✅ |
| 配置变更 | ✅ |
| Approval 决策 | ✅ |
| 审计日志查看（外部导出）| ✅ |
| Schema migration | ✅ |
| Workspace 初始化 | ✅ |

### 12.3 actor 验证

#### 12.3.1 human actor

通过 `pd-console` 的会话获取（当前简化为 OS 用户名）。未来扩展时增加：

- Local OS 用户验证
- 可选 password / token

#### 12.3.2 agent actor

通过 OpenClaw `agentId` 字段标识。强制要求：

- agentId 必须在 PD 启动时注册
- 未注册的 agentId 操作 PD API 必须被拒绝

#### 12.3.3 system actor

仅用于 PD 内部自动操作（如 RecoverySweep / PD-owned scheduler 触发的）。需要在审计中标明触发器类型。

---

## 13. 安全强制约束总表

| ID | 约束 | 强制位置 | 测试覆盖 |
|----|------|---------|---------|
| WS-1 ~ WS-6 | 工作区隔离 | path-resolver / workspace-resolver | ✅ 已部分 |
| SBX-1 ~ SBX-8 | 沙箱执行 | rule-implementation-runtime / rule-host | ✅ 已部分 |
| APR-1 ~ APR-6 | 审批控制 | approval-queue | ❌ 待实现 |
| PII-1 ~ PII-6 | PII 保护 | pain-context-extractor / pii-scanner | ⚠️ 部分（pii-scanner 待建）|
| SEC-1 ~ SEC-6 | 密钥管理 | log-sanitizer / config-loader | ❌ 待实现 |
| CFG-1 ~ CFG-4 | 配置防篡改 | activation-config-loader | ❌ 待实现 |
| INJ-1 ~ INJ-4 | 提示词注入 | Validator 各实现 | ⚠️ 部分 |
| NET-1 ~ NET-5 | 网络通信 | architecture-regression test | ❌ 待实现 |
| ART-1 ~ ART-4 | 工件不可变 | PIArtifactStore | ⚠️ 部分 |
| IMPL-1 ~ IMPL-4 | Implementation 不可变 | code-implementation-storage | ⚠️ 部分 |

---

## 14. 安全测试要求

### 14.1 单元测试

每个安全约束必须有对应单元测试：

```typescript
// 示例
describe('WS-3: workspace boundary', () => {
  test('rejects ".." escape', () => {
    expect(validateWorkspacePath('/ws', '/ws/../etc/passwd').ok).toBe(false);
  });
  test('rejects symlink escape', () => {
    // setup symlink ...
    expect(validateWorkspacePath('/ws', '/ws/symlink').ok).toBe(false);
  });
});
```

### 14.2 集成测试

至少覆盖：

1. **Sandbox escape attempts**：尝试用恶意代码访问 file system / network
2. **Cross-workspace write**：尝试写入其他工作区
3. **Same-approver double approval**：尝试同人完成双重审批
4. **Cooldown bypass**：尝试在冷却期内 secondConfirm
5. **Forbidden config override**：尝试用 yaml 关闭 `pii_scan_required`
6. **PII leak**：训练数据含明显 PII，确认被拒绝
7. **Audit tampering**：直接修改 audit log，确认 hash chain 报警
8. **Prompt injection**：上游 Runner 输出含 "ignore previous"，确认下游拒绝

### 14.3 架构守护测试

```typescript
// architecture-regression.test.ts
test('NET-1: core does not import node:http or fetch for business', () => {
  const violations = scanCoreForNetworkImports();
  expect(violations).toEqual([]);
});

test('SEC-2: no API keys in committed config', () => {
  const violations = scanRepoForSecretLiterals();
  expect(violations).toEqual([]);
});
```

---

## 15. 安全事件响应

### 15.1 安全事件分类

| 等级 | 描述 | 响应 |
|------|-----|-----|
| P0 | Sandbox 逃逸 / 跨工作区写入 / API key 泄漏 | 立即停止 PD，发布修复 |
| P1 | 审批绕过 / 审计篡改 / 配置硬约束被覆盖 | 24h 内修复 |
| P2 | PII 未脱敏 / sensitive 字段进入 log | 一个 Sprint 内修复 |
| P3 | 速率限制失效 / 队列堆积 | 视情况修复 |

### 15.2 报告渠道

PD 安全问题通过：

- GitHub Security Advisory（首选）
- 不要在公开 issue 报告

---

## 16. 实施进度

| 项目 | 状态 |
|------|-----|
| 工作区路径校验 | ✅ |
| Sandbox 执行（vm + helpers）| ✅ |
| 禁用模式检测 | ✅ |
| GoldenTrace 验证 | ✅ |
| Shadow mode | ⚠️（设计完成，待 RuleHostWriter 实现）|
| Approval 双人审批 | ❌ 待建 |
| 24h 冷却 | ❌ 待建 |
| PII 脱敏（基础）| ✅ |
| PII 扫描器 | ❌ 待建 |
| 密钥管理 | ⚠️（环境变量已用，sanitizer 待建）|
| 配置防篡改 | ❌ 待建 |
| 网络限制守护测试 | ❌ 待建 |
| Audit log hash chain | ❌ 待建 |
| 速率限制 | ❌ 待建 |

---

## 17. 关联文档

- [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) §6.1
- [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) — 通道审批与 sandbox
- [`OBSERVABILITY_ARCHITECTURE.md`](./OBSERVABILITY_ARCHITECTURE.md) — 审计日志
- [`CONFIGURATION_ARCHITECTURE.md`](./CONFIGURATION_ARCHITECTURE.md) — 配置防篡改
- [ADR-0004](../adr/0004-l2-auto-correction-and-replay.md) — GoldenTrace
- [ADR-0006](../adr/0006-hybrid-activation-mechanism.md) — 审批流程
