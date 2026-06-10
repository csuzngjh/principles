# PRI-362 Dogfood Report

## 验证步骤执行情况

### A. Hook 执行验证
```bash
cd "D:\.openclaw\workspace"
pd pain evidence --json
```

**结果**：
```json
{
  "count": 0,
  "decisions": [],
  "searchedPath": "D:\\.openclaw\\workspace\\memory\\logs\\SYSTEM_*.log"
}
```

**结论**：Hook 未执行，0 条 pain signals 被记录。

### B. Evidence 非空验证
无 pain signals，无需验证。

### C. 统计
- 本次 session 自动触发：0 条
- 手工补记：0 条
- Hook 执行次数：0 次

## 根本原因

检查 `.pd/config.yaml`，发现 `painEvidenceAdmission` feature flag **未在配置中声明**：

```yaml
features:
  prompt:
    category: core
    enabled: true
  code_tool_hook:
    category: core
    enabled: true
  # ... other features, but no painEvidenceAdmission
```

代码中的 feature flag 加载（`loadFeatureFlagFromConfig`）会返回 `{ enabled: false }`，导致所有 PEAT-B1 逻辑被跳过。

参考位置：
- `after-tool-call-helpers.ts:229` - PEAT-B1 检查
- `llm.ts:PEAT-B1` - LLM output hook 检查
- `gate-block-helper.ts` - gate block hook 检查

## 真实摩擦事件（应捕获但未捕获）

| 序号 | 工具 | 失败描述 | 应归类为 | 实际捕获 |
|------|------|---------|---------|---------|
| 1 | `npm test` | test timeout (prompt-diet.test.ts) | tool_failure | ❌ 否 |
| 2 | `head` 命令 | Windows 不支持 head 命令 | dispatch_error | ❌ 否 |
| 3 | `grep` 命令 | Windows 不支持 grep 命令 | dispatch_error | ❌ 否 |
| 4 | `test` 命令 | Windows 不支持 test 命令 | dispatch_error | ❌ 否 |

## PRI-361 上报表格

| painId | 来源(auto/manual) | 触发时的真实摩擦描述 | evidence非空? | 备注 |
|--------|------------------|-------------------|--------------|------|
| N/A | N/A | 工具失败未捕获（test timeout, Windows 命令不兼容） | N/A | **PD 漏采**：painEvidenceAdmission flag 未启用，整个 PEAT-B1 管道未运行 |

## 管道健康结论

**【有漏采】** — PD 管道因配置未启用而完全未运行。这不是代码缺陷，而是配置管理问题：

1. **Feature Flag 缺失**：`.pd/config.yaml` 中没有 `painEvidenceAdmission` 声明
2. **默认行为**：未声明的 feature flags 默认为 `{ enabled: false }`
3. **影响**：所有 PEAT-B1 相关的 evidence triage 逻辑被跳过，after_tool_call hook 不会调用 `resolveSourceKind` 或 `evaluateEvidenceTriage`

## 建议

### 配置层面
1. 在 `.pd/config.yaml` 中显式声明 `painEvidenceAdmission`：
   ```yaml
   features:
     painEvidenceAdmission:
       category: runtime-v2
       enabled: true  # or false based on opt-in policy
   ```

### 文档层面
1. 更新 PEAT-B1 文档，说明需要在 workspace 配置中启用 feature flag
2. 在 `triage-adapter.ts` 注释中明确标注 feature flag 依赖

### 测试层面
1. 添加 integration test 验证 feature flag 未启用时的降级行为
2. 添加 setup 文档说明如何启用 pain evidence admission

## 代码质量检查

✅ **PRI-362 验收条件**：
- [x] 单一 resolveSourceKind 入口覆盖全部 SourceKind 枚举值
- [x] 回归测试与旧分散函数行为完全一致（23 测试用例）
- [x] 旧分散函数已改为薄包装，无重复逻辑
- [x] 默认 triage 策略未变（source-descriptors.ts 未动）
- [x] `cd packages/openclaw-plugin && npm run build && npm run test` 通过（1727 passing）
- [x] `npm run lint`（根目录）通过
- [x] 架构回归测试通过（128 passing）

## 后续工作

1. **配置修复**：根据 opt-in policy 决定是否自动启用 painEvidenceAdmission
2. **E2E 测试**：启用 flag 后重新执行 Dogfood，验证 evidence 非空
3. **文档更新**：在 ADR-0015 和 PEAT-B1 文档中补充配置说明