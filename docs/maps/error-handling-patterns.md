# 错误处理模式 (Error Handling Patterns)

> **用途**: 定义系统中的错误处理规则
> **目标用户**: AI 编程智能体
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与源代码一致

---

## 🔒 1. Fail-Closed 安全模式

**源码**: `src/hooks/gate.ts` (68-81行)

**原则**: 安全相关的错误必须阻塞操作

```typescript
// Bash 命令安全检查
for (const seg of cleanSegments) {
  for (const pattern of dangerousPatterns) {
    try {
      if (new RegExp(pattern, 'i').test(seg)) {
        return 'dangerous';
      }
    } catch (error) {
      // 正则错误 → 阻塞命令
      logger?.warn?.(`[PD_GATE] Invalid dangerous bash regex. Failing closed.`);
      return 'dangerous';
    }
  }
}
```

**适用场景**:
- Bash命令安全检查
- 门禁系统
- 权限验证

---

## 🛡️ 2. 韧性处理模式

**源码**: `src/hooks/pain.ts`, `src/hooks/trajectory-collector.ts`

**原则**: 非关键错误不能中断主流程

```typescript
// 轨迹收集 - 静默失败
api.on('after_tool_call', (event, ctx) => {
  try {
    TrajectoryCollector.handleAfterToolCall(event, ctx);
  } catch (err) {
    // 非关键：不记录日志，不中断
  }
});
```

**适用场景**:
- 痛苦信号捕获
- 轨迹数据记录
- 事件日志记录

---

## 🔄 3. 恢复模式

**源码**: `src/core/trust-engine.ts` (72-88行)

**原则**: 系统必须能够从错误中自动恢复

```typescript
// 分数文件损坏 → 重置为默认值
private loadScorecard(): TrustScorecard {
  try {
    const data = JSON.parse(fs.readFileSync(scorecardPath, 'utf8'));
    return data;
  } catch (e) {
    console.error(`[PD:TrustEngine] FATAL: Failed to parse scorecard. Resetting.`);
    // 返回默认分数卡
  }
}
```

**适用场景**:
- 文件损坏
- 配置错误
- 锁竞争

---

## 🔗 相关源码文件

| 文件 | 关键内容 | 用途 |
|------|----------|------|
| `src/hooks/gate.ts` | Fail-closed 模式 | 安全检查 |
| `src/hooks/pain.ts` | 韧性处理 | 痛苦检测 |
| `src/hooks/trajectory-collector.ts` | 静默失败 | 轨迹收集 |
| `src/core/trust-engine.ts` | 恢复模式 | 分数加载 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与源代码验证一致
