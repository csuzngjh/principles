# RuleHost MVP Activation — 实施 Handoff 文档

> **用途**:本文件是 `feat/rulehost-mvp-activation` 分支的实施状态快照,供 context 压缩后恢复使用。开工前必读本文件 + PRD(`docs/plans/rulehost-mvp-activation.md`)+ ADR-0014 末尾的 Amendment (2026-06-17)。

## 1. 任务总览

实现 PRD `docs/plans/rulehost-mvp-activation.md`(RuleHost MVP 可用化:从文本原则到可执行约束)。PRD 拆成 8 个 Phase,对应 Linear 工单 PRI-421~428。

- **分支**:`feat/rulehost-mvp-activation`(从 main 创建)
- **未推送**(尚未创建 PR,等 Phase 7-8 完成后统一开)
- **ADR 授权**:ADR-0014 末尾 `Amendment (2026-06-17): Owner Exception — RuleHost MVP Activation`,owner PD 2026-06-17 批准。

## 2. 已完成 Phase(按提交顺序)

| Commit | Phase | 工单 | 内容 | 测试 |
|--------|-------|------|------|------|
| `452fbd5c` | ADR + Phase 1 | PRI-421 | ADR Amendment + ArtificerOutputV2/EvaluatorOutputV2 schema + validator + `isArtificerOutputV2`/`isEvaluatorOutputV2` type guard | 34 新 |
| `aa815cf9` | Phase 2 | PRI-422 | `buildGoldenTraceFromArtificer()` in golden-trace.ts | 12 新 |
| `841b1db3` | Phase 3 | PRI-423 | `adversarialCasesToGoldenTrace()` in adversarial-case.ts | 10 新 |
| `62e9a275` | Phase 4 | PRI-424 | `ArtificerL2Adapter`(write-test-fix 循环)in adapter/artificer-l2-adapter.ts | 12 新 |
| `c396ed92` | Phase 4 review 修复 | PRI-424 | P1(phantom status field)+ P2(降级信任未验证候选)+ telemetry | +2 回归 |
| `bd709ad9` | ERR-069 | — | ERR-069 记录(Category 3)+ EP-01/EP-02 更新 | — |
| `9a5b99dd` | Phase 5a | PRI-425 | Evaluator prompt builder V2 code review 指令 + buildContext scribe artifact 加载(PRD Decision 12)+ invokeRuntime 透传 | 9 新 |

**累计 79 测试,零功能回归。** Linear: PRI-421/422/423/424/425 全部 In Review。

## 3. 待完成 Phase

| Phase | 工单 | 内容 | 依赖 |
|-------|------|------|------|
| **Phase 5b** | **PRI-426** | Adversarial 生成 prompt + 单轮 sandbox replay in `succeedTask`(PRD Decision 11d 单轮) | PRI-425 ✅ |
| Phase 6 | PRI-427 | Rule Artifact Assembly in `succeedTask`(双 artifact 写入 + `updateValidationStatus('validated')`) | PRI-426 |
| Phase 7 | PRI-428 | Orchestrator 多轮对抗循环(最多 2 轮)+ 降级路径 + 集成测试 | PRI-427 |
| Phase 8 | PRI-428 | 架构回归测试 + 全套测试 | PRI-428 |

## 4. 关键设计契约(context 压缩后必读)

### 4.1 PRI-423 设计偏差(owner 2026-06-17 确认接受)

`adversarialCasesToGoldenTrace()` 的输出**故意不通过 `validateGoldenTrace()`**(没有 positive case)。对抗用例全是 negative expectation,合成假 positive 会让对抗 replay 失真。**调用方(PRI-426 的 succeedTask)负责在 replay 前把对抗 trace 与 Artificer golden trace 的 positive case 合并。**

这条契约在三个地方留痕:
1. PRD Decision 11d 步骤 e(commit `3dfbbd7b`)
2. `adversarial-case.ts` 文件头注释
3. `adversarial-case.test.ts` 显式断言

**PRI-426 实现时必须遵守**:succeedTask 里用 `adversarialCasesToGoldenTrace` 转换后,要从 Artificer V2 输出的 `goldenTraceCases` 里取 positive case 合并进去,才能调 `evaluateRefinerRuleHostGate`。

### 4.2 ERR-069 教训(Phase 4 review 发现)

两个 bug,P1 + P2,commit `c396ed92` 修复:
- **P1**:`runHandle` 凭记忆加了 `status:'sourced'` 字段,但 `RunHandleSchema` 根本没这个字段(只有 runId/runtimeKind/startedAt),被 `as RunHandle` 掩盖。**教训:写 adapter 返回对象时,从 Typebox schema 逐字复制字段名,不凭记忆。**
- **P2**:降级路径信任了 validator 拒绝的候选。**教训:每个 output-emitting 路径(happy/degraded/fallback/exhausted)都只能输出通过验证的对象,降级是内容变换不是信任逃生口。**

ERR-069 已记录在 `docs/ERROR_EXPERIENCE_HANDBOOK.md` Category 3,EP-01/EP-02 卡片已更新。

### 4.3 执行模型约束(Phase 4/5 反复确认)

`BasePeerRunner.run()` 是严格线性:`lease → buildContext → invokeRuntime → poll → fetch → validate → succeedTask`。
- **`succeedTask` 在 `invokeRuntime` 返回 final output 之后执行,不能回头重试 LLM。**
- **单轮对抗检查(sandbox replay)在 `succeedTask` 内部**(纯函数,零 LLM 成本)。
- **多轮对抗循环(跨 runner 的 Artificer 重试)在 orchestrator 层**(Phase 7),不在 succeedTask。
- **Artificer L2 的 write-test-fix 循环在 `ArtificerL2Adapter`(Phase 4),不在 runner。**

### 4.4 枚举映射(PRD Decision 1)

- `GoldenTraceDecision`(测试期望)= `'allow' | 'block' | 'propose_correction'`
- `RuleHostDecision`(evaluate() 运行时)= `'allow' | 'block' | 'requireApproval' | 'auto_correct'`
- sandbox replay 比较逻辑(`refiner-sandbox-wrapper.ts:129-187`)映射:`block` 接受 `block` 或 `requireApproval`;`propose_correction` 接受 `auto_correct`(需带 correctionProposal)。

## 5. PRI-426(下一步)实施要点

**范围**:evaluator-runner.ts 的 `succeedTask` 扩展 + adversarial prompt(Part B,已在 PRI-425 的 instruction 里加好了)。

**succeedTask 当前结构**(evaluator-runner.ts,行号会变,搜 `async succeedTask`):
1. lineage 检查
2. `updateRunOutput`
3. `resolveLineageArtifactIds`
4. 写 principle artifact(`artifactKind: 'principle'`,现有行为)
5. **如果 decision === 'approved'**:调 `resolvePrincipleBearerArtifact` + `updateValidationStatus('validated')`(现有行为)
6. `markTaskSucceeded`

**PRI-426 要加的**(在步骤 5 之后或合并进去):
- 用 `isEvaluatorOutputV2(output)` 判断是否 V2 输出
- V2 且 `codeReview` 存在 → 检查 passive review 三维度:
  - 任一不通过(intentConsistency.aligned=false / scopePrecision.verdict≠precise / traceCoverage.sufficient=false)→ **不写 rule artifact,decision 已是 needs_revision**(LLM 按 instruction 输出)
- V2 且 passive review 通过 + `adversarialCases` 存在:
  - `adversarialCasesToGoldenTrace(output.adversarialCases)` → 对抗 trace(全 negative,见 4.1)
  - **合并 positive case**(从 Artificer V2 的 goldenTraceCases 取 kind='positive' 的)
  - `evaluateRefinerRuleHostGate(code, mergedTrace, gateDeps)` 单轮 replay
  - 通过 → approved(写 rule artifact 是 Phase 6 的事,PRI-426 先填 `adversarialResult`)
  - 失败 → 填 `adversarialResult.failedCases`,decision 保持 needs_revision

**关键**:PRI-426 需要 `gateDeps: RefinerRuleHostGateDeps` 注入到 EvaluatorRunner(当前没有)。参考 `RuleHostWriter` 怎么拿 gateDeps(`rule-host-writer.ts:73`)。

**测试**:mock LLM(已在 PRI-425 用 EvaluatorPromptBuilder 测),真实 `evaluateRefinerRuleHostGate` + 可控 gateDeps。覆盖 4 类攻击(boundary/omission/inversion)+ 短路 + 合并 positive。

## 6. 环境与命令

- **工作目录**:`D:\Code\principles`
- **OS**:Windows,cmd.exe(无 `head`/`tail`/`wc`,用 node 替代)
- **构建**:`cd packages/principles-core && npm run build && npm run test`
- **lint**:`npm run lint`(lefthook pre-commit 自动跑)
- **Linear CLI**:`node C:\Users\Administrator\.agents\skills\linear-cli\scripts\linear.cjs <command>`
- **error handbook 校验**:`npm run check:error-handbook`(当前 69 entries)

### Windows 注意事项
- 没有 `head`/`tail`/`wc`/`grep`,用 `rg` + `node -e`
- linter 会频繁改文件导致 Edit 的 mtime 检查失败 → 用临时 `.cjs` 脚本做批量替换更稳
- 提交时过滤 lefthook 噪音:`git commit ... 2>&1 | findstr /V "lefthook repo-hygiene ┃ └ ├ ─ │ ╭ ╰"`

## 7. 工单状态(截至本快照)

| 工单 | 标题 | 状态 |
|------|------|------|
| PRI-421 | ArtificerOutputV2 + EvaluatorOutputV2 Schema/Validator | In Review |
| PRI-422 | buildGoldenTraceFromArtificer 辅助函数 | In Review |
| PRI-423 | AdversarialCase 类型 + GoldenTrace 转换 | In Review |
| PRI-424 | Artificer L2 Write-Test-Fix 循环 | In Review(+ lesson-learned 标签) |
| PRI-425 | Evaluator Passive Review(代码审查三维度) | In Review |
| PRI-426 | Evaluator Adversarial Attack + Sandbox Replay | **In Progress**(下一步) |
| PRI-427 | Rule Artifact Assembly(双 artifact 写入) | Backlog |
| PRI-428 | 多轮对抗循环 Orchestrator + 降级路径 + 架构回归测试 | Backlog |

## 8. 恢复后的第一步

1. 读本文件 + `docs/plans/rulehost-mvp-activation.md`(PRD)
2. `git log --oneline feat/rulehost-mvp-activation` 确认 commit 历史
3. 读 `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts` 的 `succeedTask` 现状
4. 按 §5 实施 PRI-426
