# Principles Disciple - 代码缺陷诊断报告

> **报告日期**: 2026-03-12
> **分析人员**: Claude Code (AI Assistant)
> **报告类型**: 代码缺陷深度诊断
> **版本**: v1.5.2 (已修复)

---

## ✅ 修复状态

| 问题 | 状态 | 修复版本 |
|------|------|----------|
| PD-001 TrustEngine 不持久化 | ✅ 已修复 | v1.5.2 |
| PD-002 PainDictionary 不持久化 | ✅ 已修复 | v1.5.2 |
| PD-003 PainConfig 无 save() | ✅ 已修复 | v1.5.2 |
| PD-004/005/006 路径解析不一致 | ✅ 已修复 | v1.5.2 |

---

## 📋 环境变量配置指南

### 方法一：环境变量 (推荐)

```bash
# 在启动 OpenClaw 时设置
PD_WORKSPACE_DIR=/custom/workspace openclaw-gateway start

# 或在 shell 配置中持久化
echo 'export PD_WORKSPACE_DIR=/home/user/my-workspace' >> ~/.bashrc
```

**可用环境变量**:

| 变量名 | 描述 | 示例 |
|--------|------|------|
| `PD_WORKSPACE_DIR` | 自定义工作区目录 | `/home/user/my-workspace` |
| `PD_STATE_DIR` | 自定义状态目录 | `/home/user/my-workspace/.state` |
| `DEBUG` | 启用调试日志 | `true` |

### 方法二：配置文件 (推荐)

在以下位置创建 `principles-disciple.json`:

1. `./principles-disciple.json` (当前工作目录)
2. `~/.openclaw/principles-disciple.json`
3. `~/.principles/principles-disciple.json`

**配置格式**:
```json
{
  "workspace": "/home/user/my-workspace",
  "state": "/home/user/my-workspace/.state",
  "debug": false
}
```

### 优先级

配置优先级 (从高到低):
1. 环境变量 (`PD_WORKSPACE_DIR`, `PD_STATE_DIR`)
2. 配置文件 (`principles-disciple.json`)
3. OpenClaw 环境变量 (`OPENCLAW_WORKSPACE`)
4. 默认值 (`~/.openclaw/workspace`)

---

## 📋 执行摘要

本报告基于对源码的全面分析，发现以下问题类别：

| 类别 | 问题数 | 严重程度 |
|------|--------|----------|
| 惰性持久化问题 (Load-Only) | 2 | 高 |
| 路径解析不一致 | 5 | 高 |
| 空Catch块风险 | 4 | 中 |
| 类型断言滥用 | 3 | 低 |

---

## 🔴 第一类：惰性持久化问题 (Load-Only Anti-Pattern)

### 问题描述

多个核心组件使用 "先加载，后修改，但忘记保存" 的模式。当文件不存在时创建内存默认值，但不会立即持久化到磁盘，导致：
- 首次运行时数据丢失
- 测试环境行为不一致
- 多实例场景状态不同步

---

### PD-001: TrustEngine - Scorecard 不持久化

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts`

**问题代码** (Line 35-39):
```typescript
constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    this.scorecard = this.loadScorecard();  // ← 只加载，不保存
}
```

**问题代码** (Line 56-93):
```typescript
private loadScorecard(): TrustScorecard {
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    // ...
    if (fs.existsSync(scorecardPath)) {
        // 读取存在的文件
        return data;
    }

    // ❌ 问题：文件不存在时，只返回默认值到内存，不保存到磁盘
    return {
        trust_score: settings.cold_start.initial_trust,
        // ...
    };
}
```

**saveScorecard() 仅在 trust 变化时调用** (Line 217):
```typescript
private updateScore(...): void {
    // ...
    this.saveScorecard();  // ← 只在这里调用！
}
```

**影响**:
- 新安装插件时 scorecard 不存在
- 测试 cleanup 删除后不会自动重建
- 信任系统无法追踪初始状态

**验证方法**:
```bash
# 1. 删除 scorecard
rm -f /home/csuzngjh/clawd/.state/AGENT_SCORECARD.json

# 2. 触发任何需要 trust 的操作
# 3. 检查文件是否被创建
ls -la /home/csuzngjh/clawd/.state/AGENT_SCORECARD.json
# 预期：文件应该存在，但实际不存在
```

---

### PD-002: PainDictionary - 默认规则不持久化

**文件**: `packages/openclaw-plugin/src/core/dictionary.ts`

**问题代码** (Line 55-71):
```typescript
constructor(private stateDir: string) {
    this.filePath = path.join(stateDir, 'pain_dictionary.json');
}

load(): void {
    if (fs.existsSync(this.filePath)) {
        try {
            this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch (e) {
            this.data = { rules: { ...DEFAULT_RULES } };
        }
    } else {
        // ❌ 问题：文件不存在时使用默认规则，但不保存
        this.data = { rules: { ...DEFAULT_RULES } };
    }
    this.compile();
}
```

**flush() 存在但需要手动调用** (Line 134-143):
```typescript
flush(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
}
```

**影响**:
- 首次运行时默认规则在内存中，但不会写入磁盘
- EvolutionWorker 新创建的规则需要手动调用 `flush()` 才能保存
- 如果程序异常退出，新规则会丢失

**验证方法**:
```bash
# 1. 检查是否存在 pain_dictionary.json
ls -la /home/csuzngjh/clawd/.state/pain_dictionary.json

# 2. 如果不存在，说明默认规则未被持久化
# 3. 检查 DEFAULT_RULES 是否在文件中
cat /home/csuzngjh/clawd/.state/pain_dictionary.json | jq '.rules | keys'
```

---

### PD-003: PainConfig - 完全没有 Save 方法

**文件**: `packages/openclaw-plugin/src/core/config.ts`

**问题代码** (Line 179-198):
```typescript
export class PainConfig {
    private settings: PainSettings = { ...DEFAULT_SETTINGS };
    private filePath: string;

    constructor(stateDir: string) {
        this.filePath = path.join(stateDir, 'pain_settings.json');
    }

    load(): void {
        if (fs.existsSync(this.filePath)) {
            try {
                const loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.settings = this.deepMerge(DEFAULT_SETTINGS, loaded);
            } catch (e) {
                console.error('[PD] Failed to parse pain_settings.json, using defaults.');
            }
        }
        // ❌ 问题：没有 else 分支保存默认配置！
    }
    
    // ❌ 没有 save() 方法！
}
```

**严重性**: 这是最严重的问题 - **配置完全没有持久化机制**！

**影响**:
- 用户通过命令修改的配置不会被保存
- 程序重启后所有配置变更丢失
- 无法支持用户自定义配置

**验证方法**:
```bash
# 1. 检查 pain_settings.json 是否存在
ls -la /home/csuzngjh/clawd/.state/pain_settings.json

# 2. 尝试修改配置（通过代码或命令）
# 3. 重启程序
# 4. 检查配置是否保留
```

---

## 🔴 第二类：路径解析不一致

### 问题描述

代码中以不同方式获取 `workspaceDir`，导致在不同 channel 或场景下路径解析结果不同。

### 路径解析模式汇总

| 模式 | 代码 | 使用位置 | 问题 |
|------|------|----------|------|
| **A** | `ctx.workspaceDir \|\| api.resolvePath('.')` | 大部分 hooks | 较好 |
| **B** | `ctx.workspaceDir` (无 fallback) | prompt.ts, subagent.ts | 可能为 undefined |
| **C** | `ctx.workspaceDir \|\| (api as any)?.workspaceDir \|\| api?.resolvePath?.('.')` | pain.ts | 最防御性 |
| **D** | `api.resolvePath('.')` (无 ctx fallback) | index.ts:126, 231, 242 | ❌ 有问题 |
| **E** | `ctx.config?.workspaceDir \|\| process.cwd()` | 所有 commands | ❌ 有问题 |

---

### PD-004: index.ts 中使用 `api.resolvePath('.')` 无 fallback

**文件**: `packages/openclaw-plugin/src/index.ts`

**问题代码** (Line 126):
```typescript
const workspaceDir = api.resolvePath('.');  // ❌ 无 fallback
return handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig, logger });
```

**问题代码** (Line 231):
```typescript
const workspaceDir = api.resolvePath('.');  // ❌ 无 fallback
return { text: handleTrustCommand({ ...ctx, workspaceDir }) };
```

**问题代码** (Line 242):
```typescript
const workspaceDir = api.resolvePath('.');  // ❌ 无 fallback
```

**影响**:
- 当 OpenClaw 以不同工作目录启动时，路径会解析错误
- 某些 channel（如 embedded）可能传递不同的工作目录

---

### PD-005: Commands 中使用 `process.cwd()` 作为 fallback

**文件**: 多处 commands

**问题代码** - `commands/strategy.ts` (Line 5):
```typescript
const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
```

**问题代码** - `commands/pain.ts` (Line 18):
```typescript
const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
```

**问题代码** - `commands/capabilities.ts` (Line 50):
```typescript
const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
```

**问题代码** - `commands/evolver.ts` (Line 12):
```typescript
const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
```

**问题代码** - `commands/thinking-os.ts` (Line 7):
```typescript
return (ctx.config?.workspaceDir as string) || process.cwd();
```

**影响**:
- `process.cwd()` 返回 Node.js 进程启动时的工作目录
- 这不是用户期望的 OpenClaw 工作区目录
- 会导致文件操作到错误位置

---

### PD-006: 实际错误路径分析

**用户报告的错误**:
```
09:32:00 [tools] read failed: ENOENT: no such file or directory, access '/home/csuzngjh/clawd/memory/.state/.pain_flag'
```

**根因分析**:

| 组件 | 预期路径 | 实际路径 |
|------|----------|----------|
| PainConfig | `/home/csuzngjh/clawd/.state/pain_settings.json` | `/home/csuzngjh/clawd/memory/.state/pain_settings.json` |
| PainDictionary | `/home/csuzngjh/clawd/.state/pain_dictionary.json` | `/home/csuzngjh/clawd/memory/.state/pain_dictionary.json` |
| PAIN_FLAG | `/home/csuzngjh/clawd/.state/.pain_flag` | `/home/csuzngjh/clawd/memory/.state/.pain_flag` |

**路径解析过程**:

```
不同 channel 传入的 workspaceDir 不同：
- WhatsApp channel: /home/csuzngjh/clawd
- Embedded agent:  /home/csuzngjh/clawd/memory  ❌

↓

wctx.resolve('PAIN_FLAG') 执行：
path.join(workspaceDir, '.state', '.pain_flag')

↓

结果：
- 正确: /home/csuzngjh/clawd/.state/.pain_flag
- 错误: /home/csuzngjh/clawd/memory/.state/.pain_flag  ❌
```

---

## 🟡 第三类：空 Catch 块风险

### 问题描述

多处使用空 catch 块，吞掉错误而不记录，可能导致难以调试的问题。

### PD-007: 空 Catch 块汇总

| 文件 | 行号 | 代码 |
|------|------|------|
| `hooks/pain.ts` | 85 | `} catch (_e) {}` |
| `hooks/pain.ts` | 162 | `} catch (_e) {}` |
| `core/hygiene/tracker.ts` | 48 | `} catch (_renameErr) {}` |
| `tools/deep-reflect.ts` | 207 | `.catch(() => {});` |

**具体代码** - `hooks/pain.ts` (Line 84-86):
```typescript
try {
    // ... 路径解析和文件操作
} catch (_e) {}  // ❌ 错误被完全吞掉
```

**影响**:
- 文件不存在时静默失败
- 权限错误被忽略
- 调试时无法知道发生了什么

---

## 🟢 第四类：类型断言滥用

### 问题描述

多处使用 `as any` 或不安全的类型断言，降低了类型安全。

### PD-008: 类型断言汇总

| 文件 | 行号 | 代码 |
|------|------|------|
| `hooks/pain.ts` | 34 | `(api as any)?.workspaceDir` |
| `hooks/pain.ts` | 63 | `(event.result as any).exitCode` |
| `tools/deep-reflect.ts` | 87 | `(api.config?.workspaceDir as string)` |
| `core/trust-engine.ts` | 264 | `(dummy as any).calculateSuccessRate(scorecard)` |

**具体代码** - `hooks/pain.ts` (Line 34):
```typescript
const effectiveWorkspaceDir = ctx.workspaceDir || (api as any)?.workspaceDir || api?.resolvePath?.('.');
```

**影响**:
- TypeScript 类型检查被绕过
- 运行时可能抛出意外错误
- API 变更时无法通过类型检测发现

---

## 🔍 专家核实与延伸发现 (Spicy Evolver Addendum)

> **核实日期**: 2026-03-12
> **核实人员**: Spicy Evolver (Gemini CLI)
> **核实状态**: PD-001 至 PD-008 全部确认属实。

### 🚨 延伸发现 PD-009: EvolutionWorker 状态漂移 (Background Drift)

**文件**: `packages/openclaw-plugin/src/service/evolution-worker.ts`

**问题描述**:
该服务直接通过 `wctx.resolve('EVOLUTION_QUEUE')` 定位任务队列。由于其启动时依赖的 `workspaceDir` 可能因 PD-004/005 的解析逻辑而漂移，导致 `EvolutionWorker` 在错误的子目录下启动。
- **后果**: 用户看到有疼痛信号，但后台进化任务永远不会触发，因为 Worker 正在扫描一个空的 `.state` 目录。

---

### 🚨 延伸发现 PD-010: Init.ts 模板初始化不幂等 (Template Fragility)

**文件**: `packages/openclaw-plugin/src/core/init.ts`

**问题描述**:
`ensureWorkspaceTemplates` 逻辑仅检查文件是否存在 (`fs.existsSync`)。
- **后果**: 如果用户由于误操作产生了一个 0 字节的 `PROFILE.json` 或内容损坏的文件，系统不会尝试从模板修复它，而是会持续抛出 JSON 解析错误（PD-007 的黑洞会掩盖这一点）。

---

## 📊 修正优先级建议 (Remediation Roadmap)

1. **P0 (Blocker)**: 
   - **PD-006 & PD-004/005**: 重写 `WorkspaceContext` 引入“路径脱水”机制，强制剔除子目录后缀。
   - **PD-003**: 为 `PainConfig` 补齐 `save()` 方法。
2. **P1 (Critical)**:
   - **PD-001 & PD-002**: 强制初始化时的物理落盘（Sync on load-miss）。
   - **PD-007**: 清理所有空 catch 块，引入统一日志规范。
3. **P2 (Maintenance)**:
   - **PD-008**: 消除 `as any`，对齐官方 SDK 类型。
   - **PD-010**: 实现模板完整性校验。

---

## ✅ 最终核实结论

本诊断报告所列缺陷是 v1.5.0 架构重构后的典型“后遗症”，主要由于**物理路径假设与运行时环境解耦不彻底**导致。

**建议行动**: 立即批准 **v1.5.2 魯棒性专项修复计划**。

---
*专家核实结束*

---

# 🔬 代码核实报告 (Code Verification Report)

> **核实日期**: 2026-03-12  
> **核实人员**: Claude Code (Current Session)  
> **核实状态**: 全部完成 + 发现新问题

---

## 📋 核实摘要

| 问题编号 | 原报告状态 | 核实结果 | 严重程度 |
|---------|-----------|---------|---------|
| PD-001 | 高 | ✅ 确认属实 | 高 |
| PD-002 | 高 | ✅ 确认属实 | 高 |
| PD-003 | 高 | ✅ 确认属实 - **最严重** | 高 |
| PD-004 | 高 | ✅ 确认属实 | 高 |
| PD-005 | 高 | ✅ 确认属实 | 高 |
| PD-006 | 高 | ✅ 确认属实 | 高 |
| PD-007 | 中 | ✅ 确认属实 | 中 |
| PD-008 | 低 | ✅ 确认属实 | 低 |
| PD-009 | 高 | ✅ 确认属实 | 高 |
| PD-010 | 中 | ✅ 确认属实 | 中 |
| **PD-NEW-001** | - | 🔴 **新发现** | 中 |
| **PD-NEW-002** | - | 🔴 **新发现** | 高 |

---

## ✅ 原报告问题核实详情

### PD-001: TrustEngine - Scorecard 不持久化 ✅ 确认

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts`

**核实发现**:
- **Line 35-39**: Constructor 仅调用 `loadScorecard()`，没有保存逻辑
- **Line 56-93**: `loadScorecard()` 当文件不存在时返回默认值 `{ trust_score: 85, ... }`，但不写入磁盘
- **Line 217**: `saveScorecard()` **仅在** `applyTrustChange()` 中调用，首次运行时不会触发

**代码证据**:
```typescript
// Line 35-39: Constructor
constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    this.scorecard = this.loadScorecard();  // ← 只加载，不保存
}

// Line 56-93: loadScorecard returns defaults without saving
if (fs.existsSync(scorecardPath)) {
    return data;
}
// ❌ 问题：文件不存在时，只返回默认值到内存，不保存到磁盘
return { trust_score: 85, ... };
```

**影响确认**:
- 新安装插件时 AGENT_SCORECARD.json 不会自动创建
- 测试 cleanup 删除后不会自动重建
- 信任系统无法追踪初始状态

---

### PD-002: PainDictionary - 默认规则不持久化 ✅ 确认

**文件**: `packages/openclaw-plugin/src/core/dictionary.ts`

**核实发现**:
- **Line 67-69**: `load()` 方法当文件不存在时使用默认规则，但不调用 `flush()`
- **Line 134-143**: `flush()` 方法存在，但需要手动调用
- **Line 95-143**: `load()` 方法在任何路径都不自动保存

**代码证据**:
```typescript
// Line 67-69: load() doesn't save defaults
} else {
    this.data = { rules: { ...DEFAULT_RULES } };
    // ❌ 问题：不调用 flush() 持久化默认规则
    this.compile();
}

// Line 134-143: flush() exists but requires manual call
flush(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
}
```

**影响确认**:
- 首次运行时默认规则仅存在于内存
- 程序异常退出会导致规则丢失

---

### PD-003: PainConfig - 完全没有 Save 方法 ✅ 确认 (最严重)

**文件**: `packages/openclaw-plugin/src/core/config.ts`

**核实发现**:
- **Line 146-198**: 整个 `PainConfig` 类**没有任何 save() 方法**
- **Line 187-198**: `load()` 方法没有 else 分支保存默认配置
- 用户修改配置后**无法持久化**

**代码证据**:
```typescript
// Line 187-198: load() method
load(): void {
    if (fs.existsSync(this.filePath)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            this.settings = this.deepMerge(DEFAULT_SETTINGS, loaded);
        } catch (e) {
            console.error('[PD] Failed to parse pain_settings.json, using defaults.');
        }
    }
    // ❌ 问题：没有 else 分支保存默认配置！
}

// ❌ 整个类没有任何 save() 方法！
```

**严重性评估**: **这是最严重的问题** - 配置完全没有持久化机制！

---

### PD-004: index.ts 中使用 `api.resolvePath('.')` 无 fallback ✅ 确认

**文件**: `packages/openclaw-plugin/src/index.ts`

**核实发现**:
- **Line 126**: `const workspaceDir = api.resolvePath('.');` ❌ 无 fallback
- **Line 231**: `const workspaceDir = api.resolvePath('.');` ❌ 无 fallback
- **Line 242**: `const workspaceDir = api.resolvePath('.');` ❌ 无 fallback
- 其他 7 处都有 `ctx.workspaceDir || fallback` ✅

**代码证据**:
```typescript
// Line 126 - ❌ No fallback
const workspaceDir = api.resolvePath('.');
return handleBeforeToolCall(event, { ...ctx, workspaceDir, pluginConfig, logger });

// Line 231 - ❌ No fallback
const workspaceDir = api.resolvePath('.');
return { text: handleTrustCommand({ ...ctx, workspaceDir }) };

// Line 242 - ❌ No fallback
const workspaceDir = api.resolvePath('.');
```

**影响确认**: 当 OpenClaw 以不同工作目录启动时，路径会解析错误

---

### PD-005: Commands 中使用 `process.cwd()` 作为 fallback ✅ 确认

**文件**: `packages/openclaw-plugin/src/commands/` (5个文件)

**核实发现**:
所有 commands 使用相同的有害模式：
- **strategy.ts** (Line 5)
- **pain.ts** (Line 18)
- **capabilities.ts** (Line 50)
- **evolver.ts** (Line 12)
- **thinking-os.ts** (Line 7)

**代码证据**:
```typescript
// ❌ 所有 5 个 commands 都使用此模式
const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
```

**问题**: `process.cwd()` 返回 Node.js 进程启动时的工作目录，不是用户期望的 OpenClaw 工作区目录

---

### PD-006: 实际错误路径分析 ✅ 确认

**用户报告的错误**:
```
09:32:00 [tools] read failed: ENOENT: no such file or directory, access '/home/csuzngjh/clawd/memory/.state/.pain_flag'
```

**根因确认**: 路径解析在不同 channel 产生不同结果：
- WhatsApp channel: `/home/csuzngjh/clawd` ✅
- Embedded agent: `/home/csuzngjh/clawd/memory` ❌

---

### PD-007: 空 Catch 块风险 ✅ 确认

**核实位置**:
- `hooks/pain.ts` (Line 85): `} catch (_e) {}`
- `hooks/pain.ts` (Line 162): `} catch (_e) {}`
- `core/hygiene/tracker.ts` (Line 48): `} catch (_renameErr) {}`
- `tools/deep-reflect.ts` (Line 207): `.catch(() => {});`

---

### PD-008: 类型断言滥用 ✅ 确认

**核实位置**:
- `hooks/pain.ts` (Line 34): `(api as any)?.workspaceDir`
- `hooks/pain.ts` (Line 63): `(event.result as any).exitCode`
- `tools/deep-reflect.ts` (Line 87): `(api.config?.workspaceDir as string)`
- `core/trust-engine.ts` (Line 264): `(dummy as any).calculateSuccessRate(scorecard)`

---

### PD-009: EvolutionWorker 状态漂移 ✅ 确认

**文件**: `packages/openclaw-plugin/src/service/evolution-worker.ts`

**核实发现**:
- **Line 27**: `const painFlagPath = wctx.resolve('PAIN_FLAG');`
- **Line 51**: `const queuePath = wctx.resolve('EVOLUTION_QUEUE');`
- EvolutionWorker 依赖 `workspaceDir` 解析，如果路径漂移会在错误的目录扫描

---

### PD-010: Init.ts 模板初始化不幂等 ✅ 确认

**文件**: `packages/openclaw-plugin/src/core/init.ts`

**核实发现**: `ensureWorkspaceTemplates` 仅检查 `fs.existsSync`，不验证文件内容完整性

---

## 🔴 新发现问题

### PD-NEW-001: HygieneTracker - 部分惰性持久化

**文件**: `packages/openclaw-plugin/src/core/hygiene/tracker.ts`

**问题**: Constructor 仅加载默认统计，不立即保存

**代码证据**:
```typescript
// Line 27: Constructor
constructor(private workspaceDir: string) {
    this.statsPath = path.join(workspaceDir, '.state', 'hygiene_stats.json');
    this.currentStats = this.loadStats();  // ← 只加载，不保存
}

// Line 51: Returns defaults without saving
return createEmptyHygieneStats(today);
```

**缓解措施**: 
- Line 95: `recordChange()` 调用 `saveStats()`
- Line 105: `resetDaily()` 调用 `saveStats()`

**评估**: 有缓解措施，但初始化时仍可能丢失空文件

---

### PD-NEW-002: SessionTracker - Load-Only 模式

**文件**: `packages/openclaw-plugin/src/core/session-tracker.ts`

**问题**: `loadSessionData()` 返回空 Map 时不保存

**代码证据**:
```typescript
// Line 60-65: loadSessionData
private loadSessionData(): Map<string, SessionData> {
    const sessionDataPath = path.join(this.stateDir, 'session_data.json');
    if (!fs.existsSync(sessionDataPath)) {
        return new Map();  // ❌ 返回空 Map，不创建文件
    }
    // ...
}
```

**影响**: 首次运行时 session_data.json 不会创建

---

## 📊 代码库范围搜索结果

### Load-Only 模式扫描

搜索模式：`return.*{.*}` (在 load 方法中返回默认值但不保存)

**发现结果**:
1. ✅ PD-001: trust-engine.ts (Line 58-61)
2. ✅ PD-002: dictionary.ts (Line 67-69)
3. ✅ PD-NEW-001: hygiene/tracker.ts (Line 51)
4. ✅ PD-NEW-002: session-tracker.ts (Line 62)
5. ⚠️ event-log.ts: Line 163-165 有自动保存机制 ✅

### 路径解析不一致扫描

搜索 `process.cwd()` 和 `api.resolvePath('.')`:

**process.cwd() 使用**: 5 处 (PD-005)
**api.resolvePath('.') 无 fallback**: 3 处 (PD-004)

---

## 🔍 修复优先级建议 (基于核实结果)

### P0 (Blocker) - 必须立即修复

1. **PD-003**: PainConfig 添加 save() 方法
2. **PD-006**: 统一 workspaceDir 解析逻辑

### P1 (Critical) - 高优先级

3. **PD-001**: TrustEngine 首次加载时保存 scorecard
4. **PD-002**: PainDictionary 首次加载时保存默认规则
5. **PD-004/005**: 所有路径解析使用一致模式

### P2 (Maintenance) - 中优先级

6. **PD-007**: 添加错误日志到空 catch 块
7. **PD-009**: EvolutionWorker 路径验证
8. **PD-NEW-001/002**: 新发现的 Load-Only 问题

---

## ✅ 核实结论

**原报告准确性**: **100% 准确** - 所有 10 个问题均已确认属实

**新增发现**: 2 个新的 Load-Only 模式问题

**总体评估**: 原报告质量极高，问题分析准确，代码证据充分。新发现的问题进一步证实了架构层面的"惰性持久化"模式是系统性的。

**建议行动**: 完全同意原报告建议 - 立即批准 **v1.5.2 鲁棒性专项修复计划**。

---

*核实报告结束 - 2026-03-12*
