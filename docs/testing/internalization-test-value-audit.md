# PD Internalization 测试价值审计 + Diag Runner 收敛条件调查（Test Diet Phase 2.2-B）

> 日期：2026-09-22 · 基线 commit：`4072eee7`（#1823 已并后）· 性质：**只读审计**，零代码/测试/fixture/CI 改动，未创建 PR
> 前序：#1813 / #1817 / #1820 / #1823；本报告承接 `internalization-test-consolidation-report.md`（#1823 已带入 main）
> 原则：**测试数量不是目标，测试信号密度才是目标。不删除系统记忆，只删除重复噪音。**

---

# Executive Summary

**1) 当前 Internalization 测试规模**：3 个区域合计 **85 个测试文件 / ~1,258 个 it 定义**——
`internalization/__tests__/` 75 文件 / 1,105 it（含 #1823 新增契约套件）；`internalization/` 根目录错位测试 4 文件 / 37 it；`diagnostician/__tests__/` 6 文件 / 116 it。vi.mock 使用为零（全 DI 注入），vi.fn 密度集中在 diag 家族（最高 42/文件）。

**2) 最大重复区域**：① diag runner 三文件同模板族（12 个 it 表达同一骨架行为 ×3 份拷贝，2.2-A 已画矩阵）；② **常量回声族**（`MVP_CORE_TASK_KINDS` / consumer-runner-kinds / `ALLOWED_EDGES` 表在 `queue-actionability`、`c2-live-runner-chain`、`internalization-consumer-decision`、`internalization-job-graph`、`runnerkind-seam` 五个文件里互相 echo 同一导出表——impl 与测试引用同一常量，断言无信息量）；③ `internalization-consumer-decision` 文件内 boundary describe（11 it）重复其自身 base describe。

**3) 最大低价值区域**：`runnerkind-seam.test.ts`（29 it 中 ~17 个是导出表/守卫回声与 flag 存在性钉）与 `evaluator-prompt-builder-v2.test.ts` 的 5 个"富输入构造后被丢弃、只断言静态常量"的 it；另有一个孤儿快照与一个自指 tautology。

**4) 最大风险区域**（非删除风险，是覆盖盲区风险）：① diag runner 测试把 `_validator.validate` stub 成恒 valid（router 除外）——runner 层"畸形 LLM 输出被 schema 拒绝"的防线在 A/B 段是假的（真实防线在 `diagnostician-output-schema`/`diag-*-output` 的 TypeBox 测试）；② 测试 fixture `split-pipeline-mock-outputs.ts` 被生产代码 `adapter/test-double-runtime-adapter.ts` 反向引用（测试资产泄漏进生产依赖方向）；③ `PassThroughDreamerValidator`（@deprecated test-only）经 barrel re-export 存活，无区域消费者。

---

# Coverage Map

```
Pain / Diagnosis 入口          （本审计范围外，见 Phase 2-A 治理报告；保护强）
        │
Diagnosis 产物层               diagnostician/__tests__ 6 文件/116 it
  ├ schema/validator 矩阵      diag-rootcause-output(39)·diag-distiller-output(9)·intent-tension-schema(39)  ████ 强（真实 TypeBox）
  └ prompt 构造                rootcause(21)/distiller(4)/router(4) + 孤儿 snapshot                                    ███░ 中强（含措辞类噪音）
        │
Internalization 编排           internalization/__tests__ 75 文件/1,105 it + 根目录 4 文件/37 it
  ├ Owner 审批/激活安全          mvp-core-loop-journeys·restart-safety·owner-*·verdict-drift·activation 接线        ████ 极强（真实 SQLite，零 mock）
  ├ 契约/工件链                  rule-activation-contract·evaluator-gate-authority·chain-integrity·crash-liveness    ████ 强
  ├ prompt 契约                 peer-prompt-builder-contract(64)+6 builder 文件+语言指令                              ████ 强（#1823 后噪音已清）
  ├ retry/生命周期               internalization-task-guards·split-retry·task-three-strikes·状态机                     ████ 强（#1823 后已参数化）
  ├ 常量/接缝回声                runnerkind-seam(29)·queue-actionability 部分·consumer-decision boundary·job-graph 派生·c2 尾部  █░ 弱（本审计 main 低价值源）
  └ 错位文件                    internalization/ 根目录 4 文件（lifecycle-*/deprecated-readiness）                      ███ 中（行为真实，位置错）
        │
Principle 产物                 adversarial-case·artificer-rule-output·evaluator-output-v2·scribe/rollout 契约        ████ 强
        │
Activation                     （activation/ 目录，见 Phase 2-A；本审计零触碰）                                        ████ 强
```

---

# 测试价值分类总表（按 A/B/C/D/E 分级；#1823 已收敛家族不再列）

> A=Core Contract（必须保留）· B=Regression（保留+记录来源）· C=Behavior（评估保留）· D=Implementation Detail（LOW VALUE，REVIEW）· E=Duplicate

| File | it | 分级 | 依据（一句话） |
|---|---|---|---|
| mvp-core-loop-journeys / restart-safety.e2e / verdict-drift-regressions | 21/10/14 | **A** | PRI-811 审批门、崩溃重启、终态防漂移（真实 SQLite） |
| owner-decision(-review/-architecture/-override-resume) | 59+ | **A** | 深度 CAS/幂等/单一 resolver 守卫 |
| evaluator-gate-authority / rule-activation-contract / crash-liveness / a-liveness-reconciliation | — | **A** | 沙箱门权威、工件契约反漂移、崩溃窗口 |
| evaluator-artificer-repair-replay / evaluator-chinese-feedback / evaluator-formation-context / evaluator-pain-reason-echo | — | **A/B** | 真实重放门自愈（PRI-634）、中文反馈（PRI-714）、形成证据（PRI-843）、Pain 回显（PRI-861） |
| prompt-serializer | 11 | **A** | DAG-vs-环/有界序列化是真实不变量 |
| adversarial-case / behavior-example-pack / artificer-rule-output / evaluator-output-v2 / refiner-* / tool-semantic-registry / formation-context | — | **A/B** | 验证器边界与对抗输入，行为真实 |
| peer-prompt-language | 25 | **A/B** | 输出语言契约（PRI-336/630），与 builder 文件无重复（grep 核验） |
| diag-rootcause-output(39) / diag-distiller-output(9) / intent-tension-schema(39) | 87 | **A** | schema/validator 真实 TypeBox 矩阵——全区域最硬的 schema 防线 |
| diag-router-runner / diag-rootcause-runner / diag-distiller-runner | 38 | **B + E**（12 同模板） | 见 Diag Runner 专节 |
| split-diagnostician-runner-retry | 16 | **B**（ERR-067 钉）+ PRI-818 缓存族 A | #1823 已参数化 Stage 三连 |
| rootcause-prompt-builder | 21 | **B** + 措辞类 D 尾 | 字节级门是 EP-03 回归正主；phase 序号 its 是装饰性 |
| distiller-prompt-builder | 4 | **B** | schema keys + 伪造守卫，全保 |
| router-prompt-builder | 4 | **B/D 各半** | schema keys 保；"包含 principle/rule/prompt 等通用词"断言近乎同义反复 |
| internalization-consumer-decision | 19 | **C + E 文件内**（boundary describe ×11 重复 base） | SUT 是 3 分支 + Math.min |
| queue-actionability | 11 | **B 核心 + D 尾**（6 个 actionable-true 回声 + 常量钉） | PRI-253 回归核心保 |
| c2-live-runner-chain | 10 | **A 主体 + E/D 尾**（3 个常量钉 it 与两文件逐字重复） | L286-502 真实 SQLite 链是强 A |
| internalization-job-graph | 27 | **B + D**（successors/predecessors 派生 its echo 自家 ALLOWED_EDGES 钉） | isAcyclic/validateEdge 保 |
| runnerkind-seam | 29 | **D 主体**（~17 回声）+ B 尾（INF-4 不相交、decideArtifactRejectionFeedback 升级回归） | PRI-370 时代接缝钉 |
| evaluator-prompt-builder-v2 | 10 | **D ×5**（富输入→弃输出→只断静态常量）+ B（passthrough/V1 兼容） | PRI-421..428 单次提交后零改动 |
| intent-tension-cases.test | 13 | **D** | fixture 自校验；schema 接受/拒绝与 intent-tension-schema.test 重复；fixture 唯一消费者是它自己 |
| rule-context-v2 | 57 | **A + 1 自指 tautology**（`expect(cases).toHaveLength(20)` 断言自己的数据数组） | 20 个映射 its 是 SPEC §4.4 契约钉 |
| internalization/ 根目录 4 文件（lifecycle-metrics/read-model/routing-policy/deprecated-readiness） | 37 | **C/B**，行为真实、互不重复；"deprecated" 指原则弃用**特性**而非死代码 | 仅目录错位（在 src/ 而非 __tests__/） |
| internalization-transition-decision | 21 | **B** | mock 调用检查有持久化契约背书，非裸 call-order |

---

# Duplicate Matrix（#1823 未覆盖的重复组）

| Test A | Test B | Same Behavior | Recommendation |
|---|---|---|---|
| queue-actionability.test.ts:113-125 | c2-live-runner-chain.test.ts:522-530 | MVP_CORE_TASK_KINDS 常量内容钉（逐字） | 删一处，留一处（随 B1） |
| internalization-consumer-decision.test.ts:86-88,279,288 | c2-live-runner-chain.test.ts:534-546 | consumer-runner-kinds 常量钉 | 同上 |
| internalization-consumer-decision.test.ts describe#2 (L93-297) | 同文件 describe#1 (L9-88) | 同一输入类边界 ×11 it | 文件内合并到 ~6 it |
| internalization-job-graph.test.ts:125-172 | 其自身 ALLOWED_EDGES 钉 (L11-21)；另与 c2-live-runner-chain:439-502 拓扑重叠 | 由同一导出表派生的 successors/predecessors echo | 派生 its 改为对表驱动 or 删；跨文件 edge 矩阵合并候选 |
| intent-tension-cases.test.ts schema its | diagnostician/intent-tension-schema.test.ts | 接受/拒绝矩阵 | 保留 schema 正主；fixture 测试缩为数据集形状冻结 1-2 it |
| rootcause-prompt-builder L197-204 vs L258-266 | 同文件 | flag 条件注入 presence 断言近乎重复 | 留 buildPrompt 边界版（生产边界），删 instruction 级重复 |
| runnerkind-seam INF-8 | pitask-metadata round-trip its | 元数据往返 | 删 runnerkind-seam 侧 |

---

# Delete Candidates（逐项含考古；实施需走 Phase 2.2-B1 + Owner 确认）

| # | File / Cases | Reason | Replacement | Origin（git 考古） | Risk |
|---|---|---|---|---|---|
| 1 | `diagnostician/__tests__/__snapshots__/diagnostician-prompt-builder.test.ts.snap`（122 行孤儿快照） | 消费者测试文件已在 PRI-372 拆分时代删除；全仓零 `toMatchSnapshot` 引用 | 无需——纯死工件 | 生于 #762（PRI-283，2026-05-31），末次触碰 #876（PRI-352）；拆分遗留 | **极低** |
| 2 | `runnerkind-seam.test.ts` 内 ~17 个回声 it（INF-1/2/3、INF-7/8、flag 存在性钉） | 断言实现从同一导出表派生的字面量——信号密度≈0 | 导出表本身 + architecture-regression 桶面守卫 | PRI-370 #901（2026-06-11 拆管线接缝）+ PRI-378 #910 | 低（保留 INF-4 不相交 + decideArtifactRejectionFeedback 升级回归两个 it） |
| 3 | `internalization-consumer-decision.test.ts` boundary describe ~11 it + 负输入"known edge case" it（把缺陷固化为文档且无工单挂钩） | 与同文件 base describe 同输入类重复 | base describe（PRI-381 回归核心） | PRI-381 #914（**bug fix**：ready dreamer 卡 pending）——核心 its 是 B 类必保 | 低 |
| 4 | `evaluator-prompt-builder-v2.test.ts` L58-94 五个静态钉 it | 富输入构造后弃用输出、只断导出常量字符串；输入可证明无关（首个 it 根本不用返回值） | `evaluator-prompt-builder.test.ts` + `peer-prompt-language` 已钉同一常量内容 | PRI-421..428 #963（2026-06-18）单次提交后零改动——时代烟测 | 低 |
| 5 | `queue-actionability` 6 个 actionable-true 回声 it + 常量钉 | 传入 `new Set(MVP_CORE_TASK_KINDS)` 再断言 true——echo 同一导出表 | L48-110 真实 rolloutExcludedPolicy/诊断 payload 断言 | PRI-253 #722（bug fix 核心）+ PRI-419 修订 | 低 |
| 6 | `c2-live-runner-chain` L506-546 三个常量钉 it | 与上述两文件逐字重复 | 同上 | PRI-457 #1039（pinning test）+ PRI-720 | 低 |
| 7 | `rule-context-v2.test.ts:84-88` 自指 tautology（数据数组长度断言） | 断言测试自己的 fixture 而非 SUT | 同文件 20 个映射契约 its | PRI-480 #1089 单提交 | 极低 |
| 8 | `intent-tension-cases.test.ts` 13 it 缩为 1-2 it（数据集形状冻结） | fixture 自校验 + 与 intent-tension-schema 正主重复；fixture 唯一消费者是它自己 | intent-tension-schema.test（39 it 正主） | PRI-468 #1063 单提交 | 低（留数据集形状冻结防 fixture 腐化） |
| 9 | `router-prompt-builder.test.ts:55-63` 通用词 presence 断言 | "instruction 包含 prompt/principle 等词"近乎同义反复 | schema keys it（同文件保留） | PRI-372 拆分产物 | 极低 |

**REVIEW（不删，标注）**：rootcause-prompt-builder phase 序号 its 与 SPEC §17 散文钉（字节级门已覆盖 EP-03 回归，序号属装饰性——留待 Owner 品味裁决）；`mainline-product-path` 3 个 it.todo（既有文档化债务，Phase 2-A 已挂账）。

---

# Diag Runner Recommendation（核心问题：能否进入下一轮收敛）

## Setup 重复度：高（~90% 同构）
三维 harness 同构（10-fn stateManager、8-fn runtimeAdapter、相同 runner options、共享 `split-pipeline-mock-outputs` fixtures）；差异仅在角色组合：router=committer+真实 TypeBox、rootcause=validator+contextAssembler+0 依赖、distiller=validator+1 依赖、前置工件填充深度不同。

## Assertion 重复度：38 it 中 12 个为跨文件同模板（3× phase-Completed、3× phase-Failed、3× wrong-taskKind、2× taskId 再注入对、2× artifact 写失败、3× EP-01 前驱损坏变体）。

## Failure Injection 一致性：**不一致——这是禁止直接合并的原因**
| 注入类型 | 层级 | 现状 |
|---|---|---|
| schema failure（router） | **真实 TypeBox 管线** | router 的"validation failure"走生产校验路径 |
| validator failure（A/B） | 注入 validator mock（恒 valid stub，失败场景显式 mockRejected） | A/B 的同名"validation failure"走 mock 注入 |
| storage failure | store 注入（'Disk full'） | 三文件一致 |
| runtime failure | pollRun failed | 一致 |

→ 同名测试在 router 与 A/B 实际命中的**验证层不同**：直接 `it.each` 合并会要么把 router 拉低到 mock（删掉唯一的真实 schema 路径证明），要么把 A/B 拉高到真实 validator（改变 A/B 测试的对象）。

## 结论：**B. 先抽取 test harness，再参数化**（不选 A 直接参数化 / 不选 C 保持现状）
- A（直接参数化）被 failure-injection 不对称否决——会静默改变覆盖层。
- C（保持现状）代价持续存在：12 个同模板 it 的任何骨架改动（如 PeerRunnerResult 字段演进）需三处同步。
- B 的具体路径（供 Phase 2.2-B2 实施）：① `createMockDeps(stage)` 角色组合工厂（committer/validator/contextAssembler/前置工件深度作参数，router 保持真实 TypeBox 校验注入）；② 12 个同模板 its 折入 `it.each` over `{runnerClass, taskId, requiredDepCount, failureInjector, validatorMode:'real'|'mock'}`；③ PRI 钉（PRI-667、PRI-442 Bug-B-005、EP-07 血缘遥测）保持 stage 文件原位；④ 错误类不对称（`max_attempts_exceeded` vs `input_invalid`）作为显式 case 字段，不得拉平。预计 −120~150 行、−8~9 个重复测试体，执行断言数不降。

---

# Mock Risk Report（Internalization Mock Risk Appendix）

> 区域 vi.mock 使用 = **0**（全 DI 注入）；vi.fn 密度 top：diag-chain-e2e 42、philosopher-runner-trust-boundary 26、diag-rootcause-runner 25、diag-distiller-runner 24、split-retry 23、diag-*-intent-tension 21-23、diag-router-runner 21。

| Mock | 分类 | 隐藏的真实行为 | 兜底 | 风险 |
|---|---|---|---|---|
| diag-rootcause/distiller runner 的 `_validator.validate` 恒 valid stub | **Risky（validator）** | runner 层对畸形 LLM 输出的 schema 拒绝→重试/修复环是假的 | `diag-rootcause-output`(39)/`diag-distiller-output`(9)/`diagnostician-output-schema` 真实 TypeBox 测试 | **高**（防线错位；2.2-B3 应改真实 validator） |
| `split-pipeline-mock-outputs.ts` 被生产 `adapter/test-double-runtime-adapter.ts` import | **Risky（依赖方向）** | 测试 fixture 成为生产依赖——fixture 变更会破坏生产 test-double 路径 | ——（结构性异味，记录待治理） | 中 |
| `PassThroughDreamerValidator` @deprecated test-only 导出经 barrel 存活 | **Risky（死导出）** | 无区域消费者；防误用仅靠 architecture-regression 负向守卫 | 该负向守卫本身 | 低（barrel 面治理候选） |
| diag-chain-e2e / split-retry 的脚本化 LLM adapter（42/23 个 vi.fn） | Safe（external API seam） | 仅 LLM I/O；state machine/stores 全真实 | real-llm 套件（env 门控） | 低（既定设计） |
| 各文件 makeMockStateManager/makeMockCommitter（接口忠实的内存实现） | Safe→Risky 边界 | SQLite 序列化/FK/触发器行为 | c2-live-runner-chain、diag-chain-e2e、mvp-core-loop-journeys 真实 SQLite 层 | 中（分层兜底已存在） |
| retry-policy mock（shouldRetry/calculateBackoff 旋钮） | Safe（policy 注入点） | 真实退避数学 | internalization-task-guards 边界矩阵（纯函数层） | 低 |
| rootcause prompt 的 SPEC §17 散文钉 / phase 序号钉 | N/A（非 mock，文本耦合） | 措辞变更即红 | —— | 低（装饰性断言，REVIEW） |

---

# Recommended Implementation Plan（建议，不实施）

**Phase 2.2-B1 —— 低风险删除（一个 PR，预计 −150~200 行 / −40 it，全部有替代）**
1. 删孤儿快照（Delete #1）；
2. runnerkind-seam 收缩至 ~5 it（保 INF-4 + 升级回归；Delete #2）；
3. internalization-consumer-decision boundary describe 文件内合并 + 删无工单挂钩的缺陷固化 it（Delete #3）；
4. evaluator-prompt-builder-v2 五个静态钉删除（Delete #4）；
5. 常量钉三处去重（Delete #5/#6）+ rule-context-v2 自指 it（#7）+ intent-tension-cases 缩为形状冻结（#8）+ router 通用词断言（#9）。
验证：触及文件 before/after 用例表 + core 全套 + verify:merge；每项在 PR 中引用本报告考古行。

**Phase 2.2-B2 —— Diag runner harness（一个独立 PR，按上文 B 方案）**
createMockDeps 角色工厂 → 12 同模板 it 折入 it.each → PRI 钉原位 → 真实 TypeBox 注入模式作为 router 显性契约保留。

**Phase 2.2-B3 —— Mock realism（独立治理，勿与 B1/B2 混车）**
1. diag A/B runner 改用真实 Default validator（split-pipeline fixtures 本可过真 schema）；
2. `split-pipeline-mock-outputs` 的生产反向引用搬移（fixture 归测试、生产 test-double 自带字面量）；
3. `PassThroughDreamerValidator` barrel 退休决策（与 #1820 的 Gate A 退休同类，Owner 裁决）；
4. rootcause 散文/序号钉的 Owner 品味裁决（保字节级门、删装饰性 its）。

---

# 完成标准回执

- **报告路径**：`docs/testing/internalization-test-value-audit.md`（本文件，untracked，未创建 PR、未修改任何代码/测试/fixture/CI）
- **测试资产统计**：85 文件 / ~1,258 it（internalization/__tests__ 75/1,105 + 根目录错位 4/37 + diagnostician 6/116）；vi.mock=0，vi.fn 峰值 42
- **删除候选**：9 项（1 孤儿快照 + ~40 个低信号 it），全部含 origin 考古与替代保护
- **参数化候选**：diag runner 12 同模板 it（方案 B 先 harness）；consumer-decision 文件内 11 it；job-graph 派生 echo
- **保留理由**：A/B 类主体（审批门/工件链/schema 矩阵/重试语义）全部原位，PRI 钉 100% 保留
- **下一步**：2.2-B1（低风险删除）→ 2.2-B2（diag harness）→ 2.2-B3（mock realism），见实施计划
