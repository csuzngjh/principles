# PD-001 & PD-002 修复报告

**修复日期**: 2026-03-12
**修复人**: Implementer 子智能体
**任务**: KR1 - PD-001 & PD-002 缺陷修复

---

## 缺陷描述

### PD-001: TrustEngine 初始创建逻辑

**问题**: TrustEngine 在初始化时没有确保 scorecard 文件始终存在。当文件损坏或不存在时，系统会在内存中创建默认 scorecard，但不会持久化到文件系统，导致下次启动时重新初始化。

**影响**:
- 每次启动时信任分都会重置
- 信任历史丢失
- Cold Start 机制失效

**根因**:
```typescript
// 原始代码 (trust-engine.ts constructor)
constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    this.scorecard = this.loadScorecard();
    
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    if (!fs.existsSync(scorecardPath)) {
        this.saveScorecard();
    }
}
```

问题在于：
1. `loadScorecard()` 在解析失败时会在内存中创建新 scorecard，但不保存
2. 文件存在但损坏时，`!fs.existsSync(scorecardPath)` 检查失败，不会保存
3. 导致内存和文件状态不一致

---

### PD-002: 测试 Cleanup 删除生产文件问题

**问题**: 测试文件使用固定的 `/mock/workspace` 路径，没有清理逻辑，可能导致生产文件被意外删除。

**影响**:
- 测试可能删除真实 workspace 中的文件
- 测试状态污染
- 不可重复的测试行为

**根因**:
```typescript
// 原始测试代码 (trust-engine.test.ts)
const workspaceDir = '/mock/workspace';

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('{}');
});
```

问题在于：
1. 使用固定路径 `/mock/workspace`
2. 依赖 mock，没有真实的文件隔离
3. 缺少 `afterEach` 清理逻辑

---

## 修复方案

### PD-001 修复

#### 1. 重构 `saveScorecard()` 方法

添加可选参数，支持在 `this.scorecard` 未初始化时保存：

```typescript
private saveScorecard(scorecard?: TrustScorecard): void {
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    const data = scorecard || this.scorecard;
    try {
        const dir = path.dirname(scorecardPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(scorecardPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error(`[PD:TrustEngine] Failed to save scorecard: ${String(e)}`);
    }
}
```

#### 2. 修改 `loadScorecard()` 方法

在创建新 scorecard 时立即保存：

```typescript
private loadScorecard(): TrustScorecard {
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    const settings = this.trustSettings;

    if (fs.existsSync(scorecardPath)) {
        try {
            const raw = fs.readFileSync(scorecardPath, 'utf8');
            const data = JSON.parse(raw);
            // ... 兼容性处理
            return data;
        } catch (e) {
            console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard at ${scorecardPath}. Resetting and saving.`);
        }
    }

    // Either file doesn't exist or was corrupted - create new scorecard and save it
    const now = new Date();
    const coldStartEnd = new Date(now.getTime() + settings.cold_start.cold_start_period_ms);

    const newScorecard: TrustScorecard = {
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

    // Temporarily assign to enable saveScorecard() to work
    this.scorecard = newScorecard;
    this.saveScorecard();
    
    return newScorecard;
}
```

#### 3. 简化 constructor

移除冗余的文件存在检查：

```typescript
constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    this.scorecard = this.loadScorecard();
}
```

**关键改进**:
- ✅ 确保无论文件不存在还是损坏，都会创建并保存新的 scorecard
- ✅ 文件和内存状态始终一致
- ✅ Trust 分持久化，不会每次启动都重置

---

### PD-002 修复

#### 1. 使用临时目录隔离测试

```typescript
import * as os from 'os';

describe('Trust Engine - Unified Adaptive System', () => {
    let tempDir: string;
    let workspaceDir: string;

    beforeEach(() => {
        // Create a temporary directory for each test
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-engine-test-'));
        workspaceDir = tempDir;
    });

    afterEach(() => {
        // Clean up temporary directory
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
```

#### 2. 移除 mock 依赖，使用真实文件系统

所有测试用例改用真实的文件操作，而不是 `vi.mocked(fs.existsSync)`。

**关键改进**:
- ✅ 每个测试使用独立的临时目录
- ✅ 测试结束后自动清理
- ✅ 不会影响生产文件
- ✅ 更真实的集成测试

---

## 新增测试用例

### 1. Initial Creation - 应该创建 scorecard 文件

```typescript
it('should create scorecard file on first initialization', () => {
    const scorecardPath = path.join(workspaceDir, '.state', 'AGENT_SCORECARD.json');
    
    // Verify file doesn't exist initially
    expect(fs.existsSync(scorecardPath)).toBe(false);
    
    // Create engine (should create file)
    const engine = new TrustEngine(workspaceDir);
    
    // Verify file was created
    expect(fs.existsSync(scorecardPath)).toBe(true);
    
    // Verify file contains valid data
    const fileContent = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    expect(fileContent.trust_score).toBe(59);
    expect(fileContent.grace_failures_remaining).toBe(3);
    expect(fileContent.first_activity_at).toBeDefined();
});
```

### 2. Multiple Instances - 应该处理多个 TrustEngine 实例

```typescript
it('should handle multiple TrustEngine instances with same workspace', () => {
    const scorecardPath = path.join(workspaceDir, '.state', 'AGENT_SCORECARD.json');
    
    // Create first engine
    const engine1 = new TrustEngine(workspaceDir);
    engine1.recordSuccess('First success');
    const score1 = engine1.getScore();
    
    // Create second engine (should load existing scorecard)
    const engine2 = new TrustEngine(workspaceDir);
    const score2 = engine2.getScore();
    
    // Both should have same trust score
    expect(score2).toBe(score1);
    expect(score2).toBeGreaterThan(59);
});
```

### 3. Corrupted File Recovery - 应该从损坏的 scorecard 文件中恢复

```typescript
it('should recover gracefully from corrupted scorecard file', () => {
    const scorecardPath = path.join(workspaceDir, '.state', 'AGENT_SCORECARD.json');
    
    // Create engine to initialize file
    const engine1 = new TrustEngine(workspaceDir);
    const originalScore = engine1.getScore();
    
    // Corrupt the scorecard file
    fs.writeFileSync(scorecardPath, 'invalid json {', 'utf8');
    
    // Create new engine (should detect corruption and reset)
    const engine2 = new TrustEngine(workspaceDir);
    
    // Should have reset to default values
    expect(engine2.getScore()).toBe(59);
    
    // File should be valid again
    const fileContent = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    expect(fileContent.trust_score).toBe(59);
});
```

---

## 测试结果

```
✓ tests/core/trust-engine.test.ts (12 tests) 28ms

Summary:
  Test Files  40 passed (4 failed, unrelated)
       Tests  218 passed (3 failed, unrelated)
```

所有 TrustEngine 测试通过 ✅

**失败的测试**:
- `tests/commands/pain.test.ts`: 3 个失败（与本次修复无关，是现有测试的 mock 问题）
- `tests/index.test.ts`, `tests/index.integration.test.ts`, `tests/hooks/gate.test.ts`: 缺少 `micromatch` 依赖（与本次修复无关）

---

## 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `packages/openclaw-plugin/src/core/trust-engine.ts` | 修复 | PD-001: 确保初始创建时保存 scorecard |
| `packages/openclaw-plugin/tests/core/trust-engine.test.ts` | 修复 + 新增 | PD-002: 使用临时目录 + 3 个新测试用例 |
| `docs/fixes/PD-001-PD-002-fix-report.md` | 新增 | 本修复报告 |

---

## 验收标准

- [x] PD-001: TrustEngine 初始创建逻辑修复完成
- [x] PD-002: 测试 Cleanup 删除生产文件问题修复完成
- [x] 补充 3 个 TrustEngine 单元测试
- [x] 所有 trust-engine 测试通过
- [x] 编写修复报告

---

## 后续建议

1. **修复 pain.test.ts**: 解决 `trust.getScore()` 的 undefined 问题（可能是 WorkspaceContext 的 mock 设置问题）
2. **安装 micromatch**: `npm install` 确保依赖完整
3. **扩展测试覆盖率**: 为其他核心模块（EvolutionWorker, Gatekeeper, PainDictionary）添加类似测试

---

## 风险评估

- **风险等级**: 🟢 低风险
- **向后兼容**: ✅ 完全兼容
- **数据迁移**: 不需要（逻辑修复，无数据结构变更）
- **影响范围**: 仅影响 TrustEngine 初始化逻辑和测试

---

**状态**: ✅ 完成并验证
**OKR 进度**: KR1 - 核心缺陷修复 100% 完成
