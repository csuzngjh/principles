# 配置架构（Configuration Architecture）

> **状态**: Active
> **最后更新**: 2026-05-15
> **关联**: `PD_ARCHITECTURE_OVERVIEW.md`, `SECURITY_ARCHITECTURE.md` §7

本文档定义 PD 系统的配置加载、层级合并、热重载、校验、变更审计规范。

---

## 1. 设计原则

### 1.1 核心信条

1. **代码即合理默认** —— 不依赖任何 config 文件 PD 也能跑（虽然限制更严）
2. **声明式优于命令式** —— config 用 YAML 描述意图，不嵌入逻辑
3. **本地文件优先** —— 不引入远程配置中心依赖
4. **变更可审计** —— 任何 config 变更都写审计日志
5. **关键安全约束代码硬编码** —— config 不能覆盖（参见 `SECURITY_ARCHITECTURE.md` §7.3）
6. **Schema 强校验** —— 加载时即 fail-fast

### 1.2 配置 vs 代码的边界

| 应该是 config | 应该是代码 |
|--------------|-----------|
| 行为参数（阈值、并发数、TTL）| 业务逻辑 |
| 通道开关（enabled / disabled）| 状态机转换规则 |
| 路径前缀 / Workspace 行为 | 数据结构定义 |
| 触发策略（cron / idle）| 调度算法 |
| 引用环境变量 | 业务常量（PDErrorCategory）|

---

## 2. 配置层级（Priority Order）

### 2.1 五级合并

```
Lower priority                                        Higher priority
─────────────────────────────────────────────────────────────────────
Level 1: Code defaults
       │
       │ overridden by
       ▼
Level 2: ~/.openclaw/extensions/principles-disciple/default-config.yaml
       │
       │ overridden by
       ▼
Level 3: {workspace}/.pd/config/*.yaml
       │
       │ overridden by
       ▼
Level 4: Environment variables (PD_* prefix)
       │
       │ overridden by
       ▼
Level 5: Command-line flags (pd-cli only)
```

### 2.2 各级用途

| Level | 用途 | 维护者 |
|-------|-----|-------|
| 1 (code) | 安全的最小默认值 | 开发者 |
| 2 (extension) | 全局调优（所有工作区共享）| 运维 |
| 3 (workspace) | 项目特定配置 | 项目维护者 |
| 4 (env) | 临时调试 / CI 注入 | 运维 / CI |
| 5 (cli flag) | 单次执行覆盖 | 用户 |

### 2.3 合并语义

**深度合并（deep merge）**，但有特殊规则：

| 字段类型 | 合并行为 |
|---------|---------|
| 标量（string / number / boolean）| 高优先级覆盖低优先级 |
| 对象 | 递归合并 |
| 数组 | **整体替换**（不合并） |
| `null` | 显式清除（删除该字段） |

**示例**：

```yaml
# Level 2 (default-config.yaml)
internalization:
  default_runner_timeout_ms: 300000
  enabled_channels:
    - prompt
    - skill
    - code_tool_hook

# Level 3 (workspace/.pd/config/internalization.yaml)
internalization:
  default_runner_timeout_ms: 600000   # 覆盖
  enabled_channels:                    # 整体替换
    - prompt
    - skill

# 合并结果：
internalization:
  default_runner_timeout_ms: 600000
  enabled_channels:
    - prompt
    - skill
  # code_tool_hook 不在结果中
```

---

## 3. 配置文件清单

### 3.1 标准配置文件

| 文件 | 路径 | 加载者 | 用途 |
|------|------|------|------|
| `activation.yaml` | `{workspace}/.pd/config/` | core | 通道激活策略（详见 ADR-0006）|
| `internalization.yaml` | `{workspace}/.pd/config/` | core | 内化流水线参数 |
| `idle-trigger.yaml` | `{workspace}/.pd/config/` | plugin | IdleTrigger 触发策略 |
| `runtime.yaml` | `{workspace}/.pd/config/` | core | RuntimeAdapter 选择与配置 |
| `gfi.yaml` | `{workspace}/.pd/config/` | core | GFI 策略 |
| `observability.yaml` | `{workspace}/.pd/config/` | core | 日志/指标/追踪/审计配置 |
| `console.yaml` | `{workspace}/.pd/config/` | console | pd-console 监听配置 |
| `pruning.yaml` | `{workspace}/.pd/config/` | core | Pruning 策略 |
| `routing-policy.yaml` | `{workspace}/.pd/config/` | core | 内化路由覆盖（可选）|

### 3.2 默认配置文件

`~/.openclaw/extensions/principles-disciple/default-config.yaml`

可包含上述任意 yaml 的内容（合并语义）。

### 3.3 工作区初始化时

`pd init` 命令在 `{workspace}/.pd/config/` 写入：

- 一个空的 `README.md` 说明用法
- **不预先**写入任何 yaml（让 Level 1+2 起作用）

用户可按需创建。

---

## 4. Schema 与校验

### 4.1 设计

每个配置文件都有对应的 TypeBox schema：

```typescript
// @principles/core/runtime-v2/config/schemas/activation-config.ts
import { Type, Static } from '@sinclair/typebox';

export const ActivationConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  dispatcher: Type.Optional(Type.Object({
    max_concurrent_dispatches: Type.Number({ default: 5, minimum: 1 }),
    dispatch_timeout_ms: Type.Number({ default: 30000, minimum: 1000 }),
  })),
  approval_queue: Type.Optional(Type.Object({
    pending_ttl_hours: Type.Number({ default: 168, minimum: 1 }),
    expired_action: Type.Union([Type.Literal('auto_reject'), Type.Literal('escalate')], { default: 'auto_reject' }),
  })),
  channels: Type.Optional(Type.Object({
    prompt: ChannelPromptConfigSchema,
    defer_archive: ChannelDeferArchiveConfigSchema,
    skill: ChannelSkillConfigSchema,
    code_tool_hook: ChannelCodeToolHookConfigSchema,
    model_training: ChannelModelTrainingConfigSchema,
  })),
});

export type ActivationConfig = Static<typeof ActivationConfigSchema>;
```

### 4.2 加载流程

```
┌──────────────────────────────────────────────────────┐
│ 1. 收集所有源（Level 1 → 5）                          │
└────────────────────┬─────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────┐
│ 2. 解析 ${ENV_VAR} 引用                               │
│    例：api_key: ${PD_PIAI_API_KEY}                    │
└────────────────────┬─────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────┐
│ 3. 深度合并（Level 1 → 5 顺序）                       │
└────────────────────┬─────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────┐
│ 4. Schema 校验（TypeBox Value.Check）                │
│    失败 → 抛 PDRuntimeError('input_invalid')          │
└────────────────────┬─────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────┐
│ 5. 强制覆盖关键安全字段                                │
│    例：code_tool_hook.mode = 'require_approval'      │
│    （覆盖 user 试图设的 'auto'）                      │
└────────────────────┬─────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────┐
│ 6. Freeze 配置对象                                    │
└────────────────────┬─────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────┐
│ 7. 缓存（同一进程不重复加载）                          │
└──────────────────────────────────────────────────────┘
```

### 4.3 校验失败行为

| 时机 | 行为 |
|------|-----|
| 启动时（Plugin / pd-cli / pd-console）| 输出错误信息 + 退出（exit code 2）|
| 热重载时 | 输出错误信息 + **保持原配置**，发警告事件 |

错误信息必须包含：
- 配置文件路径
- 字段路径（如 `channels.code_tool_hook.shadow_mode_cycles`）
- 期望类型 vs 实际值
- 修复建议

### 4.4 警告 vs 错误

| 类型 | 处理 |
|------|-----|
| Schema 不匹配 | error |
| 字段为废弃名 | warn + 自动 alias（一个 minor 版本周期）|
| 字段超出建议范围 | warn |
| 引用了不存在的环境变量 | error（**不**填空字符串） |
| 字段为 `null` 但 schema 不允许 | error |
| 关键安全字段被尝试覆盖 | warn + 强制恢复 |

---

## 5. 环境变量

### 5.1 命名规范

```
PD_{DOMAIN}_{NAME}

例：
PD_LOG_LEVEL                       # 覆盖 observability.logs.level
PD_RUNTIME_KIND                    # 默认 RuntimeKind
PD_PIAI_API_KEY                    # PiAi adapter key
PD_OPENAI_API_KEY                  # OpenAI key
PD_USE_INTERNALIZATION_ENGINE      # ADR-0005 feature flag
PD_WORKSPACE_DIR                   # 显式指定工作区
PD_CONFIG_DIR                      # 覆盖 config 目录
```

### 5.2 yaml 中的引用语法

```yaml
runtime:
  pi_ai:
    api_key: ${PD_PIAI_API_KEY}              # 必须存在，否则报错
    base_url: ${PD_PIAI_BASE_URL:-https://api.example.com}  # 可有默认
```

`${VAR}` 必须存在，否则启动失败。
`${VAR:-default}` 允许默认值。

### 5.3 安全要求

详见 `SECURITY_ARCHITECTURE.md` §6：

- 任何字段名匹配 `/key|token|secret|password|credential/i` 的，**必须**通过 `${ENV_VAR}` 引用
- 加载时检测：如果检测到字面量（如 `api_key: "sk-..."`），**报错退出**

---

## 6. 命令行参数（pd-cli only）

### 6.1 通用参数

```bash
pd [global-flags] <command> [command-flags]

# 全局
--workspace <dir>    # 覆盖 PD_WORKSPACE_DIR / 当前目录
--config <file>      # 显式指定 config 文件
--no-config          # 不加载任何 config（仅 Level 1）
--log-level <level>  # 覆盖 observability.logs.level
--json               # JSON 输出
--quiet              # 仅输出错误
--verbose            # debug 日志到 stderr
```

### 6.2 命令特定参数

详见各 `pd-cli/src/commands/*.ts` 文件。每个命令有独立参数 schema。

---

## 7. 热重载（Hot Reload）

### 7.1 适用范围

| 进程类型 | 是否支持热重载 |
|---------|--------------|
| OpenClaw Plugin | ⚠️ 部分（部分配置仅启动时生效）|
| pd-cli | ❌ 不需要（短生命周期）|
| pd-console | ✅ 完全支持（用户场景）|

### 7.2 哪些配置可热重载

| 配置 | 热重载 | 重新加载触发 |
|------|-------|------------|
| `observability.logs.level` | ✅ | 文件变化 |
| `idle-trigger.policies.*` | ✅ | 文件变化 |
| `internalization.max_concurrent_per_channel.*` | ✅ | 文件变化 |
| `routing-policy.*` | ✅ | 文件变化 |
| `pruning.*` | ✅ | 文件变化 |
| `runtime.adapter` | ❌ | 仅启动 |
| `activation.channels.*.mode` | ❌ | 仅启动（安全关键）|
| `console.bind_host / bind_port` | ❌ | 仅启动 |
| `observability.audit.*` | ❌ | 仅启动 |

### 7.3 实现机制

```typescript
// @principles/core/runtime-v2/config/config-watcher.ts
class ConfigWatcher {
  watch(filePath: string, onChange: (config: T) => void): Disposable {
    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        try {
          const newConfig = loadAndValidate(filePath);
          onChange(newConfig);
        } catch (err) {
          // 校验失败时保留原配置，发警告事件
          logger.warn('config reload failed, keeping previous', { error: err });
        }
      }
    });
    return { dispose: () => watcher.close() };
  }
}
```

**注意**：fs.watch 在某些 OS 上不可靠，关键配置建议轮询补充。

### 7.4 热重载时的副作用

| 配置变更 | 副作用 |
|---------|-------|
| 增加 `enabled_channels` | 新通道可被使用 |
| 减少 `enabled_channels` | 已 active 的不变，新激活会被拒绝 |
| 修改 `max_concurrent_per_channel` | 立即生效（下一个 dispatch 用新值）|
| 修改 `default_runner_timeout_ms` | 仅影响新 Runner 调用 |

---

## 8. 配置审计

### 8.1 强制要求

| ID | 约束 |
|----|------|
| CFG-AUDIT-1 | 通过 `pd-cli pd config set` 修改的变更**必须**写审计日志 |
| CFG-AUDIT-2 | 启动时加载的配置**必须**记录 hash 到审计日志 |
| CFG-AUDIT-3 | 直接编辑文件被发现时（启动 hash 不匹配）**必须**写警告审计 |
| CFG-AUDIT-4 | 关键安全字段的修改尝试（即使被强制覆盖）**必须**审计 |

### 8.2 配置变更命令

```bash
# 显式修改
pd config set activation.channels.skill.auto_activate false --reason "stricter review"

# 输出：
# ✓ Modified: activation.channels.skill.auto_activate
#   Old: true
#   New: false
# ✓ Audit log written: aud_abc123
```

### 8.3 配置查看

```bash
pd config show                      # 显示合并后的配置
pd config show --layer 3            # 显示某一层的配置
pd config show --field activation   # 仅显示某字段
pd config diff                      # 显示与默认的差异
pd config verify                    # 校验所有配置文件
pd config history                   # 显示最近的变更历史（来自审计日志）
```

---

## 9. 各配置文件示例

### 9.1 activation.yaml

参见 `ACTIVATION_CHANNELS.md` §7。

### 9.2 internalization.yaml

```yaml
# {workspace}/.pd/config/internalization.yaml
internalization:
  default_runner_timeout_ms: 300000
  default_max_attempts: 3

  # 启用的通道
  enabled_channels:
    - prompt
    - skill
    - code_tool_hook
    - model_training
    - defer_archive

  # 每通道并发上限
  max_concurrent_per_channel:
    prompt: 5
    skill: 3
    code_tool_hook: 2
    model_training: 1

  # Bridge 行为
  bridge:
    auto_create_dreamer_task: true
    skip_if_already_in_pipeline: true
```

### 9.3 idle-trigger.yaml

```yaml
# {workspace}/.pd/config/idle-trigger.yaml
idle_trigger:
  enabled: true
  policies:
    - kind: heartbeat_idle
      idle_threshold_seconds: 300
    - kind: scheduled
      cron: "0 */15 * * * *"
    - kind: queue_pressure
      pending_threshold: 10
  max_concurrent_runs: 3
```

### 9.4 runtime.yaml

```yaml
# {workspace}/.pd/config/runtime.yaml
runtime:
  default_kind: openclaw_cli           # openclaw_cli | pi_ai | test_double

  openclaw_cli:
    bin_path: openclaw                 # PATH 中或绝对路径
    timeout_ms: 300000

  pi_ai:
    base_url: ${PD_PIAI_BASE_URL:-https://api.example.com}
    api_key: ${PD_PIAI_API_KEY}
    default_model: gpt-5.4
    timeout_ms: 300000

  selector:
    fallback_chain:
      - openclaw_cli
      - pi_ai
```

### 9.5 observability.yaml

参见 `OBSERVABILITY_ARCHITECTURE.md` §10.1。

### 9.6 console.yaml

```yaml
# {workspace}/.pd/config/console.yaml
console:
  bind_host: "127.0.0.1"
  bind_port: 18789
  cors:
    enabled: false
    allowed_origins: []
  authentication:
    enabled: false
    type: none
  ui:
    theme: auto       # light | dark | auto
    language: zh-CN
```

---

## 10. 配置加载实现

### 10.1 核心组件

```typescript
// @principles/core/runtime-v2/config/config-loader.ts (待建)

interface ConfigLoader {
  /**
   * 加载并合并配置。
   * 失败时抛 PDRuntimeError('input_invalid')。
   */
  load<T>(opts: LoadOptions<T>): Promise<T>;
}

interface LoadOptions<T> {
  /** 配置文件名（不含路径），如 'activation.yaml' */
  filename: string;
  /** TypeBox schema */
  schema: TSchema;
  /** workspace 目录 */
  workspaceDir: string;
  /** 强制覆盖字段 */
  forceOverrides?: Partial<T>;
  /** CLI flags（仅 pd-cli 使用）*/
  cliFlags?: Record<string, unknown>;
}
```

### 10.2 加载顺序实现

```typescript
async function loadConfig<T>(opts: LoadOptions<T>): Promise<T> {
  // Level 1: code defaults（来自 schema 的 default 值）
  let merged = extractDefaults(opts.schema);

  // Level 2: extension global
  const globalPath = path.join(os.homedir(), '.openclaw/extensions/principles-disciple/default-config.yaml');
  if (fs.existsSync(globalPath)) {
    merged = deepMerge(merged, await loadYaml(globalPath));
  }

  // Level 3: workspace
  const wsPath = path.join(opts.workspaceDir, '.pd/config', opts.filename);
  if (fs.existsSync(wsPath)) {
    merged = deepMerge(merged, await loadYaml(wsPath));
  }

  // Level 4: env vars
  merged = applyEnvOverrides(merged, opts.filename);

  // Level 5: CLI flags
  if (opts.cliFlags) {
    merged = deepMerge(merged, opts.cliFlags);
  }

  // Resolve ${ENV_VAR} references
  merged = resolveEnvReferences(merged);

  // Schema validate
  validateOrThrow(merged, opts.schema);

  // Force security overrides
  if (opts.forceOverrides) {
    merged = deepMerge(merged, opts.forceOverrides);
  }

  // Sensitive literal detection
  detectSensitiveLiterals(merged);

  // Freeze
  return Object.freeze(merged) as T;
}
```

### 10.3 单例 vs 多次加载

| 进程 | 策略 |
|------|-----|
| Plugin | 启动时加载一次，热重载场景下重新加载 |
| pd-cli | 每次启动加载一次 |
| pd-console | 启动时加载，热重载支持 |

---

## 11. 跨工作区行为

### 11.1 plugin 多工作区

OpenClaw Plugin 同时服务多个 workspace 时：

- 每个 workspace 有独立 config
- Plugin 维护一个 `workspaceDir → ConfigCache` 的映射
- workspace 切换时按需加载

### 11.2 pd-cli 工作区解析顺序

```
pd-cli 启动时确定 workspaceDir：
1. --workspace flag
2. PD_WORKSPACE_DIR env
3. 当前目录搜索 .pd/ 或 .state/principle_training_state.json
4. ~/.openclaw/workspace-main/（默认）
```

### 11.3 pd-console 单工作区

pd-console 默认只服务一个 workspace（启动时确定）。如需切换，需重启。

---

## 12. 不变量与守护

| ID | 不变量 | 强制方式 |
|----|------|---------|
| CFG-INV-1 | 配置加载失败导致启动失败（不允许 partial 启动）| 启动顺序代码 |
| CFG-INV-2 | 关键安全字段的强制覆盖必须有代码保护 | activation-config-loader |
| CFG-INV-3 | 不允许在 Library 模块（core 内部）直接读 process.env | architecture-regression test |
| CFG-INV-4 | 不允许在 Library 模块直接读取 yaml 文件 | architecture-regression test |
| CFG-INV-5 | 配置变更必须可审计 | code review |
| CFG-INV-6 | sensitive 字段不能字面量 | 启动检测 |

### 12.1 守护测试示例

```typescript
test('CFG-INV-3: core does not read process.env directly', () => {
  const violations = grep('process\\.env', { scope: 'packages/principles-core/src' });
  // 仅允许在 config-loader.ts 中
  const filtered = violations.filter(v => !v.file.includes('config-loader'));
  expect(filtered).toEqual([]);
});
```

---

## 13. 实施进度

| 项目 | 状态 |
|------|-----|
| ConfigLoader 框架 | ❌ 待建 |
| 各配置文件 Schema 定义 | ❌ 待建 |
| 5 级合并实现 | ⚠️ 部分（plugin 当前用简化版）|
| `${ENV_VAR}` 引用解析 | ❌ 待建 |
| 强制安全字段覆盖 | ❌ 待建（与 ADR-0006 一起）|
| sensitive 字面量检测 | ❌ 待建 |
| 热重载（pd-console）| ❌ 待建 |
| `pd config show / set / verify` 命令 | ❌ 待建 |
| 配置审计日志 | ❌ 待建 |
| 架构守护测试 | ❌ 待建 |

---

## 14. 关联文档

- [`PD_ARCHITECTURE_OVERVIEW.md`](./PD_ARCHITECTURE_OVERVIEW.md) §6
- [`SECURITY_ARCHITECTURE.md`](./SECURITY_ARCHITECTURE.md) §7（配置防篡改）
- [`OBSERVABILITY_ARCHITECTURE.md`](./OBSERVABILITY_ARCHITECTURE.md) §10
- [`ACTIVATION_CHANNELS.md`](./ACTIVATION_CHANNELS.md) §7（activation.yaml）
- [`VERSIONING_AND_COMPATIBILITY.md`](./VERSIONING_AND_COMPATIBILITY.md) — 配置 schema 演化
