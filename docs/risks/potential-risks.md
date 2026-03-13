# 潜在系统风险分析

> **创建日期**: 2026-03-12
> **创建者**: Explorer Agent
> **版本**: v1.0
> **基于**: evolution-worker-analysis.md + 深度代码审查

---

## 🚨 执行摘要

本报告识别了 Principles 项目中的 **2 个高风险**和 **3 个中风险**系统漏洞，主要集中在：
- **TrustEngine 文件损坏恢复机制**（高风险）
- **Gate 并发写入竞态条件**（高风险）
- **EvolutionWorker 事务性缺失**（已在 evolution-worker-analysis.md 识别）

这些风险可能导致：
- 数据永久丢失
- 系统状态不一致
- 死锁或无限循环
- 权限提升漏洞

---

## 🔴 风险 1: TrustEngine 文件损坏恢复机制缺陷

### 问题描述

TrustEngine 在加载 `AGENT_SCORECARD.json` 时，如果文件损坏（非有效 JSON），会**静默重置为初始值**，导致所有历史信任数据丢失。

### 代码位置

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts`

**问题代码** (Line 66-72):
```typescript
private loadScorecard(): TrustScorecard {
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    const settings = this.trustSettings;

    if (fs.existsSync(scorecardPath)) {
        try {
            const raw = fs.readFileSync(scorecardPath, 'utf8');
            const data = JSON.parse(raw);
            // ... 字段迁移逻辑
            return data;
        } catch (e) {
            console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard at ${scorecardPath}. Resetting.`);
            // ⚠️ 问题：仅记录错误，继续执行，返回默认值
        }
    }

    // 返回全新的默认值
    return {
        trust_score: settings.cold_start.initial_trust,
        success_streak: 0,
        failure_streak: 0,
        exploratory_failure_streak: 0,
        // ...
    };
}
```

### 风险场景

#### 场景 1: 磁盘写入不完整

```
时间线:
T0: TrustEngine 保存 scorecard（trust_score: 75）
T1: 写入文件前，进程被 kill（磁盘满、OOM、系统崩溃）
T2: AGENT_SCORECARD.json 损坏（不完整的 JSON）
T3: TrustEngine 重启，读取损坏文件
T4: JSON.parse() 抛出异常
T5: catch 块捕获异常，仅记录错误
T6: 返回默认值（trust_score: 85）
T7: 用户丢失所有信任数据，包括：
      - 历史成功/失败记录
      - 当前分数（75 → 85，意外提升）
      - 冷启动状态
      - 连胜/连败记录
```

#### 场景 2: JSON 格式损坏

```
假设 AGENT_SCORECARD.json 内容：
{
  "trust_score": 75,
  "success_streak": 5,
  "failure_streak": 0,
  "exploratory_failure_streak": 0,
  "last_updated": "2026-03-12T17:00:00Z",
  "first_activity_at": "2026-03-10T10:00:00Z",
  "history": [
    { "type": "success", "delta": 2, "reason": "tool_success", "timestamp": "..." },
    // ... 50 条历史记录
  ]
}

损坏后（缺少闭合括号）：
{
  "trust_score": 75,
  "success_streak": 5,
  // ... 缺少闭合括号

结果：所有数据丢失，返回默认值
```

### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **数据丢失** | 🔴 严重 | 所有信任历史永久丢失 |
| **信任分数错误** | 🔴 严重 | 可能意外提升（从低分变回初始 85） |
| **冷启动失效** | 🟡 中等 | `cold_start_end` 被重置，可能重复冷启动保护 |
| **连胜/连败重置** | 🟡 中等 | 所有统计清零 |
| **审计能力丧失** | 🟡 中等 | `history` 数组清空，无法追踪行为 |

### 根因分析

1. **无备份机制**：损坏文件直接丢弃，无备份恢复
2. **无恢复日志**：仅记录到 `console.error`，不写入事件日志
3. **无损坏文件保留**：损坏文件被覆盖或删除，无法事后分析
4. **静默降级**：用户不知道数据已丢失，系统继续"正常"运行

### 修复建议

#### 方案 1: 备份恢复机制（推荐）

```typescript
private loadScorecard(): TrustScorecard {
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    const backupPath = `${scorecardPath}.bak`;
    const corruptedPath = `${scorecardPath}.corrupted.${Date.now()}`;

    const settings = this.trustSettings;

    if (fs.existsSync(scorecardPath)) {
        try {
            const raw = fs.readFileSync(scorecardPath, 'utf8');
            const data = JSON.parse(raw);

            // 字段迁移逻辑
            if (data.score !== undefined && data.trust_score === undefined) data.trust_score = data.score;
            if (!data.history) data.history = [];
            if (data.exploratory_failure_streak === undefined) data.exploratory_failure_streak = 0;

            return data;
        } catch (e) {
            // 1. 记录事件到事件日志
            const eventLog = EventLogService.get(this.stateDir);
            eventLog.recordHookExecution({
                hookName: 'trust-engine-load',
                error: String(e),
                errorStack: e instanceof Error ? e.stack : undefined
            });

            // 2. 保留损坏文件
            console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard. Preserving as ${corruptedPath}`);
            fs.copyFileSync(scorecardPath, corruptedPath);

            // 3. 尝试从备份恢复
            if (fs.existsSync(backupPath)) {
                try {
                    console.warn(`[PD:TrustEngine] Attempting to recover from backup: ${backupPath}`);
                    const backupRaw = fs.readFileSync(backupPath, 'utf8');
                    const backupData = JSON.parse(backupRaw);

                    // 恢复主文件
                    fs.writeFileSync(scorecardPath, JSON.stringify(backupData, null, 2), 'utf8');
                    console.info(`[PD:TrustEngine] Successfully recovered from backup`);

                    return backupData;
                } catch (backupErr) {
                    console.error(`[PD:TrustEngine] Backup also corrupted: ${String(backupErr)}`);
                    // 备份也损坏，保留供人工分析
                    fs.copyFileSync(backupPath, `${backupPath}.corrupted.${Date.now()}`);
                }
            }
        }
    }

    // 返回默认值（如果所有恢复尝试失败）
    console.warn(`[PD:TrustEngine] No valid scorecard found. Using default initial state.`);

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
```

#### 方案 2: 原子写入机制

```typescript
private saveScorecard(): void {
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    const tempPath = `${scorecardPath}.tmp`;
    const backupPath = `${scorecardPath}.bak`;

    try {
        const dir = path.dirname(scorecardPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // 1. 创建临时文件
        fs.writeFileSync(tempPath, JSON.stringify(this.scorecard, null, 2), 'utf8');

        // 2. 备份现有文件
        if (fs.existsSync(scorecardPath)) {
            fs.copyFileSync(scorecardPath, backupPath);
        }

        // 3. 原子性重命名
        fs.renameSync(tempPath, scorecardPath);

        // 4. 删除旧备份（延迟删除以增强恢复能力）
        setTimeout(() => {
            if (fs.existsSync(`${backupPath}.old`)) {
                fs.unlinkSync(`${backupPath}.old`);
            }
            fs.renameSync(backupPath, `${backupPath}.old`);
        }, 60000); // 1 分钟后轮转备份

    } catch (e) {
        // 记录到事件日志
        const eventLog = EventLogService.get(this.stateDir);
        eventLog.recordHookExecution({
            hookName: 'trust-engine-save',
            error: String(e),
            errorStack: e instanceof Error ? e.stack : undefined
        });

        console.error(`[PD:TrustEngine] Failed to save scorecard: ${String(e)}`);
        throw e; // 重新抛出，让调用者知道写入失败
    }
}
```

### 验证方法

```typescript
// 测试用例 1: 文件损坏恢复
it('should recover from corrupted scorecard', () => {
    // 1. 创建有效的 scorecard
    const engine = new TrustEngine('/mock/workspace');
    engine.recordSuccess('test');
    const originalScore = engine.getScore();

    // 2. 模拟文件损坏
    const scorecardPath = resolvePdPath('/mock/workspace', 'AGENT_SCORECARD');
    fs.writeFileSync(scorecardPath, '{ invalid json }');

    // 3. 重新加载
    const engine2 = new TrustEngine('/mock/workspace');
    const recoveredScore = engine2.getScore();

    // 4. 验证：应该从备份恢复，而不是默认值
    expect(recoveredScore).toBeGreaterThan(0); // 不是默认值 85
    expect(recoveredScore).toBe(originalScore);
});

// 测试用例 2: 备份文件也损坏
it('should handle both main and backup corrupted', () => {
    // 1. 损坏主文件和备份
    const scorecardPath = resolvePdPath('/mock/workspace', 'AGENT_SCORECARD');
    const backupPath = `${scorecardPath}.bak`;

    fs.writeFileSync(scorecardPath, '{ corrupted }');
    fs.writeFileSync(backupPath, '{ also corrupted }');

    // 2. 重新加载
    const engine = new TrustEngine('/mock/workspace');

    // 3. 验证：应该返回默认值
    expect(engine.getScore()).toBe(85); // 默认初始值

    // 4. 验证：损坏文件被保留
    expect(fs.existsSync(`${scorecardPath}.corrupted`)).toBe(true);
});
```

---

## 🔴 风险 2: Gate 并发写入竞态条件

### 问题描述

如果多个工具调用同时被 gate.ts 阻止，`block()` 函数可能被**并发调用**，导致：
- `trackBlock()` 可能被多次调用，记录错误的阻止次数
- `eventLog.recordGateBlock()` 可能失败但不影响主流程
- 阻止消息可能被重复发送

### 代码位置

**文件**: `packages/openclaw-plugin/src/hooks/gate.ts`

**问题代码** (Line 180-190):
```typescript
function block(filePath: string, reason: string, wctx: WorkspaceContext, toolName: string): PluginHookBeforeToolCallResult {
    const logger = console;
    logger.error(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);

    trackBlock(wctx.workspaceDir);  // ⚠️ 问题 1: 可能并发调用

    return {
        block: true,
        blockReason: `[Principles Disciple] Security Gate Blocked this action.\nFile: ${filePath}\nReason: ${reason}\n\nHint: You may need a READY plan or a higher trust score to perform this action.`,
    };
}
```

### 风险场景

#### 场景 1: 并发阻止

```
时间线:
T0: Agent 同时发起 3 个工具调用
    - write /tmp/file1.txt
    - write /tmp/file2.txt
    - edit /tmp/file3.txt

T1: gate.ts 处理第一个请求
    - 检测到超过行数限制
    - 调用 block('/tmp/file1.txt', ...)

T2: gate.ts 处理第二个请求（并发）
    - 检测到超过行数限制
    - 调用 block('/tmp/file2.txt', ...)
    - ⚠️ trackBlock() 被并发调用

T3: trackBlock() 内部逻辑（session-tracker.ts）
    - 读取 .state/session-blocks.json
    - 解析 JSON
    - 更新计数器
    - 写入文件
    - ⚠️ 如果 T2 的写入在 T1 之后，数据被覆盖

T4: 结果：阻止计数不准确，可能丢失或重复
```

#### 场景 2: 事件日志失败

```
时间线:
T0: block() 被调用
T1: logger.error() 输出到控制台
T2: trackBlock() 更新阻止计数
T3: 返回阻止结果
T4: [隐式] eventLog.recordGateBlock() 应该被调用
    - 但 block() 函数没有调用它
    - ⚠️ 阻止事件未记录到日志

结果：审计能力不完整，无法追踪所有阻止事件
```

### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **统计数据不准确** | 🟡 中等 | 阻止次数可能重复计数或丢失 |
| **审计能力不完整** | 🟡 中等 | 阻止事件未全部记录到事件日志 |
| **用户体验** | 🟢 轻微 | 用户看到多个相同的阻止消息 |
| **系统状态** | 🟢 轻微 | 不影响核心功能 |

### 根因分析

1. **无并发控制**：`block()` 函数无锁机制
2. **trackBlock() 非线程安全**：session-tracker.ts 的文件操作不是原子的
3. **事件记录缺失**：`block()` 函数不调用 `eventLog.recordGateBlock()`

### 修复建议

#### 方案 1: 添加并发控制（推荐）

```typescript
// 在 gate.ts 顶部添加
import { Mutex } from 'async-mutex';

const blockMutex = new Mutex();

function block(filePath: string, reason: string, wctx: WorkspaceContext, toolName: string): PluginHookBeforeToolCallResult {
    const logger = console;
    logger.error(`[PD_GATE] BLOCKED: ${filePath}. Reason: ${reason}`);

    // 记录阻止事件
    if (wctx.eventLog) {
        try {
            wctx.eventLog.recordGateBlock(undefined, {
                toolName,
                filePath,
                reason,
                stage: wctx.trust?.getStage(),
                trustScore: wctx.trust?.getScore()
            });
        } catch (logErr) {
            logger.error(`[PD_GATE] Failed to record block event: ${String(logErr)}`);
        }
    }

    // 使用互斥锁保护 trackBlock
    blockMutex.runExclusive(() => {
        trackBlock(wctx.workspaceDir);
    }).catch((err) => {
        logger.error(`[PD_GATE] Failed to track block: ${String(err)}`);
    });

    return {
        block: true,
        blockReason: `[Principles Disciple] Security Gate Blocked this action.\nFile: ${filePath}\nReason: ${reason}\n\nHint: You may need a READY plan or a higher trust score to perform this action.`,
    };
}
```

#### 方案 2: 原子性 trackBlock

```typescript
// 在 session-tracker.ts 中修改
export function trackBlock(workspaceDir: string): void {
    const stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    const blocksPath = path.join(stateDir, 'session-blocks.json');

    // 临时文件 + 原子重命名
    const tempPath = `${blocksPath}.tmp`;

    try {
        let data: { blocks: number; last_block_time: string };

        if (fs.existsSync(blocksPath)) {
            data = JSON.parse(fs.readFileSync(blocksPath, 'utf8'));
        } else {
            data = { blocks: 0, last_block_time: new Date().toISOString() };
        }

        data.blocks++;
        data.last_block_time = new Date().toISOString();

        // 原子写入
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tempPath, blocksPath);

    } catch (e) {
        console.error(`[PD:SessionTracker] Failed to track block: ${String(e)}`);
    }
}
```

### 验证方法

```typescript
// 测试用例: 并发阻止
it('should handle concurrent blocks correctly', async () => {
    const mockWctx = {
        workspaceDir: '/mock/workspace',
        eventLog: mockEventLog,
        trust: { getStage: () => 2, getScore: () => 40 }
    };

    // 模拟 10 个并发阻止
    const promises = Array.from({ length: 10 }, (_, i) =>
        block(`/tmp/file${i}.txt`, 'Test reason', mockWctx, 'write')
    );

    const results = await Promise.all(promises);

    // 验证：所有阻止都返回正确结果
    results.forEach((result, i) => {
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain(`/tmp/file${i}.txt`);
    });

    // 验证：阻止计数准确（应该是 10）
    const blocksData = JSON.parse(fs.readFileSync('/mock/.state/session-blocks.json', 'utf8'));
    expect(blocksData.blocks).toBe(10);

    // 验证：事件日志记录了所有阻止
    expect(mockEventLog.recordGateBlock).toHaveBeenCalledTimes(10);
});
```

---

## 🟠 风险 3: TrustEngine updateScore 历史数组溢出

### 问题描述

`updateScore()` 函数虽然限制了 `history` 数组长度（最多 50 条），但如果 `history_limit` 配置被手动修改或未设置，数组可能无限增长，导致内存问题。

### 代码位置

**文件**: `packages/openclaw-plugin/src/core/trust-engine.ts`

**问题代码** (Line 250-256):
```typescript
this.scorecard.history.push({ type, delta, reason, timestamp: new Date().toISOString() });

const limit = this.trustSettings.history_limit || 50;  // ⚠️ 如果配置未设置，默认 50
if (this.scorecard.history.length > limit) {
    this.scorecard.history.shift();  // ⚠️ 如果 limit 被设置为 Infinity，永远不执行
}
```

### 风险场景

#### 场景 1: 配置错误

```
settings.json:
{
  "trust": {
    "history_limit": 999999  // 配置错误或恶意修改
  }
}

结果：history 数组无限增长，内存耗尽
```

#### 场景 2: 长时间运行

```
假设：
- history_limit: 50
- 每次工具调用都记录到 history
- 每天有 100 次工具调用

结果：
- 每天有 50 条记录被保留
- 30 天后，仍然只有 50 条（正确）
- 但如果 history_limit 被意外删除，数组会无限增长
```

### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **内存泄漏** | 🟡 中等 | 长期运行可能导致内存耗尽 |
| **文件大小增长** | 🟡 中等 | AGENT_SCORECARD.json 可能变得巨大 |
| **加载性能下降** | 🟢 轻微 | JSON 解析和写入变慢 |

### 修复建议

```typescript
private updateScore(delta: number, reason: string, type: 'success' | 'failure' | 'penalty' | 'info', context?: { sessionId?: string; api?: any }): void {
    // ... 更新分数逻辑 ...

    this.scorecard.history.push({ type, delta, reason, timestamp: new Date().toISOString() });

    // 安全限制：最大 500 条，防止配置错误
    const limit = Math.min(this.trustSettings.history_limit || 50, 500);
    if (this.scorecard.history.length > limit) {
        this.scorecard.history.shift();
    }

    // 如果历史数组过大（例如 > 1000），主动截断
    if (this.scorecard.history.length > 1000) {
        console.warn(`[PD:TrustEngine] History array too large (${this.scorecard.history.length}). Truncating to 500.`);
        this.scorecard.history = this.scorecard.history.slice(-500);
    }

    this.saveScorecard();
}
```

---

## 🟠 风险 4: EvolutionWorker 队列状态不一致（已在 evolution-worker-analysis.md 识别）

### 问题描述

EvolutionWorker 在写入 `EVOLUTION_QUEUE.json` 和 `EVOLUTION_DIRECTIVE.json` 时，**非原子操作**，可能导致：
- Directive 指向一个状态仍为 pending 的任务
- 下次重启可能重复处理同一个任务

### 参考

详见：`docs/evidence/evolution-worker-analysis.md`
- 高危漏洞 #2: 队列状态不一致风险
- 高危漏洞 #4: 规则晋升状态不一致

---

## 🟠 风险 5: ConfigService 单例模式线程安全

### 问题描述

`ConfigService` 使用单例模式，但如果多个线程/进程同时调用 `ConfigService.get()`，可能导致配置被多次加载，或者状态不一致。

### 代码位置

**文件**: `packages/openclaw-plugin/src/core/config-service.ts`

```typescript
let config: PainConfig | null = null;
let lastStateDir: string | null = null;

export const ConfigService = {
    get(stateDir: string): PainConfig {
        if (!config || lastStateDir !== stateDir) {  // ⚠️ 非原子检查
            config = new PainConfig(stateDir);
            config.load();
            lastStateDir = stateDir;
        }
        return config;
    },
    reset(): void {
        config = null;
    }
};
```

### 风险场景

```
时间线:
T0: 线程 A 调用 ConfigService.get('/workspace')
T1: 线程 A 检查 config === null（true）
T2: 线程 B 调用 ConfigService.get('/workspace')
T3: 线程 B 检查 config === null（仍然 true，因为 A 还没创建）
T4: 线程 A 创建 config 实例 A
T5: 线程 B 创建 config 实例 B
T6: 线程 A 设置 lastStateDir = '/workspace'
T7: 线程 B 设置 lastStateDir = '/workspace'
T8: 线程 A 返回 config 实例 A
T9: 线程 B 返回 config 实例 B

结果：两个线程获得不同的 config 实例，状态不一致
```

### 影响

| 影响维度 | 严重程度 | 说明 |
|---------|---------|------|
| **配置不一致** | 🟡 中等 | 不同线程可能获得不同配置 |
| **状态污染** | 🟢 轻微 | 如果工作区切换，配置可能混乱 |

### 修复建议

```typescript
import { Mutex } from 'async-mutex';

const configMutex = new Mutex();

export const ConfigService = {
    get(stateDir: string): PainConfig {
        return configMutex.runExclusive(() => {
            if (!config || lastStateDir !== stateDir) {
                config = new PainConfig(stateDir);
                config.load();
                lastStateDir = stateDir;
            }
            return config;
        });
    },
    reset(): void {
        configMutex.runExclusive(() => {
            config = null;
        });
    }
};
```

---

## 📊 风险优先级与修复时间线

| 风险编号 | 风险名称 | 严重程度 | 修复优先级 | 预计工作量 |
|---------|---------|---------|-----------|-----------|
| **#1** | TrustEngine 文件损坏恢复 | 🔴 高 | P0 | 2-3 小时 |
| **#2** | Gate 并发写入竞态 | 🔴 高 | P0 | 1-2 小时 |
| **#3** | updateScore 历史溢出 | 🟠 中 | P1 | 30 分钟 |
| **#4** | EvolutionWorker 队列不一致 | 🔴 高 | P0 | 2-3 小时（已在 evolution-worker-analysis.md） |
| **#5** | ConfigService 线程安全 | 🟠 中 | P1 | 30 分钟 |

### 修复里程碑

- [ ] **M1**: P0 风险全部修复（1 天内）
  - [ ] 风险 #1: TrustEngine 备份恢复机制
  - [ ] 风险 #2: Gate 并发控制
  - [ ] 风险 #4: EvolutionWorker 事务性写入（已在 evolution-worker-analysis.md）

- [ ] **M2**: P1 风险修复（2 天内）
  - [ ] 风险 #3: updateScore 安全限制
  - [ ] 风险 #5: ConfigService 线程安全

- [ ] **M3**: 测试验证（3 天内）
  - [ ] 所有修复的单元测试
  - [ ] 并发测试
  - [ ] 恢复机制测试

---

## 📝 总结

### 关键发现

1. **文件损坏恢复机制缺失**（风险 #1）：TrustEngine 文件损坏后直接重置，无备份恢复，导致数据永久丢失
2. **并发控制缺失**（风险 #2）：Gate 的 `block()` 函数无锁机制，可能导致统计数据不准确
3. **事务性写入缺失**（风险 #4）：EvolutionWorker 的多个文件写入非原子，可能导致状态不一致
4. **安全边界不足**（风险 #3）：配置错误可能导致内存泄漏
5. **单例模式不安全**（风险 #5）：ConfigService 在并发环境下可能返回不同实例

### 立即行动（P0）

- [ ] 实现 TrustEngine 备份恢复机制（风险 #1）
- [ ] 添加 Gate 并发控制（风险 #2）
- [ ] 实现 EvolutionWorker 事务性写入（风险 #4，已在 evolution-worker-analysis.md）

### 短期行动（P1）

- [ ] 添加 updateScore 安全限制（风险 #3）
- [ ] 实现 ConfigService 线程安全（风险 #5）

---

**文档版本**: v1.0
**创建时间**: 2026-03-12 18:00 UTC
**下一步**: KR4 - 模板一致性扫描
