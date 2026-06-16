# PRI-407 Quality Dogfood — 评分汇总

## 疑点调查结果

### 1. `generatedAt` 硬编码日期来源

**结论：LLM 回显 prompt 示例日期，非代码 bug。**

- 所有 prompt builder（dreamer/philosopher/scribe）的示例输出中包含固定日期 `"2026-05-11T12:00:00.000Z"`（dreamer/philosopher/scribe）或 `"2025-04-10T15:30:00.000Z"`（早期版本）
- LLM 直接复制了示例中的日期，而非生成当前时间戳
- 代码层面 `generatedAt` 是由 LLM 输出的字段，非系统注入
- **修复建议**：在 prompt 中移除示例日期，改为指令"使用当前 ISO-8601 时间戳"，或在代码层面用 `new Date().toISOString()` 覆盖 LLM 输出

### 2. `sourcePrincipleId: "pri-unknown"` 来源

**结论：LLM 自行编造占位值，代码中无 "pri-unknown" 字符串。**

- 全代码库搜索 `"pri-unknown"` 无匹配
- `sourcePrincipleId` 是 dreamer 输出中的可选字段，由 LLM 生成
- 实际观察到的值包括：`"pri-unknown"`、`"pri-000"`、`"pri-001"`、`"pri-042"`、`"pri-999"`、`"pri-missing-diagnosis"`、`""`（空字符串）
- 这些值全部是 LLM 编造的，与实际核心原则 ID（T-01..T-10）无关
- **根因**：prompt 示例中展示了 `"sourcePrincipleId":"pri-042"`，LLM 模仿此格式编造值
- **修复建议**：在 prompt 中明确说明"如果无法确定来源原则，请省略此字段而非填入占位值"，或在代码层面过滤无效值

---

## 评分表

每条产出评估维度（1-5 分）：

| 维度 | 说明 |
|------|------|
| 贴合度 | 原则是否真的对应输入痛点（非泛化、非自指） |
| 可执行性 | 规则是否具体到 agent 下次能照做 |
| Grounding | 是否引用了真实诊断证据（contextRefs 是否被实际使用） |
| 独特性 | 多条 pain 是否产出同质化模板 |

---

### dogfood-01: 删除有副作用代码（code_tool_hook）

**Pain**: AI助手在重构代码时删除了有副作用的清理逻辑

**Scribe 产出原则**: "快速失败并生成诊断占位符"

| 维度 | 评分 | 说明 |
|------|------|------|
| 贴合度 | /5 | （owner 填写） |
| 可执行性 | /5 | |
| Grounding | /5 | |
| 独特性 | /5 | |

**备注**: dreamer 收到 null predecessor output，导致产出与原始 pain 脱钩

---

### dogfood-02: 模糊指令下未澄清就修改核心配置（prompt）

**Pain**: AI助手在收到模糊指令后直接修改核心配置文件

**Scribe 产出原则**: "前置上下文追溯原则"

| 维度 | 评分 | 说明 |
|------|------|------|
| 贴合度 | /5 | （owner 填写） |
| 可执行性 | /5 | |
| Grounding | /5 | |
| 独特性 | /5 | |

**备注**: 原则内容偏向"多步骤流水线中追溯前驱输出"，与原始 pain（模糊指令应主动澄清）有偏移

---

### dogfood-03: 误判监控埋点为调试代码建议归档（defer_archive）

**Pain**: AI助手将监控埋点误判为调试代码建议归档

**Scribe 产出原则**: "使用异常处理和回退机制的故障安全执行"

| 维度 | 评分 | 说明 |
|------|------|------|
| 贴合度 | /5 | （owner 填写） |
| 可执行性 | /5 | |
| Grounding | /5 | |
| 独特性 | /5 | |

**备注**: 产出原则与原始 pain（区分调试代码与监控代码）严重脱钩，dreamer 输出 badDecision 为"Ignored exception handling"

---

### dogfood-04: 机械复制错误处理模式忽略语义差异（code_tool_hook）

**Pain**: AI助手机械复制错误处理模式，忽略语义差异

**Scribe 产出原则**: "处理前验证输入"

| 维度 | 评分 | 说明 |
|------|------|------|
| 贴合度 | /5 | （owner 填写） |
| 可执行性 | /5 | |
| Grounding | /5 | |
| 独特性 | /5 | |

**备注**: 产出原则与原始 pain（模式复用需语义验证）脱钩，dreamer 输出 badDecision 为"Did not validate input"

---

### dogfood-05: 忽略系统提示词引入冗余依赖（prompt）

**Pain**: AI助手忽略系统提示词引入冗余依赖

**Scribe 产出原则**: "先诊断后决策"

| 维度 | 评分 | 说明 |
|------|------|------|
| 贴合度 | /5 | （owner 填写） |
| 可执行性 | /5 | |
| Grounding | /5 | |
| 独特性 | /5 | |

**备注**: 产出原则与原始 pain（优先使用已有依赖）脱钩，dreamer 输出 badDecision 为"Proceeded without reviewing predecessor diagnosis"

---

### dogfood-06: 以已知威胁模型评判防御性代码为冗余（defer_archive）

**Pain**: AI助手以已知威胁模型评判防御性代码为冗余

**Scribe 产出原则**: "前驱诊断依赖原则"

| 维度 | 评分 | 说明 |
|------|------|------|
| 贴合度 | /5 | （owner 填写） |
| 可执行性 | /5 | |
| Grounding | /5 | |
| 独特性 | /5 | |

**备注**: 产出原则与原始 pain（防御性代码不应以已知威胁模型评判）脱钩，dreamer 输出偏向"pipeline integrity"

---

### dogfood-07: 违反显式安全规范自行判断信任边界（code_tool_hook）

**Pain**: AI助手违反显式安全规范自行判断信任边界

**Scribe 产出原则**: "验证用户输入是否为空或未定义"

| 维度 | 评分 | 说明 |
|------|------|------|
| 贴合度 | /5 | （owner 填写） |
| 可执行性 | /5 | |
| Grounding | /5 | |
| 独特性 | /5 | |

**备注**: 产出原则与原始 pain（遵守显式安全规范）脱钩，dreamer 输出偏向"null check on user input"

---

## 汇总统计

| ID | Channel | 贴合度 | 可执行性 | Grounding | 独特性 | 平均 |
|----|---------|--------|----------|-----------|--------|------|
| dogfood-01 | code_tool_hook | | | | | |
| dogfood-02 | prompt | | | | | |
| dogfood-03 | defer_archive | | | | | |
| dogfood-04 | code_tool_hook | | | | | |
| dogfood-05 | prompt | | | | | |
| dogfood-06 | defer_archive | | | | | |
| dogfood-07 | code_tool_hook | | | | | |
| **平均** | | | | | | |

## 结论

**质量是否达到种子发布门槛**: YES / NO

（owner 填写）

### 若不达标，根因分析

- [ ] Prompt 质量：dreamer prompt 未有效传递诊断证据，导致产出与原始 pain 脱钩
- [ ] Grounding 未用诊断证据：dreamer 收到 null predecessor output，无法基于诊断产出
- [ ] 模型能力：SenseNova deepseek-v4-flash 在理解中文 pain 语义后生成贴合原则的能力不足
- [ ] 其他：______

### 后续工单建议

（根据根因分析填写）
