# SPEC: PD Workspace 路径中心化管理

## Context

PD 系统存在多工作目录混淆问题：AI 智能体（OpenClaw 等）通过 `--workspace` 参数传入了错误的路径，导致 PD 数据被写入到源码仓库 `D:\Code\principles\.pd\` 而不是真正的工作目录 `D:\.openclaw\workspace\.pd\`。

**根因**：PD CLI 的 `resolveWorkspaceDir` 没有默认值、没有配置文件感知、没有路径校验。智能体传什么路径就用什么路径。

**目标**：让 PD 拥有"家目录"概念 — 在 `.pd/config.yaml` 中声明 `workspace.default`，CLI 解析时以此为锚点，当传入路径与默认值不同时发出警告。

---

## Phase 0: 清理垃圾目录

### 0.1 删除源码仓库中的误写入产物

| 目标 | 内容 | 操作 |
|---|---|---|
| `D:\Code\principles\.pd\` | 248KB state.db + tmp/ 60+ 脚本 | 删除整个目录 |
| `D:\Code\principles\.state\` | 空 state.db (0 bytes) + trajectory.db | 删除整个目录 |

- `.gitignore` 已有 `.pd/` 和 `.state/` 规则，无需修改
- `git ls-files` 确认这些文件未被 Git 跟踪

### 0.2 清理测试遗留目录（验证后）

| 目标 | 内容 |
|---|---|
| `D:\.openclaw\workspace\e2e\.pd\` | E2E 测试遗留 |
| `D:\.openclaw\workspace\mvp-uat\synthetic\.pd\` | UAT 测试遗留 |

先 grep 测试代码确认无硬编码路径依赖后再删除。

---

## Phase 1: principles-core — 类型与验证（纯逻辑，零 I/O）

### 1.1 添加 WorkspaceConfig 类型

**文件**: `packages/principles-core/src/runtime-v2/config/pd-config-types.ts`

```typescript
// 新增接口
export interface WorkspaceConfig {
  /** Absolute path to the default PD workspace directory */
  default: string;
}

// PdConfig 接口新增可选字段
export interface PdConfig {
  version: PdConfigVersion;
  workspace?: WorkspaceConfig;  // NEW
  features: Record<string, FeatureFlagEntry>;
  // ...existing fields
}
```

同时更新 `RedactedPdConfigSummary`，加入 `workspace?: { default: string }`。

### 1.2 添加 workspace 验证

**文件**: `packages/principles-core/src/runtime-v2/config/pd-config-validate.ts`

新增 `validateWorkspaceConfig` 函数：
- `workspace` 为可选 section，不存在则跳过
- `workspace.default` 必须是非空字符串
- `workspace.default` 必须是绝对路径（Windows: `C:\` 或 POSIX: `/`）
- 拒绝未知 key 和 dangerous key
- 在 `validatePdConfig` 的顶层验证中调用

### 1.3 Effective config 透传

**文件**: `packages/principles-core/src/runtime-v2/config/pd-config-effective.ts`

`computeEffectivePdConfig` 中透传 `workspace`：
```typescript
const config: PdConfig = {
  version: PD_CONFIG_VERSION,
  ...(userConfig.workspace ? { workspace: userConfig.workspace } : {}),
  features,
  runtimeProfiles,
  internalAgents,
  ui,
  principles,
};
```

### 1.4 Redaction 透传

**文件**: `packages/principles-core/src/runtime-v2/config/pd-config-redaction.ts`

`redactPdConfig` 返回值中加入 workspace（非敏感路径，直接展示）。

### 1.5 导出

**文件**: `packages/principles-core/src/runtime-v2/config/index.ts`

新增 `WorkspaceConfig` 类型导出。

---

## Phase 2: pd-cli — 发现机制与解析重写

### 2.1 配置发现函数

**文件**: `packages/pd-cli/src/services/pd-config-loader.ts`

新增 `discoverWorkspaceDefault()` 函数：
- **不依赖已知 workspace 目录**，在已知位置搜索 `.pd/config.yaml`
- 搜索顺序：
  1. `PD_WORKSPACE_DIR` 环境变量指向的目录（如果设置了）
  2. `~/.openclaw/workspace`（OpenClaw 默认 workspace）
  3. `principles-disciple.json` 中 `workspace` 字段指向的目录
- 找到后轻量提取 `workspace.default` 字段（不做完整验证）
- 返回 `{ workspaceDefault, configPath, source }` 或 `null`

### 2.2 重写 resolveWorkspaceDir

**文件**: `packages/pd-cli/src/resolve-workspace.ts`

**保持 API 签名不变**: `(workspaceDir?: string): string`

新解析链：
```
1. --workspace 显式参数 → 使用，但与 config 比对，不同则 warn
2. PD_WORKSPACE_DIR 环境变量 → 使用，但与 config 比对，不同则 warn  
3. discoverWorkspaceDefault() 返回值 → 使用（不警告，这就是默认值）
4. throw Error（保留现有兜底行为）
```

警告格式：
```
[PD:workspace] WARNING: --workspace "X" differs from config default "Y" (source: path/to/config.yaml).
Using explicit flag. Consider updating workspace.default in config.
```

### 2.3 config doctor 扩展

**文件**: `packages/pd-cli/src/commands/config-doctor.ts`

在 doctor 输出中展示：
- 当前解析到的 workspace 路径
- 解析来源（flag / env_var / config_default）
- config 中的 `workspace.default` 值
- 是否一致

---

## Phase 3: 更新生产配置

### 3.1 更新真实配置文件

**文件**: `D:\.openclaw\workspace\.pd\config.yaml`

在 `version: 1` 之后添加：
```yaml
workspace:
  default: "D:\\.openclaw\\workspace"
```

---

## Phase 4: 测试

### 4.1 新建 resolve-workspace 测试

**文件**: `packages/pd-cli/tests/resolve-workspace.test.ts`

测试用例：
- 显式 `--workspace` 标志直接返回
- `PD_WORKSPACE_DIR` 环境变量直接返回
- 无标志无环境变量时从 config default 返回
- 无标志无环境变量无 config 时 throw Error
- `--workspace` 与 config default 不同时发出警告
- `--workspace` 与 config default 相同时不警告
- 环境变量与 config default 不同时发出警告
- 发现机制忽略格式错误的 config 文件
- 发现机制忽略没有 workspace section 的 config

### 4.2 新建 workspace 验证测试

**文件**: `packages/principles-core/src/runtime-v2/config/__tests__/pd-config-workspace.test.ts`

测试用例：
- 接受有效的 workspace.default（绝对路径）
- 接受 Windows 风格绝对路径
- 接受 POSIX 风格绝对路径
- 拒绝相对路径
- 拒绝空字符串
- 拒绝非字符串值
- 拒绝缺少 default 字段的 workspace 对象
- 接受没有 workspace section 的 config（可选）
- 拒绝 workspace 中的未知 key

### 4.3 回归验证

- `cd packages/principles-core && pnpm test` — 全部通过
- `cd packages/pd-cli && pnpm test` — 全部通过（20 个现有测试文件零修改）
- `pnpm lint` — 无新警告

---

## 关键文件清单

| 操作 | 文件 |
|---|---|
| 修改 | `packages/principles-core/src/runtime-v2/config/pd-config-types.ts` |
| 修改 | `packages/principles-core/src/runtime-v2/config/pd-config-validate.ts` |
| 修改 | `packages/principles-core/src/runtime-v2/config/pd-config-effective.ts` |
| 修改 | `packages/principles-core/src/runtime-v2/config/pd-config-redaction.ts` |
| 修改 | `packages/principles-core/src/runtime-v2/config/index.ts` |
| 修改 | `packages/pd-cli/src/services/pd-config-loader.ts` |
| 修改 | `packages/pd-cli/src/resolve-workspace.ts` |
| 修改 | `packages/pd-cli/src/commands/config-doctor.ts` |
| 新建 | `packages/pd-cli/tests/resolve-workspace.test.ts` |
| 新建 | `packages/principles-core/tests/pd-config-workspace.test.ts` |
| 修改 | `D:\.openclaw\workspace\.pd\config.yaml` |
| 删除 | `D:\Code\principles\.pd\` (整个目录) |
| 删除 | `D:\Code\principles\.state\` (整个目录) |
| **不修改** | 全部 13 个命令文件（API 签名不变） |
| **不修改** | 全部 20+ 现有测试文件（mock 签名不变） |

---

## 验证方案

1. `cd packages/principles-core && pnpm build && pnpm test` — 类型 + 验证测试通过
2. `cd packages/pd-cli && pnpm build && pnpm test` — 解析 + 现有测试通过
3. `node -e "console.log(require('./packages/pd-cli/dist/resolve-workspace.js').resolveWorkspaceDir())"` — 从项目根目录运行应解析到 `D:\.openclaw\workspace`
4. 手动验证：`pd pain record --reason "test" --workspace "D:\Code\principles"` → 应输出警告但正常执行
5. 手动验证：`pd config doctor` → 应展示 workspace 解析信息
6. 确认 `D:\Code\principles\.pd\` 和 `.state\` 已被删除且未重新创建
