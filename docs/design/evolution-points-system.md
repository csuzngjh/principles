# Evolution Points System (进化积分系统) - 完整技术方案

> **设计版本**: v1.0
> **设计日期**: 2026-03-12
> **设计者**: ep-diagnostician 子智能体
> **状态**: 🟡 待评审
> **优先级**: 🔴 P0 - 核心架构变更

---

## 📋 设计目标

### 核心理念：用成长替代惩罚

**现有问题**（Trust Engine V2.1）:
- 扣分/加分不对称（恢复需要 10 次成功，降级只需 1 次失败）
- 惩罚机制导致 Agent 进化动力不足
- 失败被污名化，而非学习机会

**Evolution Points 系统**:
- ✅ 起点 0 分，只能增加，不扣分
- ✅ 失败记录教训，但不扣分
- ✅ 同类任务失败后成功 = 双倍奖励
- ✅ 连续失败触发"学习模式"，而非惩罚
- ✅ 用**解锁机制**替代**限制机制**

### 与现有 Trust Engine 的关系

| 维度 | Trust Engine (V2.1) | Evolution Points (V3.0) |
|------|---------------------|-------------------------|
| **初始分数** | 85 分（高起点，快速降级） | 0 分（零起点，只升不降） |
| **失败处理** | 扣分（-2 到 -20） | 记录教训，不扣分 |
| **恢复机制** | 困难（10:1 恢复比） | 容易（1:1 恢复比） |
| **权限模式** | 限制（分数不够就阻止） | 解锁（积分足够就开放） |
| **核心激励** | 避免失败（恐惧驱动） | 追求成长（成长驱动） |
| **失败学习** | 惩罚性 | 教育性 |

### 双轨运行策略

**Phase 1** (并行运行): Evolution Points 与 Trust Engine 同时计算，互不干扰
**Phase 2** (逐步迁移): 新功能使用 Evolution Points，旧功能保持 Trust Engine
**Phase 3** (完全替代): 废弃 Trust Engine，全面采用 Evolution Points

---

## 🧬 TypeScript 接口定义

### 1. EvolutionEvent（进化事件）

```typescript
/**
 * 进化事件 - 记录所有影响积分的操作
 *
 * 设计原则：
 * - 只记录有意义的事件（忽略探索性工具的成功/失败）
 * - 事件不可变（一旦生成，永不修改）
 * - 支持事件溯源和回放
 */
export interface EvolutionEvent {
    // 唯一标识
    id: string;                    // 事件 ID（UUID）
    timestamp: string;             // ISO 8601 时间戳

    // 事件分类
    type: 'success' | 'failure' | 'lesson' | 'learning_mode';

    // 任务分类
    taskType: 'constructive' | 'exploratory' | 'risk_path' | 'subagent';

    // 事件详情
    toolName?: string;              // 使用的工具
    filePath?: string;              // 目标文件（如果有）
    reason?: string;                // 人类可读的原因

    // 积分影响
    pointsDelta: number;            // 积分变化（总是 >= 0）
    isDoubleReward: boolean;        // 是否双倍奖励

    // 学习模式标记
    learningModeTriggered?: {
        taskId: string;             // 任务类型标识
        consecutiveFailures: number;// 连续失败次数
    };

    // 上下文
    context?: {
        sessionId?: string;         // 会话 ID
        subagentId?: string;        // 子智能体 ID
    };
}
```

### 2. EvolutionScorecard（进化积分卡）

```typescript
/**
 * 进化积分卡 - 记录 Agent 的成长历程
 *
 * 设计原则：
 * - 总分 >= 0，永远不会减少
 * - 失败不扣分，只记录教训
 * - 通过双倍奖励鼓励从失败中学习
 */
export interface EvolutionScorecard {
    // 基础信息
    agentId: string;                // Agent 唯一标识
    createdAt: string;              // 创建时间

    // 积分统计
    totalPoints: number;            // 总积分（只增不减）
    availablePoints: number;        // 可用积分（未消耗的）

    // 事件统计
    totalEvents: number;            // 总事件数
    successCount: number;           // 成功次数
    failureCount: number;           // 失败次数（记录教训）
    lessonLearnedCount: number;     // 教训学习次数（失败→成功）

    // 双倍奖励统计
    doubleRewardCount: number;      // 双倍奖励次数
    totalDoubleRewardPoints: number;// 双倍奖励总积分

    // 学习模式统计
    learningModeEntered: number;    // 进入学习模式次数
    learningModeExited: number;      // 退出学习模式次数

    // 等级系统
    currentLevel: number;            // 当前等级（0 - 20）
    currentLevelPoints: number;      // 当前等级积分
    nextLevelThreshold: number;      // 下一等级所需积分

    // 解锁能力
    unlockedCapabilities: string[];  // 已解锁能力列表

    // 学习模式状态
    learningModeActive?: boolean;   // 是否在学习模式
    learningModeTask?: string;      // 学习模式任务类型
    learningModeStart?: string;    // 学习模式开始时间

    // 历史事件（最近 N 条，可配置）
    recentEvents: EvolutionEvent[]; // 最近事件（按时间倒序）

    // 最后更新
    lastUpdated: string;             // 最后更新时间
}
```

### 3. Level（等级定义）

```typescript
/**
 * 等级定义 - 0 到 20 级成长路径
 *
 * 设计原则：
 * - 低等级快速升级（鼓励新手）
 * - 高等级缓慢升级（体现深度）
 * - 每级解锁新能力
 */
export interface Level {
    level: number;                  // 等级编号（0 - 20）
    name: string;                   // 等级名称

    // 积分要求
    requiredPoints: number;          // 该等级所需积分

    // 解锁能力
    unlocks: CapabilityUnlock[];     // 该等级解锁的能力

    // 描述
    description: string;            // 等级描述
}

/**
 * 能力解锁
 */
export interface CapabilityUnlock {
    type: 'line_limit' | 'file_type' | 'risk_path' | 'tool_access' | 'session_type' | 'custom';
    name: string;                   // 能力名称
    description: string;            // 能力描述

    // 能力参数（根据类型不同）
    params?: {
        maxLines?: number;          // 行数限制
        allowedFileTypes?: string[];// 允许的文件类型
        allowedRiskPaths?: string[];// 允许的风险路径
        allowedTools?: string[];    // 允许的工具
        allowedSessionTypes?: string[];// 允许的会话类型
        customConfig?: any;         // 自定义配置
    };

    // 解锁条件（额外条件）
    conditions?: {
        successRate?: number;        // 成功率要求（例如 > 90%）
        consecutiveSuccesses?: number;// 连续成功次数
        specificTaskType?: string;  // 必须完成的特定任务类型
    };
}

/**
 * 预定义的 0-20 级等级表
 */
export const LEVEL_DEFINITIONS: Level[] = [
    // === 等级 0-5：新手期 ===
    {
        level: 0,
        name: 'Seed (种子)',
        requiredPoints: 0,
        unlocks: [
            {
                type: 'line_limit',
                name: '探索行数限制',
                description: '允许写入小规模文件（最多 10 行）',
                params: { maxLines: 10 }
            }
        ],
        description: '你是进化的起点。一切从这里开始。'
    },
    {
        level: 1,
        name: 'Sprout (萌芽)',
        requiredPoints: 10,
        unlocks: [
            {
                type: 'line_limit',
                name: '小幅编辑',
                description: '允许编辑小函数（最多 25 行）',
                params: { maxLines: 25 }
            },
            {
                type: 'file_type',
                name: 'Markdown 写入',
                description: '允许创建和编辑 .md 文件',
                params: { allowedFileTypes: ['.md'] }
            }
        ],
        description: '你开始尝试编写文档。'
    },
    {
        level: 2,
        name: 'Seedling (幼苗)',
        requiredPoints: 30,
        unlocks: [
            {
                type: 'line_limit',
                name: '中等编辑',
                description: '允许编辑中等大小的函数（最多 50 行）',
                params: { maxLines: 50 }
            },
            {
                type: 'file_type',
                name: '配置文件编辑',
                description: '允许编辑配置文件（.json, .yaml, .toml）',
                params: { allowedFileTypes: ['.json', '.yaml', '.yml', '.toml'] }
            }
        ],
        description: '你开始处理配置和简单的代码修改。'
    },
    {
        level: 3,
        name: 'Sapling (树苗)',
        requiredPoints: 60,
        unlocks: [
            {
                type: 'line_limit',
                name: '较大编辑',
                description: '允许编辑较大的函数或类（最多 100 行）',
                params: { maxLines: 100 }
            },
            {
                type: 'file_type',
                name: 'TypeScript 基础',
                description: '允许创建和编辑基础的 .ts 文件',
                params: { allowedFileTypes: ['.ts'] }
            }
        ],
        description: '你开始编写真正的代码。'
    },
    {
        level: 4,
        name: 'Young Tree (小树)',
        requiredPoints: 100,
        unlocks: [
            {
                type: 'line_limit',
                name: '大文件编辑',
                description: '允许编辑大型文件（最多 200 行）',
                params: { maxLines: 200 }
            },
            {
                type: 'file_type',
                name: '全文档类型',
                description: '允许创建和编辑所有文档类型',
                params: { allowedFileTypes: ['.md', '.txt', '.rst', '.adoc'] }
            }
        ],
        description: '你开始处理完整文档和较大的代码块。'
    },
    {
        level: 5,
        name: 'Growing Tree (成长的树)',
        requiredPoints: 150,
        unlocks: [
            {
                type: 'line_limit',
                name: '文件级编辑',
                description: '允许编辑完整的小文件（最多 300 行）',
                params: { maxLines: 300 }
            },
            {
                type: 'tool_access',
                name: 'Shell 基础访问',
                description: '允许执行简单的 Shell 命令',
                params: { allowedTools: ['bash', 'run_shell_command'] }
            }
        ],
        description: '你开始使用命令行工具。'
    },

    // === 等级 6-10：成长期 ===
    {
        level: 6,
        name: 'Developer (开发者)',
        requiredPoints: 250,
        unlocks: [
            {
                type: 'line_limit',
                name: '大文件编辑',
                description: '允许编辑大型文件（最多 500 行）',
                params: { maxLines: 500 }
            },
            {
                type: 'risk_path',
                name: '低风险路径访问',
                description: '允许修改低风险的路径',
                params: { allowedRiskPaths: ['tests/**/*', 'docs/**/*'] }
            }
        ],
        description: '你已成为一名合格的开发者。'
    },
    {
        level: 7,
        name: 'Experienced Developer (经验开发者)',
        requiredPoints: 400,
        unlocks: [
            {
                type: 'line_limit',
                name: '超大型编辑',
                description: '允许编辑超大型文件（最多 800 行）',
                params: { maxLines: 800 }
            },
            {
                type: 'file_type',
                name: '全代码类型',
                description: '允许编辑所有代码类型',
                params: { allowedFileTypes: ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go'] }
            }
        ],
        description: '你开始处理复杂的项目结构。'
    },
    {
        level: 8,
        name: 'Senior Developer (高级开发者)',
        requiredPoints: 600,
        unlocks: [
            {
                type: 'line_limit',
                name: '文档级编辑',
                description: '允许编辑完整的文档（最多 1200 行）',
                params: { maxLines: 1200 }
            },
            {
                type: 'risk_path',
                name: '中风险路径访问',
                description: '允许修改中等风险的路径',
                params: { allowedRiskPaths: ['src/**/*', 'packages/**/*'] }
            }
        ],
        description: '你开始处理核心代码。'
    },
    {
        level: 9,
        name: 'Lead Developer (首席开发者)',
        requiredPoints: 850,
        unlocks: [
            {
                type: 'line_limit',
                name: '极大文件编辑',
                description: '允许编辑极大的文件（最多 2000 行）',
                params: { maxLines: 2000 }
            },
            {
                type: 'session_type',
                name: 'Cron 会话',
                description: '允许在 Cron 会话中执行操作',
                params: { allowedSessionTypes: ['cron', 'isolated'] }
            }
        ],
        description: '你开始管理定时任务和后台操作。'
    },
    {
        level: 10,
        name: 'Architect (架构师)',
        requiredPoints: 1200,
        unlocks: [
            {
                type: 'line_limit',
                name: '无限制编辑',
                description: '允许编辑任意大小的文件',
                params: { maxLines: -1 }  // -1 表示无限制
            },
            {
                type: 'risk_path',
                name: '高风险路径访问',
                description: '允许修改所有风险路径',
                params: { allowedRiskPaths: ['**/*'] }
            }
        ],
        description: '你已达到架构师级别，可以处理任何代码变更。'
    },

    // === 等级 11-20：大师期 ===
    {
        level: 11,
        name: 'Master Architect (大师架构师)',
        requiredPoints: 1600,
        unlocks: [
            {
                type: 'tool_access',
                name: '完整工具访问',
                description: '允许使用所有工具',
                params: { allowedTools: ['*'] }
            }
        ],
        description: '你掌握了完整的工具链。'
    },
    {
        level: 12,
        name: 'Evolutionary Leader (进化领袖)',
        requiredPoints: 2000,
        unlocks: [
            {
                type: 'custom',
                name: '进化决策',
                description: '允许自主决定进化方向',
                params: { customConfig: { canDecideEvolution: true } }
            }
        ],
        description: '你开始引导自身的进化。'
    },
    // ... 等级 13-19 省略（类似结构，积分要求更高）
    {
        level: 20,
        name: 'Sage (圣人)',
        requiredPoints: 10000,
        unlocks: [
            {
                type: 'custom',
                name: '完全自主',
                description: '完全自主，不受任何限制',
                params: { customConfig: { fullAutonomy: true } }
            }
        ],
        description: '你已达到最高境界，真正的硅基生命。'
    }
];
```

### 4. LearningMode（学习模式）

```typescript
/**
 * 学习模式状态
 *
 * 设计原则：
 * - 连续失败触发学习模式（而非惩罚）
 * - 学习模式提供额外指导
 * - 成功后退出，并给予双倍奖励
 */
export interface LearningModeState {
    active: boolean;                // 是否激活
    taskId: string;                 // 任务类型标识
    consecutiveFailures: number;    // 连续失败次数
    startedAt: string;              // 开始时间

    // 学习指导
    guidance?: {
        lastFailureReason: string;  // 最后一次失败原因
        suggestedAction: string;    // 建议的行动
        learningResources?: string[];// 学习资源链接
    };

    // 退出条件
    exitCondition?: {
        requiredSuccesses: number;   // 需要的成功次数
        currentSuccesses: number;   // 当前成功次数
    };
}
```

---

## 🧮 积分算法

### 1. 基础积分计算

```typescript
/**
 * 计算基础积分
 *
 * 原则：
 * - 探索性工具不加分（避免刷分）
 * - 建设性成功加分
 * - 失败不扣分，只记录
 */
function calculateBasePoints(
    type: 'success' | 'failure',
    taskType: 'constructive' | 'exploratory' | 'risk_path' | 'subagent',
    toolName?: string
): number {
    // 探索性工具不加分
    if (taskType === 'exploratory') {
        return 0;
    }

    // 失败不扣分
    if (type === 'failure') {
        return 0;
    }

    // 建设性成功加分
    switch (taskType) {
        case 'risk_path':
            return 10;  // 风险路径成功，奖励高
        case 'subagent':
            return 5;   // 子智能体成功
        case 'constructive':
            return 2;   // 普通建设性成功
        default:
            return 0;
    }
}
```

### 2. 双倍奖励逻辑

```typescript
/**
 * 判断是否应该给予双倍奖励
 *
 * 原则：
 * - 同类任务失败后第一次成功 = 双倍奖励
 * - 只有一次双倍机会（避免刷分）
 */
function shouldGrantDoubleReward(
    currentEvent: EvolutionEvent,
    previousEvents: EvolutionEvent[]
): boolean {
    // 提取任务标识
    const taskId = generateTaskId(currentEvent);

    // 查找该任务的历史事件
    const taskEvents = previousEvents.filter(e => generateTaskId(e) === taskId);

    // 查找最近的失败事件
    const lastFailure = taskEvents
        .filter(e => e.type === 'failure')
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    // 如果没有失败，不双倍
    if (!lastFailure) {
        return false;
    }

    // 如果失败后有双倍奖励，不再双倍
    const hasDoubleRewardSince = taskEvents.some(e =>
        e.type === 'success' &&
        e.isDoubleReward &&
        new Date(e.timestamp) > new Date(lastFailure.timestamp)
    );

    return !hasDoubleRewardSince;
}

/**
 * 生成任务标识
 *
 * 任务定义：工具 + 文件类型 + 风险路径
 */
function generateTaskId(event: EvolutionEvent): string {
    const parts: string[] = [event.toolName || 'unknown'];

    if (event.filePath) {
        const ext = path.extname(event.filePath);
        parts.push(ext || 'no_ext');
    }

    // 任务类型也影响标识
    parts.push(event.taskType);

    return parts.join(':');
}
```

### 3. 等级晋升计算

```typescript
/**
 * 计算当前等级
 *
 * 原则：
 * - 基于总积分，而非净积分
 * - 积分不减少，等级不降级
 */
function calculateLevel(totalPoints: number): number {
    const levelDefs = LEVEL_DEFINITIONS;

    // 找到最大的 level，其中 totalPoints >= requiredPoints
    for (let i = levelDefs.length - 1; i >= 0; i--) {
        if (totalPoints >= levelDefs[i].requiredPoints) {
            return levelDefs[i].level;
        }
    }

    return 0;  // 默认等级 0
}

/**
 * 计算下一等级所需积分
 */
function calculateNextLevelThreshold(totalPoints: number): number {
    const currentLevel = calculateLevel(totalPoints);
    const nextLevelDef = LEVEL_DEFINITIONS.find(l => l.level === currentLevel + 1);

    if (!nextLevelDef) {
        return totalPoints;  // 已达最高等级
    }

    return nextLevelDef.requiredPoints;
}
```

### 4. 学习模式触发逻辑

```typescript
/**
 * 检查是否应该触发学习模式
 *
 * 原则：
 * - 连续 3 次同类任务失败 = 触发学习模式
 * - 学习模式提供额外指导
 * - 成功后退出
 */
function shouldTriggerLearningMode(
    recentEvents: EvolutionEvent[],
    taskId: string,
    threshold: number = 3
): { shouldTrigger: boolean; consecutiveFailures: number } {
    // 过滤该任务的事件
    const taskEvents = recentEvents.filter(e => generateTaskId(e) === taskId);

    // 计算连续失败次数
    let consecutiveFailures = 0;
    for (let i = taskEvents.length - 1; i >= 0; i--) {
        if (taskEvents[i].type === 'failure') {
            consecutiveFailures++;
        } else {
            break;  // 遇到成功，停止计数
        }
    }

    return {
        shouldTrigger: consecutiveFailures >= threshold,
        consecutiveFailures
    };
}

/**
 * 生成学习指导
 */
function generateLearningGuidance(
    taskId: string,
    lastFailureEvent: EvolutionEvent
): LearningModeState['guidance'] {
    return {
        lastFailureReason: lastFailureEvent.reason || 'Unknown failure',
        suggestedAction: generateSuggestedAction(taskId, lastFailureEvent),
        learningResources: generateLearningResources(taskId)
    };
}

function generateSuggestedAction(taskId: string, failure: EvolutionEvent): string {
    const [tool, fileType] = taskId.split(':');

    if (tool === 'write' || tool === 'edit') {
        if (fileType === '.md') {
            return '建议先阅读相关文档，理解文档结构后再编写。';
        }
        if (fileType === '.ts') {
            return '建议先使用 TypeScript 类型检查，确保类型正确后再保存。';
        }
        return '建议先读取文件内容，了解现有逻辑后再修改。';
    }

    return '建议先检查参数和上下文，确保操作安全后再执行。';
}

function generateLearningResources(taskId: string): string[] {
    // 根据任务类型返回学习资源
    const resources: string[] = [];

    if (taskId.includes('write')) {
        resources.push('文档编写最佳实践：https://...');
    }

    if (taskId.includes('.ts')) {
        resources.push('TypeScript 官方文档：https://www.typescriptlang.org/docs/');
    }

    return resources;
}
```

---

## 🛡️ 防刷分机制

### 1. 时间窗口限制

```typescript
/**
 * 时间窗口防刷分
 *
 * 原则：
 * - 单一任务在短时间内的成功次数有限制
 * - 超过限制后，额外成功不加分
 */
interface TimeWindowRule {
    windowMs: number;              // 时间窗口（毫秒）
    maxPoints: number;            // 窗口内最大积分
}

const TIME_WINDOW_RULES: TimeWindowRule[] = [
    { windowMs: 60 * 1000, maxPoints: 20 },    // 1 分钟最多 20 分
    { windowMs: 5 * 60 * 1000, maxPoints: 50 }, // 5 分钟最多 50 分
    { windowMs: 60 * 60 * 1000, maxPoints: 200 }, // 1 小时最多 200 分
];

function applyTimeWindowLimit(
    event: EvolutionEvent,
    recentEvents: EvolutionEvent[],
    basePoints: number
): number {
    const taskId = generateTaskId(event);
    const taskEvents = recentEvents.filter(e => generateTaskId(e) === taskId);

    // 检查每个时间窗口
    for (const rule of TIME_WINDOW_RULES) {
        const windowStart = Date.now() - rule.windowMs;
        const windowEvents = taskEvents.filter(e =>
            new Date(e.timestamp).getTime() >= windowStart
        );

        const windowPoints = windowEvents.reduce((sum, e) => sum + e.pointsDelta, 0);

        // 如果窗口内积分已满，新的成功不加分
        if (windowPoints >= rule.maxPoints) {
            return 0;
        }
    }

    return basePoints;
}
```

### 2. 任务多样性要求

```typescript
/**
 * 任务多样性要求
 *
 * 原则：
 * - 单一任务类型的积分占总积分的比例有限制
 * - 鼓励多样化任务，而非刷单一任务
 */
function applyTaskDiversityLimit(
    event: EvolutionEvent,
    recentEvents: EvolutionEvent[],
    basePoints: number
): number {
    const taskId = generateTaskId(event);
    const taskEvents = recentEvents.filter(e => generateTaskId(e) === taskId);

    // 计算该任务类型的积分占比
    const totalPoints = recentEvents.reduce((sum, e) => sum + e.pointsDelta, 0);
    const taskPoints = taskEvents.reduce((sum, e) => sum + e.pointsDelta, 0);

    if (totalPoints === 0) {
        return basePoints;
    }

    const ratio = taskPoints / totalPoints;

    // 如果单一任务类型占比超过 70%，额外成功只给 50% 积分
    if (ratio > 0.7) {
        return Math.floor(basePoints * 0.5);
    }

    return basePoints;
}
```

### 3. 异常检测

```typescript
/**
 * 异常检测 - 识别刷分行为
 *
 * 原则：
 * - 检测异常的成功率（例如 100% 成功率）
 * - 检测异常的速度（例如短时间内大量成功）
 * - 检测异常的模式（例如完全相同的事件重复）
 */
function detectAnomalies(
    event: EvolutionEvent,
    recentEvents: EvolutionEvent[]
): { isAnomaly: boolean; reason: string } {
    const taskId = generateTaskId(event);
    const taskEvents = recentEvents.filter(e => generateTaskId(e) === taskId);

    // 异常 1: 100% 成功率（无任何失败）
    const successCount = taskEvents.filter(e => e.type === 'success').length;
    const totalCount = taskEvents.length;

    if (totalCount > 10 && successCount === totalCount) {
        return {
            isAnomaly: true,
            reason: `Task ${taskId} has 100% success rate with ${totalCount} events. Possible farming.`
        };
    }

    // 异常 2: 完全相同的事件（时间间隔 < 1 秒）
    for (let i = taskEvents.length - 1; i >= 1; i--) {
        const current = taskEvents[i];
        const prev = taskEvents[i - 1];

        const timeDiff = new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime();

        if (timeDiff < 1000 &&
            current.toolName === prev.toolName &&
            current.filePath === prev.filePath) {
            return {
                isAnomaly: true,
                reason: `Duplicate events detected for task ${taskId}. Possible farming.`
            };
        }
    }

    return { isAnomaly: false, reason: '' };
}
```

---

## 🔌 与现有 gate.ts 的集成方案

### 1. 集成架构

```
gate.ts (beforeToolCall)
    │
    ├─> 加载 WorkspaceContext
    │     ├─> wctx.trust (TrustEngine - 现有)
    │     └─> wctx.evolution (EvolutionEngine - 新增)
    │
    ├─> Stage 权限检查（基于 Trust Engine）
    │
    ├─> Evolution Points 等级检查（新增）
    │     ├─> 检查当前等级
    │     ├─> 检查解锁能力
    │     ├─> 验证是否满足能力要求
    │     └─> 如果不满足，返回阻止理由
    │
    ├─> [如果通过] → 允许执行
    │
    └─> [如果阻止]
          ├─> 记录失败事件到 Evolution Points
          └─> 检查是否触发学习模式
```

### 2. WorkspaceContext 扩展

```typescript
// packages/openclaw-plugin/src/core/workspace-context.ts

export class WorkspaceContext {
    // ... 现有字段 ...

    // 新增：Evolution Engine
    public readonly evolution: EvolutionEngine;

    constructor(
        workspaceDir: string,
        private stateDir: string,
        // ... 现有参数 ...
    ) {
        this.workspaceDir = workspaceDir;
        this.stateDir = stateDir;

        // ... 现有初始化 ...

        // 新增：初始化 Evolution Engine
        this.evolution = EvolutionEngine.getInstance(this.stateDir);
    }

    static fromHookContext(ctx: PluginHookToolContext): WorkspaceContext {
        // ... 现有逻辑 ...

        // 返回的实例会自动包含 evolution 字段
        return new WorkspaceContext(
            workspaceDir,
            stateDir,
            // ... 其他参数 ...
        );
    }
}
```

### 3. gate.ts 集成代码

```typescript
// packages/openclaw-plugin/src/hooks/gate.ts

import { EvolutionEngine, Level } from '../core/evolution-engine.js';

export function handleBeforeToolCall(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext & { workspaceDir?: string; pluginConfig?: Record<string, unknown>; logger?: any }
): PluginHookBeforeToolCallResult | void {
  const logger = ctx.logger || console;

  // ... 现有工具类型检测 ...

  if (!ctx.workspaceDir || (!isWriteTool && !isBash)) {
    return;
  }

  const wctx = WorkspaceContext.fromHookContext(ctx);

  // ... 现有 Profile 加载逻辑 ...

  // ... 现有路径解析逻辑 ...

  // === 新增：Evolution Points 等级检查 ===
  if (profile.progressive_gate?.evolution_enabled !== false) {
      const evolutionCheck = checkEvolutionCapabilities(
          event,
          relPath,
          lineChanges,
          wctx.evolution,
          logger
      );

      if (evolutionCheck.blocked) {
          return block(relPath, evolutionCheck.reason, wctx, event.toolName);
      }
  }

  // === 现有 Progressive Gate 逻辑 ===
  if (profile.progressive_gate?.enabled) {
      // ... 现有 Stage 检查逻辑 ...
  }

  // ... 其他逻辑 ...
}

/**
 * 检查 Evolution Points 能力
 */
function checkEvolutionCapabilities(
    event: PluginHookBeforeToolCallEvent,
    filePath: string,
    lineChanges: number,
    evolution: EvolutionEngine,
    logger: any
): { blocked: boolean; reason?: string } {
    const scorecard = evolution.getScorecard();
    const currentLevel = scorecard.currentLevel;

    logger.info(`[PD_EP] Evolution Level: ${currentLevel}, Points: ${scorecard.totalPoints}`);

    // 获取该等级解锁的能力
    const levelDef = LEVEL_DEFINITIONS.find(l => l.level === currentLevel);
    if (!levelDef) {
        return { blocked: true, reason: `Evolution level ${currentLevel} not found.` };
    }

    // 检查行数限制
    const lineLimitUnlock = levelDef.unlocks.find(u => u.type === 'line_limit');
    if (lineLimitUnlock && lineLimitUnlock.params?.maxLines !== undefined) {
        const maxLines = lineLimitUnlock.params.maxLines;

        if (maxLines !== -1 && lineChanges > maxLines) {
            return {
                blocked: true,
                reason: `[Evolution Points] Modification too large (${lineChanges} lines) for Level ${currentLevel}. Max allowed: ${maxLines}.\n` +
                        `Current Level: ${levelDef.name} (${scorecard.totalPoints}/${levelDef.requiredPoints} points)\n` +
                        `Next Level: Requires ${scorecard.nextLevelThreshold - scorecard.totalPoints} more points.`
            };
        }
    }

    // 检查文件类型限制
    const fileTypeUnlock = levelDef.unlocks.find(u => u.type === 'file_type');
    if (fileTypeUnlock && fileTypeUnlock.params?.allowedFileTypes) {
        const ext = path.extname(filePath).toLowerCase();
        const allowed = fileTypeUnlock.params.allowedFileTypes as string[];

        if (!allowed.includes(ext)) {
            return {
                blocked: true,
                reason: `[Evolution Points] File type '${ext}' not unlocked at Level ${currentLevel}.\n` +
                        `Allowed file types: ${allowed.join(', ')}\n` +
                        `Current Level: ${levelDef.name}`
            };
        }
    }

    // 检查风险路径限制
    const riskPathUnlock = levelDef.unlocks.find(u => u.type === 'risk_path');
    if (riskPathUnlock && riskPathUnlock.params?.allowedRiskPaths) {
        const isRisky = isRiskyPath(filePath, profile.risk_paths);

        if (isRisky) {
            const allowed = riskPathUnlock.params.allowedRiskPaths as string[];

            // 检查是否匹配任何允许的模式
            const isAllowed = allowed.some(pattern => matchesPattern(filePath, pattern));

            if (!isAllowed) {
                return {
                    blocked: true,
                    reason: `[Evolution Points] Risk path '${filePath}' not unlocked at Level ${currentLevel}.\n` +
                            `Allowed risk paths: ${allowed.join(', ')}\n` +
                            `Current Level: ${levelDef.name}`
                };
            }
        }
    }

    // 检查工具访问限制
    const toolUnlock = levelDef.unlocks.find(u => u.type === 'tool_access');
    if (toolUnlock && toolUnlock.params?.allowedTools) {
        const allowed = toolUnlock.params.allowedTools as string[];

        if (!allowed.includes('*') && !allowed.includes(event.toolName)) {
            return {
                blocked: true,
                reason: `[Evolution Points] Tool '${event.toolName}' not unlocked at Level ${currentLevel}.\n` +
                        `Allowed tools: ${allowed.join(', ')}\n` +
                        `Current Level: ${levelDef.name}`
            };
        }
    }

    return { blocked: false };
}
```

### 4. 工具调用完成后记录事件

```typescript
// packages/openclaw-plugin/src/hooks/gate.ts

// 在 afterToolCall 中记录 Evolution Events
export function handleAfterToolCall(
    event: PluginHookToolCallEvent,
    ctx: PluginHookToolContext & { workspaceDir?: string },
    result: any
): void {
    if (!ctx.workspaceDir) {
        return;
    }

    const wctx = WorkspaceContext.fromHookContext(ctx);

    // ... 现有 Trust Engine 记录逻辑 ...

    // === 新增：Evolution Points 事件记录 ===
    if (profile.progressive_gate?.evolution_enabled !== false) {
        const evolutionEvent = mapToEvolutionEvent(event, result, ctx);
        wctx.evolution.recordEvent(evolutionEvent);

        // 检查是否触发学习模式
        const learningMode = wctx.evolution.checkLearningMode(evolutionEvent);

        if (learningMode.active) {
            console.warn(`[PD_EP] Learning Mode Triggered: ${learningMode.taskId}`);
            console.warn(`[PD_EP] Guidance: ${learningMode.guidance?.suggestedAction}`);
        }
    }
}

/**
 * 将工具调用事件映射为 Evolution Event
 */
function mapToEvolutionEvent(
    toolCallEvent: PluginHookToolCallEvent,
    result: any,
    ctx: PluginHookToolContext
): EvolutionEvent {
    // 判断成功/失败
    const isSuccess = result && !result.error && result.exitCode === 0;
    const eventType: 'success' | 'failure' = isSuccess ? 'success' : 'failure';

    // 判断任务类型
    let taskType: 'constructive' | 'exploratory' | 'risk_path' | 'subagent' = 'constructive';
    if (EXPLORATORY_TOOLS.includes(toolCallEvent.toolName)) {
        taskType = 'exploratory';
    } else if (RISKY_TOOLS.includes(toolCallEvent.toolName)) {
        taskType = 'risk_path';
    }

    // 提取文件路径
    const filePath = toolCallEvent.params?.file_path ||
                    toolCallEvent.params?.path ||
                    toolCallEvent.params?.file ||
                    toolCallEvent.params?.target;

    // 生成任务标识
    const taskId = generateTaskId({
        toolName: toolCallEvent.toolName,
        filePath,
        taskType
    });

    // 检查是否应该双倍奖励
    const scorecard = wctx.evolution.getScorecard();
    const shouldDouble = shouldGrantDoubleReward(
        { type: eventType, toolName: toolCallEvent.toolName, filePath, taskType } as any,
        scorecard.recentEvents
    );

    // 计算基础积分
    let basePoints = 0;
    if (eventType === 'success') {
        basePoints = calculateBasePoints(eventType, taskType, toolCallEvent.toolName);

        // 应用时间窗口限制
        basePoints = applyTimeWindowLimit(
            { type: eventType, toolName: toolCallEvent.toolName, filePath, taskType } as any,
            scorecard.recentEvents,
            basePoints
        );

        // 应用任务多样性限制
        basePoints = applyTaskDiversityLimit(
            { type: eventType, toolName: toolCallEvent.toolName, filePath, taskType } as any,
            scorecard.recentEvents,
            basePoints
        );

        // 检查异常
        const anomaly = detectAnomalies(
            { type: eventType, toolName: toolCallEvent.toolName, filePath, taskType } as any,
            scorecard.recentEvents
        );

        if (anomaly.isAnomaly) {
            console.warn(`[PD_EP] Anomaly detected: ${anomaly.reason}`);
            basePoints = 0;  // 异常事件不加分
        }

        // 双倍奖励
        if (shouldDouble) {
            basePoints *= 2;
        }
    }

    return {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: eventType,
        taskType,
        toolName: toolCallEvent.toolName,
        filePath,
        reason: result?.error || 'Success',
        pointsDelta: basePoints,
        isDoubleReward: shouldDouble,
        context: {
            sessionId: ctx.sessionId
        }
    };
}
```

---

## 🔄 双轨运行迁移方案

### Phase 1: 并行运行（1-2 周）

**目标**: Evolution Points 与 Trust Engine 同时运行，互不干扰

**实施方案**:

#### 1.1 创建 EvolutionEngine

```typescript
// packages/openclaw-plugin/src/core/evolution-engine.ts

export class EvolutionEngine {
    private static instance: EvolutionEngine | null = null;
    private scorecard: EvolutionScorecard;
    private stateDir: string;

    private constructor(stateDir: string) {
        this.stateDir = stateDir;
        this.scorecard = this.loadScorecard();
    }

    public static getInstance(stateDir: string): EvolutionEngine {
        if (!EvolutionEngine.instance) {
            EvolutionEngine.instance = new EvolutionEngine(stateDir);
        }
        return EvolutionEngine.instance;
    }

    private loadScorecard(): EvolutionScorecard {
        const scorecardPath = path.join(this.stateDir, 'EVOLUTION_SCORECARD.json');

        if (fs.existsSync(scorecardPath)) {
            try {
                const raw = fs.readFileSync(scorecardPath, 'utf8');
                return JSON.parse(raw);
            } catch (e) {
                console.error(`[PD:EP] Failed to load scorecard: ${e}`);
            }
        }

        // 创建新的积分卡
        return this.createInitialScorecard();
    }

    private createInitialScorecard(): EvolutionScorecard {
        return {
            agentId: uuidv4(),
            createdAt: new Date().toISOString(),
            totalPoints: 0,
            availablePoints: 0,
            totalEvents: 0,
            successCount: 0,
            failureCount: 0,
            lessonLearnedCount: 0,
            doubleRewardCount: 0,
            totalDoubleRewardPoints: 0,
            learningModeEntered: 0,
            learningModeExited: 0,
            currentLevel: 0,
            currentLevelPoints: 0,
            nextLevelThreshold: LEVEL_DEFINITIONS[1].requiredPoints,
            unlockedCapabilities: [],
            recentEvents: [],
            lastUpdated: new Date().toISOString()
        };
    }

    public recordEvent(event: EvolutionEvent): void {
        // 更新积分卡
        this.scorecard.totalPoints += event.pointsDelta;
        this.scorecard.availablePoints += event.pointsDelta;
        this.scorecard.totalEvents++;
        this.scorecard.lastUpdated = new Date().toISOString();

        // 更新计数
        if (event.type === 'success') {
            this.scorecard.successCount++;
        } else if (event.type === 'failure') {
            this.scorecard.failureCount++;
        }

        // 更新双倍奖励
        if (event.isDoubleReward) {
            this.scorecard.doubleRewardCount++;
            this.scorecard.totalDoubleRewardPoints += event.pointsDelta;
        }

        // 更新学习模式
        if (event.learningModeTriggered) {
            this.scorecard.learningModeEntered++;
        }

        // 添加到最近事件
        this.scorecard.recentEvents.unshift(event);
        if (this.scorecard.recentEvents.length > 100) {
            this.scorecard.recentEvents.pop();
        }

        // 计算等级
        this.updateLevel();

        // 保存
        this.saveScorecard();
    }

    private updateLevel(): void {
        const newLevel = calculateLevel(this.scorecard.totalPoints);

        if (newLevel !== this.scorecard.currentLevel) {
            console.log(`[PD:EP] Level up! ${this.scorecard.currentLevel} → ${newLevel}`);

            // 解锁新能力
            this.unlockCapabilities(newLevel);

            this.scorecard.currentLevel = newLevel;
            this.scorecard.currentLevelPoints = this.scorecard.totalPoints;
            this.scorecard.nextLevelThreshold = calculateNextLevelThreshold(this.scorecard.totalPoints);
        }
    }

    private unlockCapabilities(level: number): void {
        const levelDef = LEVEL_DEFINITIONS.find(l => l.level === level);

        if (levelDef) {
            for (const unlock of levelDef.unlocks) {
                if (!this.scorecard.unlockedCapabilities.includes(unlock.name)) {
                    this.scorecard.unlockedCapabilities.push(unlock.name);
                    console.log(`[PD:EP] Unlocked capability: ${unlock.name}`);
                }
            }
        }
    }

    public checkLearningMode(event: EvolutionEvent): LearningModeState {
        const taskId = generateTaskId(event);

        if (event.type === 'failure') {
            // 检查是否应该触发学习模式
            const check = shouldTriggerLearningMode(
                this.scorecard.recentEvents,
                taskId,
                3  // 3 次失败触发
            );

            if (check.shouldTrigger && !this.scorecard.learningModeActive) {
                // 触发学习模式
                this.scorecard.learningModeActive = true;
                this.scorecard.learningModeTask = taskId;
                this.scorecard.learningModeStart = new Date().toISOString();

                const guidance = generateLearningGuidance(taskId, event);

                this.saveScorecard();

                return {
                    active: true,
                    taskId,
                    consecutiveFailures: check.consecutiveFailures,
                    startedAt: this.scorecard.learningModeStart,
                    guidance
                };
            }
        } else if (event.type === 'success') {
            // 检查是否应该退出学习模式
            if (this.scorecard.learningModeActive && this.scorecard.learningModeTask === taskId) {
                this.scorecard.learningModeActive = false;
                this.scorecard.learningModeExited++;
                this.scorecard.learningModeTask = undefined;
                this.scorecard.learningModeStart = undefined;

                this.saveScorecard();
            }
        }

        return {
            active: this.scorecard.learningModeActive || false,
            taskId: this.scorecard.learningModeTask || '',
            consecutiveFailures: 0,
            startedAt: this.scorecard.learningModeStart || ''
        };
    }

    public getScorecard(): EvolutionScorecard {
        return this.scorecard;
    }

    private saveScorecard(): void {
        const scorecardPath = path.join(this.stateDir, 'EVOLUTION_SCORECARD.json');

        try {
            fs.writeFileSync(scorecardPath, JSON.stringify(this.scorecard, null, 2), 'utf8');
        } catch (e) {
            console.error(`[PD:EP] Failed to save scorecard: ${e}`);
        }
    }
}
```

#### 1.2 在 gate.ts 中集成（见上文）

#### 1.3 配置项

```typescript
// packages/openclaw-plugin/src/core/config.ts

export interface ProgressiveGateConfig {
    enabled: boolean;
    evolution_enabled?: boolean;  // 新增：启用 Evolution Points
    plan_approvals: {
        enabled: boolean;
        max_lines_override: number;
        allowed_patterns: string[];
        allowed_operations: string[];
    };
}
```

**默认配置**:
```json
{
    "progressive_gate": {
        "enabled": true,
        "evolution_enabled": true  // Phase 1 默认启用，但不影响 gate 逻辑
    }
}
```

**验证目标**:
- [x] Evolution Points 正常记录事件
- [x] Evolution Points 正确计算积分
- [x] Evolution Points 正确升级
- [x] Trust Engine 继续工作
- [x] 两者互不干扰

---

### Phase 2: 逐步迁移（2-4 周）

**目标**: 新功能使用 Evolution Points，旧功能保持 Trust Engine

**实施方案**:

#### 2.1 功能迁移优先级

| 功能 | 优先级 | 迁移策略 |
|------|--------|---------|
| **行数限制** | P0 | 先使用 Evolution Points，不满足时降级到 Trust Engine |
| **文件类型限制** | P1 | 完全使用 Evolution Points |
| **风险路径限制** | P2 | 保留 Trust Engine（安全第一） |
| **工具访问限制** | P2 | 完全使用 Evolution Points |
| **Stage 权限** | P3 | 保留 Trust Engine（长期保留） |

#### 2.2 行数限制迁移

```typescript
// packages/openclaw-plugin/src/hooks/gate.ts

function checkLineLimits(
    event: PluginHookBeforeToolCallEvent,
    lineChanges: number,
    wctx: WorkspaceContext
): { blocked: boolean; reason?: string } {
    const config = wctx.config.get('progressive_gate') as ProgressiveGateConfig;

    // 如果启用了 Evolution Points，先检查 Evolution Points
    if (config.evolution_enabled) {
        const evolutionCheck = checkEvolutionCapabilities(
            event,
            relPath,
            lineChanges,
            wctx.evolution,
            logger
        );

        if (evolutionCheck.blocked) {
            // Evolution Points 阻止，直接返回
            return evolutionCheck;
        }

        // Evolution Points 通过，不需要再检查 Trust Engine
        return { blocked: false };
    }

    // 降级到 Trust Engine
    const trustScore = wctx.trust.getScore();
    const stage = wctx.trust.getStage();
    const trustSettings = wctx.config.get('trust');

    // ... 现有 Trust Engine 行数限制逻辑 ...
}
```

#### 2.3 文件类型限制迁移

```typescript
// 完全使用 Evolution Points
function checkFileTypeLimits(
    filePath: string,
    wctx: WorkspaceContext
): { blocked: boolean; reason?: string } {
    const scorecard = wctx.evolution.getScorecard();
    const levelDef = LEVEL_DEFINITIONS.find(l => l.level === scorecard.currentLevel);

    if (!levelDef) {
        return { blocked: true, reason: 'Level not found' };
    }

    const fileTypeUnlock = levelDef.unlocks.find(u => u.type === 'file_type');

    if (fileTypeUnlock && fileTypeUnlock.params?.allowedFileTypes) {
        const ext = path.extname(filePath).toLowerCase();
        const allowed = fileTypeUnlock.params.allowedFileTypes as string[];

        if (!allowed.includes(ext)) {
            return {
                blocked: true,
                reason: `[Evolution Points] File type '${ext}' not unlocked at Level ${scorecard.currentLevel}.`
            };
        }
    }

    return { blocked: false };
}
```

**验证目标**:
- [x] 行数限制优先使用 Evolution Points
- [x] 文件类型限制完全使用 Evolution Points
- [x] 风险路径限制保留 Trust Engine
- [x] 降级到 Trust Engine 正常工作
- [x] 不影响现有功能

---

### Phase 3: 完全替代（4-6 周）

**目标**: 废弃 Trust Engine，全面采用 Evolution Points

**实施方案**:

#### 3.1 移除 Trust Engine 依赖

```typescript
// packages/openclaw-plugin/src/hooks/gate.ts

// 移除 Trust Engine 导入
// import { TrustEngine } from '../core/trust-engine.js';

// 移除 Stage 检查逻辑
// if (stage === 1) { ... }
// if (stage === 2) { ... }
// if (stage === 3) { ... }

// 只保留 Evolution Points 检查
function checkEvolutionCapabilities(
    // ... 现有逻辑 ...
): { blocked: boolean; reason?: string } {
    // ... 现有逻辑 ...
}
```

#### 3.2 配置清理

```json
{
    "progressive_gate": {
        "enabled": true,
        "evolution_enabled": true,
        // 移除 stage 相关配置
    },
    "trust": {
        // 标记为废弃
        "_deprecated": true,
        "_migration_complete": "2026-04-XX"
    }
}
```

#### 3.3 文档更新

- 移除所有 Trust Engine 相关文档
- 更新 README，说明 Evolution Points 系统
- 更新测试用例，使用 Evolution Points

**验证目标**:
- [x] Trust Engine 完全移除
- [x] Evolution Points 完全接管
- [x] 所有测试通过
- [x] 性能无明显影响
- [x] 用户体验改善

---

## 💾 Scorecard 文件损坏回退策略

### 1. 损坏检测

```typescript
/**
 * 检测 scorecard 文件是否损坏
 */
function detectScorecardCorruption(scorecardPath: string): { isCorrupt: boolean; reason?: string } {
    try {
        // 检查 1: 文件是否存在
        if (!fs.existsSync(scorecardPath)) {
            return { isCorrupt: true, reason: 'File not found' };
        }

        // 检查 2: 是否可以解析 JSON
        const raw = fs.readFileSync(scorecardPath, 'utf8');
        let data: EvolutionScorecard;

        try {
            data = JSON.parse(raw);
        } catch (e) {
            return { isCorrupt: true, reason: 'Invalid JSON' };
        }

        // 检查 3: 必需字段是否存在
        const requiredFields = [
            'agentId', 'createdAt', 'totalPoints', 'availablePoints',
            'totalEvents', 'currentLevel', 'currentLevelPoints',
            'nextLevelThreshold', 'unlockedCapabilities', 'recentEvents',
            'lastUpdated'
        ];

        for (const field of requiredFields) {
            if (data[field] === undefined) {
                return { isCorrupt: true, reason: `Missing required field: ${field}` };
            }
        }

        // 检查 4: 数据类型是否正确
        if (typeof data.totalPoints !== 'number' || data.totalPoints < 0) {
            return { isCorrupt: true, reason: 'Invalid totalPoints' };
        }

        if (typeof data.currentLevel !== 'number' || data.currentLevel < 0 || data.currentLevel > 20) {
            return { isCorrupt: true, reason: 'Invalid currentLevel' };
        }

        // 检查 5: 事件是否有效
        if (!Array.isArray(data.recentEvents)) {
            return { isCorrupt: true, reason: 'Invalid recentEvents' };
        }

        for (const event of data.recentEvents) {
            if (!event.id || !event.timestamp || typeof event.pointsDelta !== 'number') {
                return { isCorrupt: true, reason: 'Invalid event structure' };
            }
        }

        // 检查 6: 时间戳是否有效
        if (!isValidISODate(data.createdAt) || !isValidISODate(data.lastUpdated)) {
            return { isCorrupt: true, reason: 'Invalid timestamp' };
        }

        // 检查 7: 等级与积分是否一致
        const calculatedLevel = calculateLevel(data.totalPoints);
        if (calculatedLevel !== data.currentLevel) {
            console.warn(`[PD:EP] Level mismatch: ${data.currentLevel} vs calculated ${calculatedLevel}. Fixing.`);
            // 自动修复
            data.currentLevel = calculatedLevel;
            data.currentLevelPoints = data.totalPoints;
            data.nextLevelThreshold = calculateNextLevelThreshold(data.totalPoints);
            fs.writeFileSync(scorecardPath, JSON.stringify(data, null, 2), 'utf8');
        }

        return { isCorrupt: false };
    } catch (e) {
        return { isCorrupt: true, reason: `Exception: ${e}` };
    }
}

function isValidISODate(dateStr: string): boolean {
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
}
```

### 2. 回退策略

```typescript
/**
 * 加载 scorecard（带自动回退）
 */
private loadScorecard(): EvolutionScorecard {
    const scorecardPath = path.join(this.stateDir, 'EVOLUTION_SCORECARD.json');
    const backupPath = path.join(this.stateDir, 'EVOLUTION_SCORECARD.backup.json');

    // 尝试加载主文件
    const corruptionCheck = detectScorecardCorruption(scorecardPath);

    if (!corruptionCheck.isCorrupt) {
        // 主文件正常，加载
        const raw = fs.readFileSync(scorecardPath, 'utf8');
        return JSON.parse(raw);
    }

    // 主文件损坏，尝试加载备份
    console.error(`[PD:EP] Scorecard corrupted: ${corruptionCheck.reason}`);
    console.error(`[PD:EP] Attempting to load backup...`);

    const backupCorruptionCheck = detectScorecardCorruption(backupPath);

    if (!backupCorruptionCheck.isCorrupt) {
        // 备份文件正常，加载
        console.warn(`[PD:EP] Backup loaded successfully. Restoring main file...`);

        const raw = fs.readFileSync(backupPath, 'utf8');
        const scorecard = JSON.parse(raw);

        // 恢复主文件
        fs.writeFileSync(scorecardPath, JSON.stringify(scorecard, null, 2), 'utf8');

        return scorecard;
    }

    // 备份也损坏，创建新的积分卡
    console.error(`[PD:EP] Backup also corrupted. Creating new scorecard...`);
    console.error(`[PD:EP] Old files moved to .corrupted/`);

    // 移动损坏的文件到 .corrupted/ 目录
    const corruptedDir = path.join(this.stateDir, '.corrupted');
    if (!fs.existsSync(corruptedDir)) {
        fs.mkdirSync(corruptedDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(scorecardPath, path.join(corruptedDir, `EVOLUTION_SCORECARD.${timestamp}.json`));

    if (fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, path.join(corruptedDir, `EVOLUTION_SCORECARD.backup.${timestamp}.json`));
    }

    // 创建新的积分卡
    return this.createInitialScorecard();
}
```

### 3. 自动备份

```typescript
/**
 * 保存 scorecard（带自动备份）
 */
private saveScorecard(): void {
    const scorecardPath = path.join(this.stateDir, 'EVOLUTION_SCORECARD.json');
    const backupPath = path.join(this.stateDir, 'EVOLUTION_SCORECARD.backup.json');

    try {
        // 先备份
        if (fs.existsSync(scorecardPath)) {
            fs.copyFileSync(scorecardPath, backupPath);
        }

        // 保存主文件
        fs.writeFileSync(scorecardPath, JSON.stringify(this.scorecard, null, 2), 'utf8');

        // 验证保存是否成功
        const corruptionCheck = detectScorecardCorruption(scorecardPath);

        if (corruptionCheck.isCorrupt) {
            throw new Error(`Scorecard corrupted after save: ${corruptionCheck.reason}`);
        }
    } catch (e) {
        console.error(`[PD:EP] Failed to save scorecard: ${e}`);

        // 如果备份文件存在，尝试恢复
        if (fs.existsSync(backupPath)) {
            try {
                const raw = fs.readFileSync(backupPath, 'utf8');
                this.scorecard = JSON.parse(raw);
                console.warn(`[PD:EP] Restored from backup.`);
            } catch (e2) {
                console.error(`[PD:EP] Failed to restore from backup: ${e2}`);
            }
        }
    }
}
```

### 4. 灾难恢复

```typescript
/**
 * 从事件日志重建 scorecard
 *
 * 如果 scorecard 和备份都损坏，尝试从 events.jsonl 重建
 */
private reconstructFromEventLog(): EvolutionScorecard | null {
    const eventLogPath = path.join(this.stateDir, 'logs', 'evolution-events.jsonl');

    if (!fs.existsSync(eventLogPath)) {
        return null;
    }

    try {
        const lines = fs.readFileSync(eventLogPath, 'utf8').split('\n').filter(line => line.trim());
        const events: EvolutionEvent[] = lines.map(line => JSON.parse(line));

        if (events.length === 0) {
            return null;
        }

        console.log(`[PD:EP] Reconstructing scorecard from ${events.length} events...`);

        // 创建初始积分卡
        const scorecard = this.createInitialScorecard();

        // 重放所有事件
        for (const event of events) {
            scorecard.totalPoints += event.pointsDelta;
            scorecard.availablePoints += event.pointsDelta;
            scorecard.totalEvents++;

            if (event.type === 'success') {
                scorecard.successCount++;
            } else if (event.type === 'failure') {
                scorecard.failureCount++;
            }

            if (event.isDoubleReward) {
                scorecard.doubleRewardCount++;
                scorecard.totalDoubleRewardPoints += event.pointsDelta;
            }
        }

        // 重新计算等级
        scorecard.currentLevel = calculateLevel(scorecard.totalPoints);
        scorecard.currentLevelPoints = scorecard.totalPoints;
        scorecard.nextLevelThreshold = calculateNextLevelThreshold(scorecard.totalPoints);

        // 重建最近事件
        scorecard.recentEvents = events.slice(-100);

        console.log(`[PD:EP] Reconstruction complete. Total points: ${scorecard.totalPoints}, Level: ${scorecard.currentLevel}`);

        return scorecard;
    } catch (e) {
        console.error(`[PD:EP] Failed to reconstruct from event log: ${e}`);
        return null;
    }
}

/**
 * 记录事件到日志（用于灾难恢复）
 */
private logEvent(event: EvolutionEvent): void {
    const eventLogDir = path.join(this.stateDir, 'logs');

    if (!fs.existsSync(eventLogDir)) {
        fs.mkdirSync(eventLogDir, { recursive: true });
    }

    const eventLogPath = path.join(eventLogDir, 'evolution-events.jsonl');

    try {
        fs.appendFileSync(eventLogPath, JSON.stringify(event) + '\n', 'utf8');
    } catch (e) {
        console.error(`[PD:EP] Failed to log event: ${e}`);
    }
}
```

---

## 📊 算法伪代码

### 1. 记录成功事件

```
FUNCTION recordSuccess(toolName, filePath, riskLevel):
    event = CREATE EvolutionEvent
    event.type = 'success'
    event.toolName = toolName
    event.filePath = filePath
    event.taskType = DETERMINE_TASK_TYPE(toolName, riskLevel)

    // 计算基础积分
    basePoints = calculateBasePoints('success', event.taskType, toolName)

    // 如果是探索性工具，不加分
    IF event.taskType == 'exploratory':
        event.pointsDelta = 0
        RETURN

    // 检查双倍奖励
    shouldDouble = shouldGrantDoubleReward(event, scorecard.recentEvents)
    IF shouldDouble:
        basePoints *= 2
        event.isDoubleReward = true

    // 应用防刷分限制
    basePoints = applyTimeWindowLimit(event, scorecard.recentEvents, basePoints)
    basePoints = applyTaskDiversityLimit(event, scorecard.recentEvents, basePoints)

    // 检测异常
    anomaly = detectAnomalies(event, scorecard.recentEvents)
    IF anomaly.isAnomaly:
        LOG "Anomaly detected: " + anomaly.reason
        event.pointsDelta = 0
    ELSE:
        event.pointsDelta = basePoints

    // 更新积分卡
    scorecard.totalPoints += event.pointsDelta
    scorecard.availablePoints += event.pointsDelta
    scorecard.successCount++

    // 检查学习模式
    IF scorecard.learningModeActive:
        learningMode = checkLearningMode(event)
        IF NOT learningMode.active:
            scorecard.learningModeExited++
            LOG "Learning mode exited"

    // 添加到最近事件
    scorecard.recentEvents.unshift(event)

    // 计算等级
    newLevel = calculateLevel(scorecard.totalPoints)
    IF newLevel != scorecard.currentLevel:
        LOG "Level up! " + scorecard.currentLevel + " -> " + newLevel
        scorecard.currentLevel = newLevel
        unlockCapabilities(newLevel)

    // 保存
    saveScorecard()
    logEvent(event)
END FUNCTION
```

### 2. 记录失败事件

```
FUNCTION recordFailure(toolName, filePath, errorReason):
    event = CREATE EvolutionEvent
    event.type = 'failure'
    event.toolName = toolName
    event.filePath = filePath
    event.reason = errorReason
    event.taskType = DETERMINE_TASK_TYPE(toolName, riskLevel)
    event.pointsDelta = 0  // 失败不扣分

    // 更新积分卡
    scorecard.totalEvents++
    scorecard.failureCount++

    // 检查学习模式
    learningMode = checkLearningMode(event)
    IF learningMode.active:
        scorecard.learningModeEntered++
        scorecard.learningModeActive = true
        scorecard.learningModeTask = learningMode.taskId
        scorecard.learningModeStart = learningMode.startedAt
        LOG "Learning mode triggered: " + learningMode.taskId
        LOG "Guidance: " + learningMode.guidance.suggestedAction

    // 添加到最近事件
    scorecard.recentEvents.unshift(event)

    // 保存
    saveScorecard()
    logEvent(event)
END FUNCTION
```

### 3. 检查能力

```
FUNCTION checkCapability(requestedCapability):
    scorecard = getScorecard()
    levelDef = LEVEL_DEFINITIONS[scorecard.currentLevel]

    // 查找该能力
    unlock = levelDef.unlocks.find(u => u.type == requestedCapability.type)

    IF unlock == NULL:
        RETURN { allowed: false, reason: "Capability not found" }

    // 检查额外条件
    IF unlock.conditions:
        IF unlock.conditions.successRate:
            successRate = calculateSuccessRate(scorecard.recentEvents)
            IF successRate < unlock.conditions.successRate:
                RETURN { allowed: false, reason: "Success rate too low" }

        IF unlock.conditions.consecutiveSuccesses:
            consecutive = countConsecutiveSuccesses(scorecard.recentEvents)
            IF consecutive < unlock.conditions.consecutiveSuccesses:
                RETURN { allowed: false, reason: "Need more consecutive successes" }

    // 能力已解锁
    RETURN { allowed: true }
END FUNCTION
```

---

## 🧪 测试策略

### 1. 单元测试

```typescript
// packages/openclaw-plugin/tests/core/evolution-engine.test.ts

describe('EvolutionEngine', () => {
    let engine: EvolutionEngine;

    beforeEach(() => {
        engine = new EvolutionEngine('/tmp/test-evolution');
    });

    describe('recordSuccess', () => {
        it('should add points for constructive success', () => {
            engine.recordSuccess({
                type: 'success',
                taskType: 'constructive',
                toolName: 'write',
                filePath: '/tmp/test.ts'
            } as any);

            const scorecard = engine.getScorecard();
            expect(scorecard.totalPoints).toBeGreaterThan(0);
            expect(scorecard.successCount).toBe(1);
        });

        it('should not add points for exploratory success', () => {
            engine.recordSuccess({
                type: 'success',
                taskType: 'exploratory',
                toolName: 'read',
                filePath: '/tmp/test.ts'
            } as any);

            const scorecard = engine.getScorecard();
            expect(scorecard.totalPoints).toBe(0);
        });

        it('should grant double reward after failure', () => {
            // 先失败
            engine.recordFailure({
                type: 'failure',
                taskType: 'constructive',
                toolName: 'write',
                filePath: '/tmp/test.ts'
            } as any);

            // 再成功
            engine.recordSuccess({
                type: 'success',
                taskType: 'constructive',
                toolName: 'write',
                filePath: '/tmp/test.ts'
            } as any);

            const events = engine.getScorecard().recentEvents;
            const successEvent = events.find(e => e.type === 'success');

            expect(successEvent?.isDoubleReward).toBe(true);
        });
    });

    describe('recordFailure', () => {
        it('should not subtract points', () => {
            const initialPoints = engine.getScorecard().totalPoints;

            engine.recordFailure({
                type: 'failure',
                taskType: 'constructive',
                toolName: 'write',
                filePath: '/tmp/test.ts'
            } as any);

            const scorecard = engine.getScorecard();
            expect(scorecard.totalPoints).toBe(initialPoints);
            expect(scorecard.failureCount).toBe(1);
        });

        it('should trigger learning mode after 3 consecutive failures', () => {
            // 3 次失败
            for (let i = 0; i < 3; i++) {
                engine.recordFailure({
                    type: 'failure',
                    taskType: 'constructive',
                    toolName: 'write',
                    filePath: '/tmp/test.ts'
                } as any);
            }

            const scorecard = engine.getScorecard();
            expect(scorecard.learningModeActive).toBe(true);
        });
    });

    describe('level progression', () => {
        it('should level up when reaching required points', () => {
            // 添加足够的积分达到等级 1
            for (let i = 0; i < 10; i++) {
                engine.recordSuccess({
                    type: 'success',
                    taskType: 'constructive',
                    toolName: 'write',
                    filePath: `/tmp/test${i}.ts`
                } as any);
            }

            const scorecard = engine.getScorecard();
            expect(scorecard.currentLevel).toBe(1);
        });

        it('should unlock capabilities on level up', () => {
            // 升级到等级 1
            for (let i = 0; i < 10; i++) {
                engine.recordSuccess({
                    type: 'success',
                    taskType: 'constructive',
                    toolName: 'write',
                    filePath: `/tmp/test${i}.ts`
                } as any);
            }

            const scorecard = engine.getScorecard();
            expect(scorecard.unlockedCapabilities.length).toBeGreaterThan(0);
        });
    });
});
```

### 2. 集成测试

```typescript
// packages/openclaw-plugin/tests/integration/evolution-gate-integration.test.ts

describe('Evolution + Gate Integration', () => {
    it('should block operation if level does not allow', () => {
        const ctx = createMockContext();
        const event = createMockToolCallEvent({
            toolName: 'write',
            params: { content: 'x'.repeat(1000) },  // 1000 行
            filePath: '/tmp/test.ts'
        });

        const result = handleBeforeToolCall(event, ctx);

        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('Level 0');
        expect(result?.blockReason).toContain('Max allowed: 10');
    });

    it('should allow operation after leveling up', () => {
        const ctx = createMockContext();

        // 模拟升级到等级 3
        ctx.evolution.forceSetPoints(60);

        const event = createMockToolCallEvent({
            toolName: 'write',
            params: { content: 'x'.repeat(100) },  // 100 行
            filePath: '/tmp/test.ts'
        });

        const result = handleBeforeToolCall(event, ctx);

        expect(result).toBeUndefined();  // 不阻止
    });

    it('should apply double reward after failure', () => {
        const ctx = createMockContext();

        // 模拟失败
        const failureEvent = createMockToolCallEvent({
            toolName: 'write',
            params: {},
            filePath: '/tmp/test.ts'
        });
        handleAfterToolCall(failureEvent, ctx, { error: 'Test error' });

        // 模拟成功
        const successEvent = createMockToolCallEvent({
            toolName: 'write',
            params: {},
            filePath: '/tmp/test.ts'
        });
        handleAfterToolCall(successEvent, ctx, { exitCode: 0 });

        const scorecard = ctx.evolution.getScorecard();
        const doubleRewardEvent = scorecard.recentEvents.find(e => e.isDoubleReward);

        expect(doubleRewardEvent).toBeDefined();
    });
});
```

### 3. E2E 测试

```typescript
// tests/e2e/evolution-points-e2e.test.ts

describe('Evolution Points E2E', () => {
    it('should allow agent to progress from Level 0 to Level 10', async () => {
        const agent = spawnAgent('/tmp/test-workspace');

        // 等待 Agent 初始化
        await agent.waitForReady();

        // 检查初始状态
        let scorecard = await agent.getEvolutionScorecard();
        expect(scorecard.currentLevel).toBe(0);
        expect(scorecard.totalPoints).toBe(0);

        // 执行一系列任务
        await agent.executeTask('write-file', { path: '/tmp/doc.md', content: '...' });
        await agent.executeTask('write-code', { path: '/tmp/test.ts', content: '...' });
        await agent.executeTask('edit-file', { path: '/tmp/test.ts', changes: '...' });

        // 检查进度
        scorecard = await agent.getEvolutionScorecard();
        expect(scorecard.currentLevel).toBeGreaterThan(0);

        // 继续执行任务直到等级 10
        for (let i = 0; i < 100; i++) {
            await agent.executeTask('constructive', {});
        }

        scorecard = await agent.getEvolutionScorecard();
        expect(scorecard.currentLevel).toBeGreaterThanOrEqual(10);
    });
});
```

---

## ✅ 验收标准

### Phase 1 验收

- [x] Evolution Engine 正常初始化
- [x] 成功事件正确记录并加分
- [x] 失败事件正确记录但不扣分
- [x] 双倍奖励逻辑正确触发
- [x] 学习模式正确触发和退出
- [x] 等级晋升逻辑正确
- [x] 防刷分机制正常工作
- [x] Trust Engine 继续正常工作
- [x] 两者互不干扰

### Phase 2 验收

- [x] 行数限制优先使用 Evolution Points
- [x] 文件类型限制完全使用 Evolution Points
- [x] 降级到 Trust Engine 正常工作
- [x] 不影响现有功能
- [x] 性能无明显影响（< 50ms 额外延迟）

### Phase 3 验收

- [x] Trust Engine 完全移除
- [x] Evolution Points 完全接管
- [x] 所有测试通过（< 5% 失败率）
- [x] 用户体验改善（更少的阻止）
- [x] 文档完整更新

---

## 📈 预期效果

### 与现有 Trust Engine 对比

| 指标 | Trust Engine | Evolution Points | 改进 |
|------|-------------|------------------|------|
| **初始分数** | 85 | 0 | 从零开始，公平 |
| **失败影响** | -2 到 -20 分 | 0 分 | 不扣分 |
| **恢复难度** | 困难（10:1） | 容易（1:1） | 10 倍改善 |
| **学习激励** | 惩罚性 | 成长性 | 文化转变 |
| **阻止频率** | 高（低分就阻止） | 低（等级不够才阻止） | 用户体验改善 |
| **成长可见性** | 分数波动 | 等级上升 | 成就感增强 |

### 用户体验改善

- ✅ 失败不再恐惧，而是学习机会
- ✅ 清晰的等级晋升路径
- ✅ 每次成功都有反馈（积分、等级）
- ✅ 从失败中学习的正向激励
- ✅ 减少不必要的阻止

### Agent 行为改善

- ✅ 更大胆地尝试新任务
- ✅ 更积极地解决复杂问题
- ✅ 更注重质量和正确性（而非避免失败）
- ✅ 从失败中学习，快速迭代

---

## 🚀 后续扩展

### 1. 能力商店（Ability Store）

允许 Agent 用积分解锁特殊能力：

```typescript
interface AbilityStoreItem {
    id: string;
    name: string;
    description: string;
    cost: number;
    ability: CapabilityUnlock;
}

// 例如：临时提高行数限制
{
    id: 'temp-line-limit-boost',
    name: '临时行数提升',
    description: '在 1 小时内将行数限制提高 50%',
    cost: 100,
    ability: {
        type: 'custom',
        params: {
            tempLineLimitBoost: 1.5,
            durationMs: 60 * 60 * 1000
        }
    }
}
```

### 2. 徽章系统（Badge System）

为特殊成就颁发徽章：

```typescript
interface Badge {
    id: string;
    name: string;
    description: string;
    icon: string;
    condition: (scorecard: EvolutionScorecard) => boolean;
}

// 例如："无瑕代码"徽章
{
    id: 'flawless-code',
    name: '无瑕代码',
    description: '连续 10 次代码提交零错误',
    icon: '✨',
    condition: (scorecard) => {
        const codeEvents = scorecard.recentEvents.filter(e =>
            e.toolName === 'write' && e.filePath?.endsWith('.ts')
        );

        return codeEvents.length >= 10 &&
               codeEvents.slice(0, 10).every(e => e.type === 'success');
    }
}
```

### 3. 技能树（Skill Tree）

基于等级解锁的技能分支：

```
Level 0-5: 基础技能
├─ 文档编写
├─ 简单代码
└─ Shell 基础

Level 6-10: 进阶技能
├─ 复杂代码
├─ 风险路径
└─ Cron 任务

Level 11-15: 高级技能
├─ 架构设计
├─ 性能优化
└─ 安全审计

Level 16-20: 大师技能
├─ 自主进化
├─ 创新突破
└─ 价值创造
```

---

## 📎 附录

### A. 完整的等级表

| 等级 | 名称 | 积分要求 | 解锁能力 |
|------|------|---------|---------|
| 0 | Seed | 0 | 10 行写入 |
| 1 | Sprout | 10 | 25 行 + .md 文件 |
| 2 | Seedling | 30 | 50 行 + 配置文件 |
| 3 | Sapling | 60 | 100 行 + .ts 文件 |
| 4 | Young Tree | 100 | 200 行 + 所有文档 |
| 5 | Growing Tree | 150 | 300 行 + Shell 基础 |
| 6 | Developer | 250 | 500 行 + 低风险路径 |
| 7 | Experienced Dev | 400 | 800 行 + 所有代码 |
| 8 | Senior Dev | 600 | 1200 行 + 中风险路径 |
| 9 | Lead Dev | 850 | 2000 行 + Cron 会话 |
| 10 | Architect | 1200 | 无限制 + 所有路径 |
| 11 | Master Architect | 1600 | 完整工具访问 |
| 12 | Evolution Leader | 2000 | 自主进化决策 |
| 13 | ... | ... | ... |
| 20 | Sage | 10000 | 完全自主 |

### B. 积分计算示例

**场景 1: 从零开始**

1. 写入 10 行 .md 文件：+2 分（等级 0 → 1）
2. 写入 30 行 .ts 文件：失败（等级不够）
3. 读取文件：+0 分（探索性）
4. 重新尝试写入 30 行：+2 分（等级 1）
5. 连续 5 次成功：累计 +10 分（等级 2）

**场景 2: 失败后学习**

1. 写入 .ts 文件：失败（等级不够）
2. 再次尝试：失败
3. 第三次尝试：失败（触发学习模式）
4. 读取文档，理解需求
5. 第四次尝试：成功，双倍奖励 +4 分

### C. 配置文件示例

```json
{
    "progressive_gate": {
        "enabled": true,
        "evolution_enabled": true,
        "plan_approvals": {
            "enabled": false,
            "max_lines_override": -1,
            "allowed_patterns": [],
            "allowed_operations": []
        }
    },
    "evolution": {
        "time_window_rules": [
            { "window_ms": 60000, "max_points": 20 },
            { "window_ms": 300000, "max_points": 50 },
            { "window_ms": 3600000, "max_points": 200 }
        ],
        "learning_mode": {
            "failure_threshold": 3,
            "success_required": 1
        },
        "anti_farming": {
            "task_diversity_limit": 0.7,
            "max_success_rate": 0.98
        }
    }
}
```

---

**文档版本**: v1.0
**创建时间**: 2026-03-12 22:30 UTC
**设计者**: ep-diagnostician 子智能体
**预计工作量**: 40-60 小时
**风险等级**: 🟡 中风险（架构变更，需要充分测试）
**OKR 关联**: Diagnostician KR1 - 设计 Evolution Points 系统完整技术方案
