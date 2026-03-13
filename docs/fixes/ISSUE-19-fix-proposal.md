# ISSUE-19: Cron 会话信任隔离修复方案

> **修复提案日期**: 2026-03-12
> **提案人**: Diagnostician 子智能体
> **Issue ID**: #19
> **状态**: 🟡 待实施
> **优先级**: 🟠 P1 - 高优先级

---

## 📊 问题根因分析

### 根因 #1: 缺少 Session 类型识别

**描述**: gate.ts 没有区分 Cron 会话、Isolated 会话和普通用户会话

**代码位置**: `packages/openclaw-plugin/src/hooks/gate.ts` Line 36-47

**当前逻辑**:
```typescript
export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'replace', 'insert', 'patch', 'edit_file', 'delete_file', 'move_file'];
  const BASH_TOOLS = ['bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd'];
  
  const isBash = BASH_TOOLS.includes(event.toolName);
  const isWriteTool = WRITE_TOOLS.includes(event.toolName);
  
  if (!ctx.workspaceDir || (!isWriteTool && !isBash)) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);
  // ...
```

**缺失**: 会话类型识别逻辑

**影响**:
- Cron 任务无法享受特殊权限
- 管理员无法为维护性操作设置例外
- 信任分下降时，Cron 任务可能被意外阻止

---

### 根因 #2: 所有会话共享同一 Trust Scorecard

**描述**: TrustEngine 在构造时使用 workspaceDir 加载 scorecard，没有考虑 session 类型

**代码位置**: `packages/openclaw-plugin/src/core/trust-engine.ts`

```typescript
export class TrustEngine {
    private scorecard: TrustScorecard;
    private workspaceDir: string;
    private stateDir: string;

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
        this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
        this.scorecard = this.loadScorecard();  // ← 使用固定的 scorecard 路径

        const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
        if (!fs.existsSync(scorecardPath)) {
            this.saveScorecard();
        }
    }
    // ...
}
```

**WorkspaceContext.fromHookContext**:
```typescript
static fromHookContext(ctx: PluginHookToolContext): WorkspaceContext {
    const workspaceDir = ctx.workspaceDir || process.cwd();
    const stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');

    return new WorkspaceContext({
        workspaceDir,
        stateDir,
        config: ConfigService.get(stateDir),
        trust: new TrustEngine(workspaceDir),  // ← 所有会话共享同一个 TrustEngine
        dictionary: PainDictionary.get(stateDir),
        eventLog: EventLogService.get(stateDir)
    });
}
```

**问题**:
- 所有 session 使用同一个 `AGENT_SCORECARD.json`
- Cron 任务失败会降低整个系统的信任分
- 普通用户操作失败也会影响 Cron 任务

**实际场景**:
1. 用户安装插件，开始使用（85 分）
2. 用户探索期多次失败 → 信任分降到 50 分（Stage 2）
3. Cron 任务定时执行维护操作
4. Cron 任务因为 50 分被限制（Stage 2 的行数限制、风险路径限制）
5. 维护性操作失败，系统状态异常

---

### 根因 #3: 缺少独立 Trust Scorecard 池机制

**描述**: 没有为不同类型的会话（用户、Cron、Admin）提供独立的 scorecard 池

**当前架构**:
```
Workspace
└── .state
    └── AGENT_SCORECARD.json  ← 唯一的 scorecard
```

**缺失的架构**:
```
Workspace
└── .state
    ├── AGENT_SCORECARD.json          ← 用户会话 scorecard
    ├── AGENT_SCORECARD_CRON.json     ← Cron 会话 scorecard
    └── AGENT_SCORECARD_ADMIN.json    ← Admin 会话 scorecard
```

**影响**:
- 无法为 Cron 任务设置独立的初始信任分
- Cron 任务无法独立演进信任
- 无法为不同类型的会话应用不同的信任策略

---

### 根因 #4: 缺少会话隔离配置

**描述**: 配置文件中没有定义 session 类型和对应的信任策略

**当前配置** (`packages/openclaw-plugin/src/core/config.ts`):
```typescript
export interface TrustSettings {
    stages: { /* ... */ };
    cold_start: { /* ... */ };
    penalties: { /* ... */ };
    rewards: { /* ... */ };
    limits: { /* ... */ };
    history_limit?: number;
}
```

**缺失**:
```typescript
export interface TrustSettings {
    // ... 现有字段 ...

    sessions?: {
        user?: SessionTrustConfig;      // 用户会话配置
        cron?: SessionTrustConfig;      // Cron 会话配置
        admin?: SessionTrustConfig;     // Admin 会话配置
    };
}

export interface SessionTrustConfig {
    enabled: boolean;
    scorecard_pool?: string;           // scorecard 文件后缀（如 "_cron"）
    initial_trust?: number;            // 初始信任分
    grace_failures?: number;           // Grace 次数
    limits?: {
        stage_2_max_lines?: number;
        stage_3_max_lines?: number;
    };
}
```

---

## 🎯 修复方案设计

### 方案 A: Session 类型识别（推荐）

**目标**: 添加会话类型识别逻辑，区分用户、Cron、Admin 会话

#### 步骤 A.1: 定义 Session 类型枚举

**文件**: `packages/openclaw-plugin/src/core/session-types.ts`（新文件）

```typescript
/**
 * Session Type Enumeration
 * Differentiates between user-initiated, automated, and admin sessions
 */
export enum SessionType {
    USER = 'user',           // Normal user session (interactive)
    CRON = 'cron',           // Scheduled task session (automated)
    ADMIN = 'admin',         // Admin session (elevated)
    ISOLATED = 'isolated'    // Isolated session (ephemeral, no trust impact)
}

/**
 * Session metadata structure
 */
export interface SessionMetadata {
    type?: SessionType;
    isolated?: boolean;
    cron_schedule?: string;   // Cron expression (e.g., "0 * * * *")
    elevated?: boolean;       // Elevated privileges
    trust_pool?: string;     // Scorecard pool suffix (e.g., "_cron")
}

/**
 * Extract session type from context
 */
export function detectSessionType(ctx: PluginHookToolContext): SessionType {
    const metadata = ctx.session?.metadata as SessionMetadata | undefined;

    if (metadata?.type) {
        return metadata.type;
    }

    if (metadata?.isolated) {
        return SessionType.ISOLATED;
    }

    if (ctx.session?.channel === 'discord' || ctx.session?.channel === 'slack') {
        // Scheduled tasks via messaging platform
        return SessionType.CRON;
    }

    if (metadata?.elevated) {
        return SessionType.ADMIN;
    }

    return SessionType.USER;
}

/**
 * Get trust pool suffix for session type
 */
export function getTrustPoolSuffix(sessionType: SessionType): string {
    switch (sessionType) {
        case SessionType.CRON:
            return '_cron';
        case SessionType.ADMIN:
            return '_admin';
        case SessionType.ISOLATED:
            return '_isolated';
        case SessionType.USER:
        default:
            return '';
    }
}
```

#### 步骤 A.2: 修改 WorkspaceContext 支持 Session Type

**文件**: `packages/openclaw-plugin/src/core/workspace-context.ts`

```typescript
import { detectSessionType, getTrustPoolSuffix, SessionType } from './session-types.js';

export class WorkspaceContext {
    public readonly workspaceDir: string;
    public readonly stateDir: string;
    public readonly config: ConfigService;
    public readonly trust: TrustEngine;
    public readonly dictionary: PainDictionary;
    public readonly eventLog: EventLogService;
    public readonly sessionType: SessionType;  // ← 新增

    private constructor(props: {
        workspaceDir: string;
        stateDir: string;
        config: ConfigService;
        trust: TrustEngine;
        dictionary: PainDictionary;
        eventLog: EventLogService;
        sessionType?: SessionType;  // ← 新增
    }) {
        this.workspaceDir = props.workspaceDir;
        this.stateDir = props.stateDir;
        this.config = props.config;
        this.trust = props.trust;
        this.dictionary = props.dictionary;
        this.eventLog = props.eventLog;
        this.sessionType = props.sessionType || SessionType.USER;  // ← 新增
    }

    static fromHookContext(ctx: PluginHookToolContext): WorkspaceContext {
        const workspaceDir = ctx.workspaceDir || process.cwd();
        const stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');

        // 🔧 新增：检测会话类型
        const sessionType = detectSessionType(ctx);
        const trustPoolSuffix = getTrustPoolSuffix(sessionType);

        return new WorkspaceContext({
            workspaceDir,
            stateDir,
            config: ConfigService.get(stateDir),
            trust: new TrustEngine(workspaceDir, trustPoolSuffix),  // ← 传递 pool suffix
            dictionary: PainDictionary.get(stateDir),
            eventLog: EventLogService.get(stateDir),
            sessionType  // ← 传递 session type
        });
    }

    /**
     * Check if this is a Cron/Isolated session
     */
    isAutomatedSession(): boolean {
        return this.sessionType === SessionType.CRON ||
               this.sessionType === SessionType.ISOLATED;
    }

    /**
     * Check if this is an elevated (Admin) session
     */
    isElevatedSession(): boolean {
        return this.sessionType === SessionType.ADMIN;
    }
}
```

---

### 方案 B: 独立 Trust Scorecard 池（推荐）

**目标**: 为不同类型的会话提供独立的 scorecard 文件

#### 步骤 B.1: 修改 TrustEngine 构造函数

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts`

```typescript
export class TrustEngine {
    private scorecard: TrustScorecard;
    private workspaceDir: string;
    private stateDir: string;
    private poolSuffix: string;  // ← 新增：scorecard 池后缀

    constructor(workspaceDir: string, poolSuffix: string = '') {
        this.workspaceDir = workspaceDir;
        this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
        this.poolSuffix = poolSuffix;
        this.scorecard = this.loadScorecard();

        const scorecardPath = this.getScorecardPath();  // ← 使用新方法
        if (!fs.existsSync(scorecardPath)) {
            this.saveScorecard();
        }
    }

    /**
     * Get scorecard file path based on pool suffix
     */
    private getScorecardPath(): string {
        const baseName = 'AGENT_SCORECARD';
        return resolvePdPath(this.workspaceDir, `${baseName}${this.poolSuffix}`);
    }

    private loadScorecard(): TrustScorecard {
        const scorecardPath = this.getScorecardPath();  // ← 使用新方法
        const settings = this.getTrustSettings(this.poolSuffix);  // ← 根据池获取设置

        if (fs.existsSync(scorecardPath)) {
            try {
                const raw = fs.readFileSync(scorecardPath, 'utf8');
                const data = JSON.parse(raw);
                if (data.score !== undefined && data.trust_score === undefined) data.trust_score = data.score;
                if (!data.history) data.history = [];
                if (data.exploratory_failure_streak === undefined) data.exploratory_failure_streak = 0;
                return data;
            } catch (e) {
                console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard at ${scorecardPath}. Resetting.`);
            }
        }

        // Create new scorecard with pool-specific settings
        const now = new Date();
        const coldStartEnd = new Date(now.getTime() + settings.cold_start.cold_start_period_ms);

        return {
            trust_score: settings.cold_start.initial_trust,
            success_streak: 0,
            failure_streak: 0,
            exploratory_failure_streak: 0,
            grace_failures_remaining: settings.cold_start.grace_failures,
            last_updated: now.toISOString(),
            cold_start_end: coldStartEnd.toISOString(),
            first_activity_at: now.toISOString(),
            history: []
        };
    }

    /**
     * Get trust settings with pool-specific overrides
     */
    private getTrustSettings(poolSuffix: string): any {
        const baseSettings = this.config.get('trust') || {
            stages: { stage_1_observer: 30, stage_2_editor: 60, stage_3_developer: 80 },
            cold_start: { initial_trust: 85, grace_failures: 5, cold_start_period_ms: 86400000 },
            penalties: { tool_failure_base: -2, risky_failure_base: -10, gate_bypass_attempt: -5, failure_streak_multiplier: -2, max_penalty: -20 },
            rewards: { success_base: 2, subagent_success: 5, tool_success_reward: 0.2, streak_bonus_threshold: 3, streak_bonus: 5, recovery_boost: 5, max_reward: 15 },
            limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
        };

        // 🔧 新增：应用会话特定配置
        const sessions = this.config.get('trust.sessions');
        if (sessions) {
            let sessionConfig;
            if (poolSuffix === '_cron') {
                sessionConfig = sessions.cron;
            } else if (poolSuffix === '_admin') {
                sessionConfig = sessions.admin;
            } else if (poolSuffix === '_isolated') {
                sessionConfig = sessions.isolated;
            }

            if (sessionConfig && sessionConfig.enabled) {
                // Override settings
                const settings = { ...baseSettings };

                if (sessionConfig.initial_trust !== undefined) {
                    settings.cold_start.initial_trust = sessionConfig.initial_trust;
                }
                if (sessionConfig.grace_failures !== undefined) {
                    settings.cold_start.grace_failures = sessionConfig.grace_failures;
                }
                if (sessionConfig.limits) {
                    settings.limits = { ...settings.limits, ...sessionConfig.limits };
                }

                return settings;
            }
        }

        return baseSettings;
    }

    private saveScorecard(): void {
        const scorecardPath = this.getScorecardPath();  // ← 使用新方法
        try {
            const dir = path.dirname(scorecardPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(scorecardPath, JSON.stringify(this.scorecard, null, 2), 'utf8');
        } catch (e) {
            console.error(`[PD:TrustEngine] Failed to save scorecard: ${String(e)}`);
        }
    }

    // ... rest of the methods ...
}
```

---

### 方案 C: 会话隔离配置（推荐）

**目标**: 在配置文件中定义不同会话类型的信任策略

#### 步骤 C.1: 更新配置文件结构

**文件**: `packages/openclaw-plugin/src/core/config.ts`

```typescript
export interface TrustSettings {
    stages: {
        stage_1_observer: number;
        stage_2_editor: number;
        stage_3_developer: number;
    };
    cold_start: {
        initial_trust: number;
        grace_failures: number;
        cold_start_period_ms: number;
    };
    penalties: {
        tool_failure_base: number;
        risky_failure_base: number;
        gate_bypass_attempt: number;
        failure_streak_multiplier: number;
        max_penalty: number;
    };
    rewards: {
        success_base: number;
        subagent_success: number;
        tool_success_reward: number;
        streak_bonus_threshold: number;
        streak_bonus: number;
        recovery_boost: number;
        max_reward: number;
    };
    limits: {
        stage_2_max_lines: number;
        stage_3_max_lines: number;
    };
    history_limit?: number;

    // 🔧 新增：会话隔离配置
    sessions?: {
        user?: SessionTrustConfig;
        cron?: SessionTrustConfig;
        admin?: SessionTrustConfig;
        isolated?: SessionTrustConfig;
    };
}

export interface SessionTrustConfig {
    enabled: boolean;
    initial_trust?: number;           // 覆盖 cold_start.initial_trust
    grace_failures?: number;          // 覆盖 cold_start.grace_failures
    cold_start_period_ms?: number;     // 覆盖 cold_start.cold_start_period_ms
    limits?: {
        stage_2_max_lines?: number;    // 覆盖 limits.stage_2_max_lines
        stage_3_max_lines?: number;    // 覆盖 limits.stage_3_max_lines
    };
    penalties?: {
        tool_failure_base?: number;    // 覆盖 penalties.tool_failure_base
        risky_failure_base?: number;   // 覆盖 penalties.risky_failure_base
    };
}
```

#### 步骤 C.2: 添加默认配置

```typescript
export const DEFAULT_SETTINGS: PainSettings = {
    language: 'zh',
    thresholds: { /* ... */ },
    scores: { /* ... */ },
    severity_thresholds: { /* ... */ },
    intervals: { /* ... */ },
    trust: {
        stages: {
            stage_1_observer: 30,
            stage_2_editor: 60,
            stage_3_developer: 80,
        },
        cold_start: {
            initial_trust: 85,
            grace_failures: 5,
            cold_start_period_ms: 24 * 60 * 60 * 1000,
        },
        penalties: {
            tool_failure_base: -2,
            risky_failure_base: -10,
            gate_bypass_attempt: -5,
            failure_streak_multiplier: -2,
            max_penalty: -20,
        },
        rewards: {
            success_base: 2,
            subagent_success: 5,
            tool_success_reward: 0.2,
            streak_bonus_threshold: 3,
            streak_bonus: 5,
            recovery_boost: 5,
            max_reward: 15,
        },
        limits: {
            stage_2_max_lines: 50,
            stage_3_max_lines: 300,
        },
        history_limit: 50,

        // 🔧 新增：会话隔离默认配置
        sessions: {
            user: {
                enabled: false,  // 用户会话使用全局配置
            },
            cron: {
                enabled: true,   // Cron 会话使用独立配置
                initial_trust: 90,  // Cron 任务默认信任分 90（Stage 4）
                grace_failures: 10,  // Cron 允许 10 次失败
                limits: {
                    stage_2_max_lines: 100,  // Cron Stage 2 限制 100 行
                    stage_3_max_lines: 600,  // Cron Stage 3 限制 600 行
                },
                penalties: {
                    tool_failure_base: -1,  // Cron 失败惩罚更轻
                    risky_failure_base: -5,
                }
            },
            admin: {
                enabled: true,
                initial_trust: 100,  // Admin 会话默认 100 分（无限制）
                grace_failures: 20,  // Admin 允许 20 次失败
                limits: {
                    stage_2_max_lines: -1,  // -1 = 无限制
                    stage_3_max_lines: -1,
                }
            },
            isolated: {
                enabled: true,
                initial_trust: 70,  // Isolated 会话默认 70 分（Stage 3）
                grace_failures: 5,
                limits: {
                    stage_2_max_lines: 75,
                    stage_3_max_lines: 450,
                }
            }
        }
    },
    deep_reflection: { /* ... */ }
};
```

---

### 方案 D: Gate 集成会话隔离（推荐）

**目标**: 在 gate.ts 中使用会话类型进行差异化限制

#### 步骤 D.1: 修改 gate.ts

**文件**: `packages/openclaw-plugin/src/hooks/gate.ts`

```typescript
import { detectSessionType, SessionType } from '../core/session-types.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // 1. Identify tool type
  const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'write_file', 'replace', 'insert', 'patch', 'edit_file', 'delete_file', 'move_file'];
  const BASH_TOOLS = ['bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd'];
  
  const isBash = BASH_TOOLS.includes(event.toolName);
  const isWriteTool = WRITE_TOOLS.includes(event.toolName);
  
  if (!ctx.workspaceDir || (!isWriteTool && !isBash)) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);

  // 🔧 新增：记录会话类型
  const sessionType = detectSessionType(ctx);
  logger.info(`[PD_GATE] Session type: ${sessionType}, Is automated: ${wctx.isAutomatedSession()}`);

  // 2. Load Profile
  const profilePath = wctx.resolve('PROFILE');
  // ... 现有 profile 加载逻辑 ...

  // ── PROGRESSIVE GATE LOGIC ──
  if (profile.progressive_gate?.enabled) {
    const trustEngine = wctx.trust;
    const trustScore = trustEngine.getScore();
    const stage = trustEngine.getStage();
    const trustSettings = wctx.config.get('trust');

    const riskLevel = assessRiskLevel(relPath, { toolName: event.toolName, params: event.params }, profile.risk_paths);
    const lineChanges = estimateLineChanges({ toolName: event.toolName, params: event.params });

    logger.info(`[PD_GATE] Trust: ${trustScore} (Stage ${stage}), Risk: ${riskLevel}, Path: ${relPath}`);

    // 🔧 新增：Admin 会话绕过所有限制
    if (wctx.isElevatedSession()) {
        logger.info(`[PD_GATE] Admin bypass for ${relPath}`);
        return;  // Allow all operations
    }

    // 🔧 新增：Cron/Isolated 会话使用独立的信任分数和限制
    const isAutomated = wctx.isAutomatedSession();
    if (isAutomated) {
        logger.info(`[PD_GATE] Automated session detected, using session-specific trust pool`);
        // TrustEngine 已经使用独立 scorecard，无需额外处理
    }

    // Stage 1 (Bankruptcy): Block ALL writes to risk paths, and all medium+ writes
    if (stage === 1) {
        // 🔧 新增：Cron 会话在 Stage 1 仍然允许 PLAN 白名单
        if (isAutomated && profile.progressive_gate?.plan_approvals?.enabled) {
            // ... PLAN 白名单逻辑 ...
        }

        if (risky || riskLevel !== 'LOW') {
            return block(relPath, `Trust score too low (${trustScore}). Stage 1 agents cannot modify risk paths or perform non-trivial edits.`, wctx, event.toolName);
        }
    }

    // Stage 2 (Editor): Block writes to risk paths. Block large changes.
    if (stage === 2) {
        if (risky) {
            return block(relPath, `Stage 2 agents are not authorized to modify risk paths.`, wctx, event.toolName);
        }

        // 🔧 新增：使用会话特定限制（TrustEngine 已经应用）
        const stage2Limit = trustSettings.limits?.stage_2_max_lines ?? 50;
        if (lineChanges > stage2Limit) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 2. Max allowed is ${stage2Limit}.`, wctx, event.toolName);
        }
    }

    // Stage 3 (Developer): Allow normal writes. Require READY plan for risk paths.
    if (stage === 3) {
        if (risky) {
            const planStatus = getPlanStatus(ctx.workspaceDir);
            if (planStatus !== 'READY') {
                return block(relPath, `No READY plan found. Stage 3 requires a plan for risk path modifications.`, wctx, event.toolName);
            }
        }

        // 🔧 新增：使用会话特定限制（TrustEngine 已经应用）
        const stage3Limit = trustSettings.limits?.stage_3_max_lines ?? 300;
        if (lineChanges > stage3Limit) {
            return block(relPath, `Modification too large (${lineChanges} lines) for Stage 3. Max allowed is ${stage3Limit}.`, wctx, event.toolName);
        }
    }

    // Stage 4 (Architect): Full bypass
    if (stage === 4) {
        logger.info(`[PD_GATE] Trusted Architect bypass for ${relPath}`);
        return;
    }
  } else {
    // FALLBACK: Legacy Gate Logic
    if (risky && profile.gate?.require_plan_for_risk_paths) {
      const planStatus = getPlanStatus(ctx.workspaceDir);
      if (planStatus !== 'READY') {
        return block(relPath, `No READY plan found in PLAN.md.`, wctx, event.toolName);
      }
    }
  }
}
```

---

## 📊 修复效果对比

### 对比 #1: Scorecard 隔离

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| **Cron 任务失败** | 降低用户信任分 | 仅影响 Cron 信任分 |
| **用户失败** | 阻止 Cron 任务 | Cron 任务不受影响 |
| **信任分数池** | 1 个（共享） | 4 个（独立） |
| **文件数量** | 1（AGENT_SCORECARD.json） | 4（+ _cron, _admin, _isolated） |

### 对比 #2: Cron 会话特权

| 配置项 | 用户会话 | Cron 会话 | 改进 |
|--------|----------|-----------|------|
| **初始信任分** | 85 | 90 | ↑ 6% |
| **Grace 次数** | 5 | 10 | ↑ 100% |
| **Stage 2 限制** | 50 行 | 100 行 | ↑ 100% |
| **Stage 3 限制** | 300 行 | 600 行 | ↑ 100% |
| **工具失败惩罚** | -2 | -1 | ↑ 50% |
| **风险失败惩罚** | -10 | -5 | ↑ 50% |

### 对比 #3: Admin 会话特权

| 配置项 | 用户会话 | Admin 会话 |
|--------|----------|-----------|
| **初始信任分** | 85 | 100（无限制） |
| **Grace 次数** | 5 | 20 |
| **Stage 2 限制** | 50 行 | 无限制 |
| **Stage 3 限制** | 300 行 | 无限制 |
| **Gate 绕过** | 否 | 是（Stage 4 + bypass） |

---

## 🧪 测试策略

### 测试用例 #1: Cron 会话使用独立 Scorecard

```typescript
it('should use separate scorecard for Cron sessions', () => {
    const userScorecardPath = path.join(workspaceDir, '.state', 'AGENT_SCORECARD.json');
    const cronScorecardPath = path.join(workspaceDir, '.state', 'AGENT_SCORECARD_CRON.json');

    // User session
    const userEngine = new TrustEngine(workspaceDir, '');
    userEngine.recordFailure('tool', { toolName: 'write' });
    const userScore = userEngine.getScore();

    // Cron session
    const cronEngine = new TrustEngine(workspaceDir, '_cron');
    const cronScore = cronEngine.getScore();

    // Scores should be independent
    expect(cronScore).not.toBe(userScore);
    expect(cronScore).toBe(90);  // Cron initial trust

    // Verify separate files exist
    expect(fs.existsSync(userScorecardPath)).toBe(true);
    expect(fs.existsSync(cronScorecardPath)).toBe(true);
});
```

### 测试用例 #2: Session Type 检测

```typescript
it('should detect session type from context', () => {
    const userCtx = { session: { type: 'user' } };
    expect(detectSessionType(userCtx)).toBe(SessionType.USER);

    const cronCtx = { session: { type: 'cron', channel: 'discord' } };
    expect(detectSessionType(cronCtx)).toBe(SessionType.CRON);

    const isolatedCtx = { session: { metadata: { isolated: true } } };
    expect(detectSessionType(isolatedCtx)).toBe(SessionType.ISOLATED);

    const adminCtx = { session: { metadata: { elevated: true } } };
    expect(detectSessionType(adminCtx)).toBe(SessionType.ADMIN);
});
```

### 测试用例 #3: Cron 会话特权

```typescript
it('should apply Cron-specific limits and penalties', () => {
    const cronEngine = new TrustEngine(workspaceDir, '_cron');
    const settings = cronEngine['getTrustSettings']('_cron');

    // Verify Cron-specific settings
    expect(settings.cold_start.initial_trust).toBe(90);
    expect(settings.cold_start.grace_failures).toBe(10);
    expect(settings.limits.stage_2_max_lines).toBe(100);
    expect(settings.limits.stage_3_max_lines).toBe(600);
    expect(settings.penalties.tool_failure_base).toBe(-1);
    expect(settings.penalties.risky_failure_base).toBe(-5);
});
```

### 测试用例 #4: Admin 会话绕过限制

```typescript
it('should bypass all limits for Admin sessions', () => {
    const adminCtx = {
        ...mockContext,
        session: {
            type: 'admin',
            metadata: { elevated: true }
        }
    };

    const wctx = WorkspaceContext.fromHookContext(adminCtx);

    expect(wctx.isElevatedSession()).toBe(true);
    expect(wctx.sessionType).toBe(SessionType.ADMIN);
});
```

---

## ✅ 验收标准

### Phase 1: Session 类型识别
- [ ] 创建 `session-types.ts` 文件
- [ ] 实现 `detectSessionType` 函数
- [ ] 实现 `getTrustPoolSuffix` 函数
- [ ] 测试验证所有 Session Type 检测正确

### Phase 2: 独立 Scorecard 池
- [ ] 修改 `TrustEngine` 构造函数支持 `poolSuffix`
- [ ] 实现 `getScorecardPath` 方法
- [ ] 实现 `getTrustSettings` 方法（会话特定配置）
- [ ] 测试验证独立 scorecard 文件创建

### Phase 3: 会话隔离配置
- [ ] 添加 `TrustSettings.sessions` 接口
- [ ] 添加 `SessionTrustConfig` 接口
- [ ] 更新 `DEFAULT_SETTINGS` 包含会话配置
- [ ] 测试验证配置加载正确

### Phase 4: Gate 集成
- [ ] 修改 `gate.ts` 检测会话类型
- [ ] 实现 Admin 绕过逻辑
- [ ] 实现 Cron/Isolated 特权逻辑
- [ ] 测试验证限制应用正确

---

## 🚨 回滚方案

如果修复导致问题，可以按以下步骤回滚：

1. **禁用会话隔离**:
   在 `config.ts` 中设置：
   ```typescript
   sessions: {
       user: { enabled: false },
       cron: { enabled: false },
       admin: { enabled: false },
       isolated: { enabled: false }
   }
   ```

2. **删除 Session Type 检测**:
   在 `gate.ts` 中注释掉 `detectSessionType` 调用

3. **恢复单一 Scorecard**:
   在 `TrustEngine` 构造函数中强制 `poolSuffix = ''`

---

**状态**: 🟡 待实施
**预计工作量**: 4-5 小时
**风险等级**: 🟢 低风险（仅影响 Cron/Admin 会话，用户会话不变）
**OKR 关联**: KR2 - 修复 Cron 会话信任隔离
