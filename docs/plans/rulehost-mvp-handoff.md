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
| `3efe09bf` | Phase 5b | PRI-426 | `EvaluatorRunner.succeedTask` 单轮对抗沙盒重放 + `gateDeps` 注入 + PRI-423 positive case 合并契约 + 遥测注册 | 8 新 |

**累计 87 测试,零功能回归。** Linear: PRI-421/422/423/424/425/426 全部 In Review。

## 3. 待完成 Phase

| Phase | 工单 | 内容 | 依赖 |
|-------|------|------|------|
| **Phase 6** | **PRI-427** | Rule Artifact Assembly in `succeedTask`(双 artifact 写入 + `updateValidationStatus('validated')`) | PRI-426 ✅ |
| Phase 7 | PRI-428 | Orchestrator 多轮对抗循环(最多 2 轮)+ 降级路径 + 集成测试 | PRI-427 |
| Phase 8 | PRI-428 | 架构回归测试 + 全套测试 | PRI-428 |

## 4. 关键设计契约(context 压缩后必读)

### 4.1 PRI-423 设计偏差(owner 2026-06-17 确认接受) — 已在 PRI-426 实现

`adversarialCasesToGoldenTrace()` 的输出**故意不通过 `validateGoldenTrace()`**(没有 positive case)。对抗用例全是 negative expectation,合成假 positive 会让对抗 replay 失真。**调用方(PRI-426 的 succeedTask)负责在 replay 前把对抗 trace 与 Artificer golden trace 的 positive case 合并。**

**PRI-426 实现状态(commit `3efe09bf`)已遵守**:succeedTask 的 `runAdversarialReplay()` 调 `extractPositiveCases()` 从 Artificer `goldenTraceCases` 取 `kind='positive'` 的 case,与对抗 trace 合并后再调 `evaluateRefinerRuleHostGate`。被 `evaluator-runner-vslice-v2.test.ts` 的 "PRI-423 contract" 测试显式断言。

契约留痕位置:
1. PRD Decision 11d 步骤 e(commit `3dfbbd7b`)
2. `adversarial-case.ts` 文件头注释
3. `adversarial-case.test.ts` 显式断言
4. **`evaluator-runner.ts` 的 `runAdversarialReplay` 注释 + `extractPositiveCases` 实现(PRI-426)**

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

## 5. PRI-427(下一步)实施要点

**范围**:Rule Artifact Assembly — 在 `EvaluatorRunner.succeedTask()` 里基于 PRI-426 已填的 `adversarialResult` 写 rule artifact。

**succeedTask 当前结构**(evaluator-runner.ts,搜 `async succeedTask`):
1. lineage 检查
2. `updateRunOutput`
3. `resolveLineageArtifactIds`
4. 写 principle artifact(`artifactKind: 'principle'`)— 现有行为
5. **PRI-426 新增**:V2 输出 + gateDeps → `runAdversarialReplay()` 填 `adversarialResult`,re-persist artifact(commit `3efe09bf`)
6. **如果 decision === 'approved'**:调 `resolvePrincipleBearerArtifact` + `updateValidationStatus('validated')` — 现有行为
7. `markTaskSucceeded`

**PRI-427 要加的**(在步骤 5 之后,合并进/扩展步骤 6):
- 仅当 `isEvaluatorOutputV2(output)` 且 `adversarialResult.passed === true` 时:
  - 从 Artificer artifact 提取 `implementationCode` + `goldenTraceCases` + `affectedTools`(用 PRI-426 已有的 `parseArtificerArtifact`)
  - 组装 rule artifact contentJson: `{ implementationCode, goldenTrace, goldenTraceCases, affectedTools, ruleHostGateDecision: 'accepted_shadow', sourceArtificerArtifactId }`(参考 `RuleHostWriter.canActivate` 期望的字段 — `rule-host-writer.ts:38-77`)
  - `artifactKind: 'rule'` 写入(新 artifactId,与 principle artifact 分开)
  - `updateValidationStatus('validated')` 在 rule artifact 上(不是 principle artifact)
- `adversarialResult.passed === false` → 不写 rule artifact(principle artifact 仍在,走 prompt 通道降级)

**关键契约**:
- rule artifact 的字段必须与 `RuleHostWriter.canActivate()` 的读取契约对齐(否则 Phase 7/8 的激活链断裂)。读 `rule-host-writer.ts:80-130` 确认字段名(`implementationCode` / `goldenTrace` / `ruleHostGateDecision` / `affectedTools`)。
- `gateDeps` 注入路径已就绪(PRI-426),PRI-427 复用。

**测试**:扩展 `evaluator-runner-vslice-v2.test.ts`。覆盖:
- adversarialResult.passed=true → rule artifact 写入 + validationStatus='validated'
- adversarialResult.passed=false → 不写 rule artifact,principle artifact 仍 pending
- rule artifact contentJson 通过 `RuleHostWriter.canActivate` 的解析(集成测试)
- V1 输出 → 不写 rule artifact

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

### 预先存在的测试失败(不是回归,不要修)
- `pruning-read-model.test.ts`:2 个日期相关失败(date-based),baseline `f0c73391` 上就有
- `attack-e2e-pipeline-smoke.test.ts`:6 个 diagnostician 超时(5000ms),baseline 上就有
- 两者都通过 git stash 验证过与 RuleHost 工作无关

## 7. 工单状态(截至本快照)

| 工单 | 标题 | 状态 |
|------|------|------|
| PRI-421 | ArtificerOutputV2 + EvaluatorOutputV2 Schema/Validator | In Review |
| PRI-422 | buildGoldenTraceFromArtificer 辅助函数 | In Review |
| PRI-423 | AdversarialCase 类型 + GoldenTrace 转换 | In Review |
| PRI-424 | Artificer L2 Write-Test-Fix 循环 | In Review(+ lesson-learned 标签) |
| PRI-425 | Evaluator Passive Review(代码审查三维度) | In Review |
| PRI-426 | Evaluator Adversarial Attack + Sandbox Replay | In Review |
| PRI-427 | Rule Artifact Assembly(双 artifact 写入) | **Backlog(下一步)** |
| PRI-428 | 多轮对抗循环 Orchestrator + 降级路径 + 架构回归测试 | Backlog |

## 8. 恢复后的第一步

1. 读本文件 + `docs/plans/rulehost-mvp-activation.md`(PRD)
2. `git log --oneline feat/rulehost-mvp-activation` 确认 commit 历史(应到 `3efe09bf`)
3. 读 `packages/principles-core/src/runtime-v2/activation/writers/rule-host-writer.ts` 的 `canActivate`(rule artifact 字段契约)
4. 读 `packages/principles-core/src/runtime-v2/internalization/evaluator-runner.ts` 的 `runAdversarialReplay`(PRI-426 已实现的提取逻辑可复用)
5. 按 §5 实施 PRI-427
