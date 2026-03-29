# Trust Score Removal Plan

## Goal
完全移除信任分系统，让 EP 系统成为唯一门控机制。

## Changes

### 1. evolution-types.ts
- [ ] 移除 `TierPermissions.maxLinesPerWrite`
- [ ] 从 `TIER_DEFINITIONS` 中删除所有 `maxLinesPerWrite` 配置

### 2. evolution-engine.ts  
- [ ] 移除 `beforeToolCall()` 中的行数检查逻辑（lines 215-234）

### 3. progressive-trust-gate.ts
- [ ] 移除 `trustEngine.getScore()` / `trustEngine.getStage()` 调用
- [ ] 移除 Plan Approval 逻辑
- [ ] 移除 Stage 1-4 行数限制检查
- [ ] 让 `checkEvolutionGate()` 实际执行门控（不只是日志）
- [ ] 更新日志信息（移除 trust score 引用）

### 4. phase3-input-filter.ts
- [ ] 移除 trust 分类逻辑（TrustInput, frozen 等）

### 5. runtime-summary-service.ts
- [ ] 移除 `currentTrustScore` 显示

### 6. config.ts
- [ ] 移除 trust 相关配置（如果可以安全删除）

### 7. Tests
- [ ] 更新/移除 trust-engine.test.ts
- [ ] 更新其他测试中的 trust_score fixtures

### 8. 验证
- [ ] 门控正常工作（EP tier 控制风险路径）
- [ ] 无 trust_score 相关编译错误
- [ ] EP 等级系统正常工作

## EP 门控最终逻辑
```typescript
const epDecision = checkEvolutionGate(ctx.workspaceDir!, {
  toolName: event.toolName,
  isRiskPath: risky,
});

if (!epDecision.allowed) {
  return block(relPath, epDecision.reason, ...);
}
```

## EP 最终权限
| Tier | 积分 | 风险路径 | 子智能体 |
|------|------|---------|---------|
| Seed | 0 | ❌ | ❌ |
| Sprout | 50 | ❌ | ❌ |
| Sapling | 200 | ❌ | ✅ |
| Tree | 500 | ✅ | ✅ |
| Forest | 1000 | ✅ | ✅ |
