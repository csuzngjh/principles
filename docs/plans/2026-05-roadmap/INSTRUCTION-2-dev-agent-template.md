# INSTRUCTION-2: Dev Agent Template

> Agent workflow instructions for coding tasks on Principles Disciple.
> Applies to all AI agents (Claude Code, Codex CLI, Symphony workers).

---

## 通用开发任务模板

使用本模板执行所有编码任务。按顺序执行每一步。

### Step 1: Error Handbook Gate (必须执行)

1. 阅读 `docs/ERROR_EXPERIENCE_HANDBOOK.md` 全文
2. 列出与当前任务相关的 ERR 条目（至少 3 条，引用具体编号）
3. 在实施计划中写明：当前 PR 如何避免每个相关 ERR 的重复发生
4. 如果任务是修复 bug：注明当前 bug 与哪个已知 ERR 属于同一类

```
示例：
关联 ERR：ERR-001（as 绕过运行时校验）、ERR-009（校验器静默跳过）、ERR-013（in 运算符匹配原型链）
避免策略：
- JSON 解析结果使用 typeof 校验，不使用 as 断言
- 必填字段校验使用 if (!valid) { error } 模式，而非 if (valid) { ok }
- 不可信对象的 key 检查使用 Object.hasOwn()
```

### Step 2: Runtime Contract Rules (实施前阅读)

实施过程中必须遵守以下 9 条运行时合约规则。每条规则对应 Error Handbook 中的一类实际错误：

| # | 规则 | 关键点 | 参考 ERR |
|---|------|--------|----------|
| 1 | 解析后的 JSON / LLM 输出 / DB `diagnosticJson` / 构件元数据一律视为 `unknown` | 不可用 `any`，必须先运行时校验 | ERR-001 |
| 2 | 禁止使用 `as` 绕过运行时校验 | 用 `typeof`、`Array.isArray()` 等类型守卫进行运行时验证 | ERR-001, ERR-005 |
| 3 | 必填字段缺失或格式错误必须"大声失败"（生成 error 记录） | 用 `if (!valid) { error }`，不用 `if (valid) { skip }` | ERR-009, ERR-010 |
| 4 | 数组元素类型必须逐一校验 | 对未知数组做 `filter(isString)` 或 `forEach` 逐元素检查 | ERR-005, ERR-007 |
| 5 | 不可信对象使用 `Object.hasOwn()` 而非 `in` 运算符 | `in` 会匹配原型链属性（toString, constructor 等） | ERR-013 |
| 6 | Lineage 和 evidence 字段必须来自同一数据源，并有 mismatch 测试 | sourceTaskId/sourceRunIds/sourcePainId 必须一致 | ERR-004, ERR-008 |
| 7 | 重试/修复循环必须区分当前状态、下一轮状态和已记录状态 | 每轮开始时获取当前错误，结束时更新记录，记录用本轮数据 | ERR-015, ERR-018, ERR-019 |
| 8 | Preview 和 telemetry 路径必须限长，使用安全的序列化方法 | 使用 `safeStringifyPreview`，禁止裸 `JSON.stringify` | ERR-014, ERR-016, ERR-017 |
| 9 | Graceful degradation 必须附带降级原因（structured error / notes / telemetry / logs） | 静默降级 = bug，降级必须有 observability | ERR-002 |

### Step 3: 实施

1. 阅读 CLAUDE.md 和 AGENTS.md 中的项目架构和边界规则
2. 阅读相关源文件（不可盲目 grep）
3. 按 TDD 流程实施：先写测试（RED），再写实现（GREEN），最后重构（IMPROVE）
4. 每次逻辑变更后运行相关测试
5. Runtime Contract Rules 中的 9 条规则在代码审查时逐条核对

### Step 4: PR Pre-Review Gate (提交/完成前执行)

提交代码、创建 PR 或通知完成前，必须执行以下检查清单：

```
□ 一次性对抗性自审（首次 handoff 前）
  - 对照当前 issue 的 Acceptance Criteria 审查整个 diff
  - 对照适用的 Runtime Contract Rules / CLI Operator Gate 逐条核查
  - 将当前 scope 内全部 P0/P1/P2 一次性修复后再请求外部评审
  - scope 外的改进只记录 follow-up issue，不混入当前 PR

□ 获取所有 PR 评论和审查意见（若有现有 PR）
  - gh pr view <PR> --json comments,reviews,latestReviews,files,statusCheckRollup
  - gh api repos/:owner/:repo/pulls/<PR>/comments --paginate
  - gh api repos/:owner/:repo/issues/<PR>/comments --paginate
  - 重试至少 2 次，API 超时不跳过
  - 确认真实人工评论与自动化评论的区别
  - 首轮评审：处理全部当前 scope 内 P0/P1/P2 发现项
  - 修复后复核：仅核验已列 blocker 与修复修改产生的回归面，不重新扩大审计范围
  - 每个已处理的评论注明修复方式
  - scope 外/非阻塞建议在 PR body 中说明并转 follow-up issue，不拖延当前合并

□ 检查差异文件范围
  - gh pr diff <PR> --name-only（或 git diff origin/main --name-only）
  - 确认没有无关文件被修改
  - 确认没有基于过时 main 分支导致的合入代码回滚

□ 运行测试
  - 迭代修复期间：仅运行与改动直接相关的 targeted tests + 必要 build/typecheck
  - 最终 handoff 前：npm run verify:merge（如果存在）
  - 只有当前 diff 触及对应 package/跨包 contract，或 merge gate 要求时，再运行完整 package tests
  - 不因 scope 外观察项扩展当前 PR 的测试矩阵和代码范围

□ 最终总结
  - 相关 ERR 条目清单及避免方式
  - PR 评论已处理的总结（fixed / deferred-follow-up / duplicate / misunderstanding）
  - 测试运行结果
  - 剩余风险说明

□ Error Recording Gate
  - 如果本次工作中发现了真正的 bug（通过代码审查或自我审查）：
    - 按 root cause 分组；同一根因只记录一次，不按评论数量重复记录
    - 从未有过的新错误类 → 在 Error Handbook 中创建新 ERR 条目
    - 已有条目的重复 → 更新该条目的 Recurrence 字段
    - 在 Linear issue 上添加 lesson-learned 标签
    - 在 PR body 中说明 handbook 更新
```

### Step 5: Merge-Blocking Boundary (强制收敛)

当前 PR 的合并阻塞范围固定如下：

| 等级 | 是否阻塞当前 PR | 处理方式 |
|------|----------------|----------|
| P0 数据破坏、安全问题、架构边界破坏 | 是 | 当前 PR 修复 |
| P1 生产链路错误、错误状态写入、lineage 污染、operator safety 违规 | 是 | 当前 PR 修复 |
| P2 违反当前 Linear issue 明确验收标准 | 是 | 当前 PR 修复 |
| P2 但超出当前 issue scope 的增强/硬化 | 否 | 创建 follow-up issue |
| P3、风格、可选优化、旁支重构 | 否 | 评论记录或 follow-up |

外部 reviewer 首轮可全面审查一次。修复提交后的 reviewer 只确认上述 blocker 被关闭以及修复本身没有引入 P0/P1 回归；不得把邻近改进不断追加到当前 PR。

---

## Symphony 自动调度版

Symphony 调度的工作流按以下步骤执行。

### 阶段 1: 任务启动

```
1. 用 get_issue 读取 Linear issue（含所有评论）
2. 读取 AGENTS.md 和 CLAUDE.md（项目规则）
3. 读取 docs/ERROR_EXPERIENCE_HANDBOOK.md 全文
```

### 阶段 2: Error Handbook Gate

```
4. 列出当前任务相关的 ERR 条目（至少 3 条）：
   - 引用编号和标题
   - 每条的逻辑是"当前任务可能会犯这个错误，因为……"
5. 在实施计划中写明每个关联 ERR 如何避免
6. 如果任务包含 bug 修复，标注该 bug 属于哪个已知 ERR 类别
```

### 阶段 3: Runtime Contract 检查

```
7. 在实施前通读 9 条 Runtime Contract Rules
8. 实施过程中每条规则标注为 checked 或 not applicable
9. 代码审查时逐条核对
```

### 阶段 4: 实施

```
10. 读取相关源文件，理解架构
11. 按 TDD 流程实施
12. 每次修改后运行测试
```

### 阶段 5: PR Pre-Review Gate

```
13. 执行 PR Pre-Review 检查清单：
    □ 首次 handoff 前完成一次全 diff 对抗性自审，并一次修复当前 scope 内 P0/P1/P2
    □ 获取并处理所有 PR 评论
    □ 检查差异文件范围（无无关文件、无回滚）
    □ 迭代运行 targeted tests；最终运行 merge gate
    □ 编写最终总结（ERR 清单、评论处理、测试结果、剩余风险）
14. 如果发现真正 bug，执行 Error Recording：
    □ 按 root cause 分组，新建 ERR 或更新现有条目一次
    □ 添加 lesson-learned 标签
    □ 在 PR body 中说明
15. Reviewer 修复轮次规则：
    □ 首轮 review 允许全面检查
    □ 修复后只核验既有 blockers 及修复回归面
    □ scope 外建议建 follow-up，不追加到当前 PR
```

### 阶段 6: 完成

```
16. 写 .symphony/agent-completion.json
17. 状态设为 ready_for_review
18. 不手动创建 PR，不手动变更 issue 状态 — Symphony 会自动处理
```
