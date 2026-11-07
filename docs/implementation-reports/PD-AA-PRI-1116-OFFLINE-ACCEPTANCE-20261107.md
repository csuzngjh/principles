# PRI-1116 · C01–C09 离线验收增量（2026-11-07）

状态：`OFFLINE ACCEPTANCE ROUND`。

本轮不启动宿主、不调用模型、不写生产库、不清理数据、不安装、不发布、不合并 PR。
证据基线：`86b6208042b6083d4a7bbf840730d060188a1517`（最新 `origin/main`）。
工作树：`D:\Code\_worktrees\principles\PRI-1116-offline-acceptance`，分支 `ai/PRI-1116-offline-acceptance`。

## 1. 结论（先看这里）

1. **C08 的评分区分能力已在组件层实测确认**：行动、最终结果、不必要代价三列可区分；证据缺失保持 `unknown`，自述与 receipt 不会被当作证据。但这是判分逻辑，不是真实行为改善。
2. **机会分母 T 仍为 `unknown`**：现有获准材料不足以形成范围明确、可复核的离线机会清单；本轮不补造机会，不用调用数/运行数/事后错误充当 T。
3. **C04/G1 仍是唯一硬缺口**：原始正例在 gate 层失败、没有对照组、端点用户消息哈希与冻结输入不一致、请求级关联为 `unknown`。这些事实全部保留，不重开已完成接线。
4. **本轮实际运行 166 个离线测试，0 failed / 0 skipped**：C01/C03/C05/C06/C07 相关组件 111 个、C08 相关 21 个、受控准入 34 个。
5. 本轮最高证据层级为 **L2 跨模块回归**；L3 受控宿主观察、L4 完整实验、L5 行为效果均未运行。

## 2. 证据层级（不可互相替代）

| 层级 | 定义 | 本轮是否取得 |
| --- | --- | --- |
| L1 组件测试 | 单模块/夹具级确定性测试 | 是（C08、受控准入） |
| L2 跨模块回归 | 真实本地入口/共享入口/读模型的集成测试 | 是（C01/C03/C05/C06/C07） |
| L3 受控宿主观察 | 隔离宿主中一次正例的真实请求/回调观察 | 否（NOT_RUN） |
| L4 完整实验 | 正例 + 对照，按预注册协议 | 否（NOT_RUN） |
| L5 行为效果 | 真实任务中的行为改变 | 否（NOT_RUN） |

任何 L1/L2 结果都不能替代 L3/L4/L5，也不能写成「C08 通过」「G1 通过」。

## 3. 本轮实测摘要

| 命令 | 覆盖 | 结果 | 层级 |
| --- | --- | --- | --- |
| `npx vitest run scripts/__tests__/principle-learning-lab-challenge-v2.test.ts` | C08 离线评分校准 | 21 passed / 0 failed / 0 skipped | L1 |
| `npx vitest run scripts/__tests__/aa-controlled-admission.test.mjs` | 受控准入夹具/预算/编号 | 34 passed / 0 failed / 0 skipped | L1（夹具） |
| `npx vitest run packages/principles-core/src/runtime/activation/__tests__/adaptive-principle-intervention.test.ts packages/host-runtime/tests/adaptive-behavior-linkage.test.ts packages/openclaw-plugin/tests/hooks/runtime-prompt-activation.test.ts` | C01/C03/C05/C06/C07 组件与跨模块 | 111 passed / 0 failed / 0 skipped | L2 |

合计：**166 passed / 0 failed / 0 skipped**。

## 4. C01–C09 本轮增量矩阵

「既有证据」来自 `docs/implementation-reports/PD-AA-C01-C09-ACCEPTANCE-MATRIX-20261106.md`（PR #2386 分支产物，未合并）；本文不复制其全文，只记录本轮增量与当前 HEAD 的路径漂移。

| ID | 原始验收要求（摘要） | 实现入口 | 既有精确证据（测试名 / commit） | 本轮实测 | 本轮结论 | 剩余缺口 | 负责 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | 只选配置的有效目标；正常任务走 Native；不凭关键词或回调推定风险 | `adaptive-activation-config.ts`、core `adaptive-principle-intervention.ts`、plugin `index.ts` | plugin `does not interpret a quoted scene marker as operator admission`；`preserves Native when identity unavailable`（@`440aa6354`）；core `never triggers from missing message identity or quoted/history marker`（@`3e81b1115`）；config 2 项（@`7c84f20f1`） | 111 套件内通过（plugin 66 + core 15） | 组件级 PASS | 隔离宿主一次正例命中未运行 | PRI-1118 |
| C02 | 不把旧正文带入目标请求；不改治理记录；拒绝/回退原因可追溯 | `host-runtime/src/adaptive-principle-revalidation.ts`、plugin `prompt.ts`、Runtime Reader | `removes a shared target whose artifact changes between selection and final commit`（@`440aa6354`）；`adaptive-principle-revalidation.test.ts` 6 项（@`4a7c584dd`） | 未单独复跑专用重验套件；plugin 66 中相关路径通过 | 部分复核 | 选择后提交前撤销在隔离宿主中的一次回退观察 | PRI-1118 |
| C03 | 已有内容只出现一次；不可安全装配时无增量；不挤掉必需约束 | `host-runtime/src/active-principle-prompt.ts`、core packer、plugin 最终预算 | `adaptive-principle-priority-prompt.test.ts` 6 项（@`3e81b1115`）；`prompt-size-guard.test.ts`（@`0d47c7de3`） | core 15 通过；大小守卫未单独复跑 | 部分复核 | 真实宿主最终 payload 的独立比对（归 C04） | PRI-1118 / C04 |
| C04 | 独立比对同一请求正文、配置身份和行动顺序；后者只取 returned，缺证保持未知 | `verify-adaptive-delivery.mjs`、`probe-local-transport.mjs`、`prompt.ts` 返回边界 | `verify-adaptive-delivery.test.mjs`（夹具）；历史探针 1 次本地 HTTP、宿主回调未出现 | 受控准入 34 通过（夹具/模拟） | **L3 NOT_RUN** | 一次真实隔离宿主正例，由假 provider 记录 `endpointRequestId/bodySha256/userMessageSha256`，并明确 `requestAssociation=unknown` | PRI-1118 |
| C05 | 不补记为及时；能通过任务产物抽查漏触发机会；T 不完整只报可观测部分 | `host-runtime/src/adaptive-behavior-linkage.ts`、EventLog 读模型 | `adaptive-behavior-linkage.test.ts`（@`fda71df92`）；读模型覆盖率行为 | 30 passed | 组件/读模型 PASS | G2 真实任务抽样；完整 T/V/O/D 仍未知 | PRI-1119 / G2 |
| C06 | 无跨界、无重复投递、无虚构合并；请求不能借用旧确认；配置变化后旧成功不作数 | `adaptive-behavior-linkage.ts`、`adaptive_delivery` journal、`adaptive-config-identity.test.mjs` | `adaptive-journal-reconciliation.test.ts`（@`440aa6354`）；linkage 跨 session/配置 A→B/requestId 借用 | 30 + 66 通过 | 组件级 PASS | 隔离宿主重放/并发/超时未运行；一次性准入在 #2396 仍修复中 | PRI-1118 / PRI-1115 |
| C07 | 增量失败不阻塞正常任务；无独立证据不伪造成功/阻塞；撤映射后 Native 可用 | core `prepareAdaptiveIntervention`、plugin `prompt.ts` 停用路径 | core intervention 第 1/4/6/7 项（@`3e81b1115`）；`restores the native prompt after mapping is disabled between selection and final commit`；`production-host-runtime.test.ts`（@`679f6833a`） | 111 套件内通过 | 组件级 PASS | 宿主侧依赖失败/软截止未注入 | PRI-1118 |
| C08 | Examiner 能区分行动、最终结果和不必要代价；证据缺失不以自述/receipt 补齐 | Examiner v0.10.1、`examiner-v2-cases.mjs`、用例草案 @`ed761d631` | `calibrates {correct, known-failure-wrong-object, surface-compliance-task-failed, over-execution, legal-alternative, unsupported-certainty} without a model` 等 10 项 | 21 passed；8 个 fixture 完成 reviewer assessment | **组件级 PASS（仅判分）** | 真实案例要等 G2/G3；3 处判据分歧待裁决 | PRI-1116 / Examiner |
| C09 | 只在批准范围/期限运行；不自动开 Shadow/Live；不外发到未授权目的地 | `adaptive-activation-config.ts`、`index.ts` 默认关闭、设计 §4 隔离边界 | config 2 项（@`7c84f20f1`）；`abstraction_layer_v1` 默认关闭 | plugin 66 含默认关闭/停用路径；配置专测未单独复跑 | 部分复核 | 宿主模式切换与外发审计未运行 | PRI-1118（环境边界） |

路径漂移说明：矩阵中的 `runtime-v2/...` 在当前 HEAD 已由 `d36724c60`（PRI-1136，#2391）改名为 `runtime/...`，测试文件名 `runtime-v2-prompt-activation.test.ts` 现为 `runtime-prompt-activation.test.ts`。语义未变；以现行路径为准。

## 5. A. C08 已知案例验证（摘要）

详见 `PD-AA-C08-KNOWN-CASE-REVIEW-20261107.md`。

- 三类可区分：符合原则（F-01、F-05）、无效或有害遵循（F-02、F-03、F-04、F-06、F-07）、证据未知（F-08）。
- 全部案例标 `fixture`；分类判断标 `reviewer assessment`；不包装成真实行为改善。
- 需要裁决的分歧集中列出，不阻塞其余项：
  - **D-C08-1**：C08 的「无效/有害遵循」能否合并成一个标签（会掩盖「结果是否真的更差」）。
  - **D-C08-2**：「诚实的证据未知」与「证据不足却断言成功」是否共用同一标签。
  - **D-C08-3**：不必要代价是否单独构成「无效遵循」（`over-execution` 的结果仍为 PASS）。
- 关键限制：离线判分逻辑可区分，但生产路径的独立请求证据来源尚未建立（用例草案 §5 已记录），因此不能据此宣称 C08 全部满足。

## 6. B. 机会分母可得性

问题：已有获准材料是否足以形成范围明确、可复核的离线样本清单（T）？

**结论：不足以形成。T 保持 `unknown`。**

本轮只读检查的材料：

| 材料 | 能提供什么 | 为什么不能形成 T |
| --- | --- | --- |
| `docs/plans/2026-11-04-PRI-1115-AA10-expected-values.md` | 纸面期望值与聚合口径 | 夹具/期望值，不是事前机会清单 |
| `PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md` | 一次受控窗口的读模型观察 | 单一隔离运行，不是独立工作窗口；无任务/产物清单 |
| `PD-AA-v0.6-IMPLEMENTATION-STATUS.md` | 组件完成状态 | 组件状态不等于机会分母 |
| `PD-AA-PRI-1116-NEXT-STAGE-20261106.md` | 已知证据与缺口 | 不包含逐条机会记录 |
| 仓库内 `aa-run-*` 运行记录/端点原始捕获 | 未找到 | 无版本化原始记录，无法离线复核逐条机会 |

因此：

- 不建立 census 系统，不新增采集，不新增宿主/模型调用。
- 不以 hook 调用数、运行数、工具调用数或事后错误数充当 T。
- 不为了得到数字补造机会。
- 只有未来出现「独立任务/产物清单 + 明确观察窗口 + 事前字段 + 稳定机会键」时，才可能形成可复核的 T；当前记录为 `unknown`。
- 该未知不阻断 C01/C02/C03/C06/C07/C09 的组件结论，也不阻断 C04 的接线完成状态；它阻断的是覆盖率/分母类结论。

## 7. C. C04 / G1 剩余边界

保留的事实（全部来自 `PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md` 与 `PD-AA-PRI-1116-NEXT-STAGE-20261106.md`）：

1. 原始正例在它自己的 gate 层**失败**，判定保留，不因后续离线复核而改写。
2. **没有对照组**，因此不能形成配对实验结论。
3. 端点投影的用户消息哈希**不等于**冻结输入哈希；不得声称用户输入按字节一致送达。
4. 已确认的窄观察：受控准入被消费；目标 directive 正文在本地假 provider 被观察到；一次成功 `read` 属于该 run。
5. 请求级关联、遵循、改善仍为 `unknown`。
6. 审计者用原始 run record 离线重算 `evaluatePositiveGate`，13 项通过；这是**派生离线结果**，不是真实请求。
7. 原始审计 JSON 只在本地产物目录，未进入仓库；仓库内无法复核其原始文件哈希。

还缺什么证据、影响哪个结论：

| 缺口 | 需要的证据 | 影响的结论 | 是否需新运行授权 |
| --- | --- | --- | --- |
| E1 真实正例 | 隔离宿主一次真实 `before_prompt_build`，假 provider 记录端点请求 | C04 正例、L3 | 是 |
| E2 对照 | 同一协议下 Native 对照回合 | L4、G1 配对结论 | 是 |
| E3 输入一致性 | 端点用户消息与冻结输入同哈希，或明确接受不可比 | 「同一请求正文」结论 | 是（重跑或改协议） |
| E4 请求级关联 | 宿主可证明的 request identity；否则保持 `unknown` | C04 的 confirmed/timely | 不一定；当前设计预期为 `unknown` |

边界：

- 不重开已完成的接线，不因缺对照而否定组件证据。
- 不自动动用剩余实验额度；历史 stop 仍然有效。
- 不把整份 C01–C09 离线整理说成需要新运行授权：C01/C02/C03/C05/C06/C07/C08/C09 的大部分离线工作可继续；只有 E1/E2/E3 需要新运行授权。

## 8. 与其它 PR 的依赖与合并顺序

1. **PR #2386（PRI-1118 设计/验收矩阵）**：本文引用其矩阵小节。建议合并顺序 #2386 → 本 PR；若本 PR 先合并，矩阵引用保留为跨 PR 指针，不复制其正文。本文不含 #2386 的代码。
2. **PR #2396（PRI-1115 覆盖率报告）**：另一个会话正在修复 `matchingInvocation` 身份矛盾分支；本轮的 B 节结论不依赖该修复，也不引用其未合并报告作为事实。本 PR 不夹带其代码。若后续引用其覆盖报告，合并顺序应为 #2396 → 引用方。
3. **历史提交/文件**：保留 `PD-AA-PRI-1116-NEXT-STAGE-20261106.md`、`PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md` 与既有 aa-handoff 检查点，不覆盖他人指针。

## 9. 剩余事项分类

### 9.1 可继续离线完成

- C02 专用重验套件与 C03 大小守卫、C09 配置边界在当前 HEAD 的复跑与结果归档。
- 把 C08 的 8 个 fixture 按裁决后的 rubric 生成正式核对表（当前已完成 reviewer assessment，待裁决后可定稿）。
- 为 E3 设计「输入不可比时如何上报」的离线判据（不重跑）。

### 9.2 需要判据裁决

- D-C08-1、D-C08-2、D-C08-3（见 C08 核对文件 §4）。
- C08 合并标签是否可用于正式验收结论。

### 9.3 确需新运行授权

- E1 隔离宿主正例、E2 对照、E3 输入一致性复跑。
- G2 真实任务抽样（C05 的完整 T/V/O/D）与 G3 行为效果。

## 10. 下一张可执行工单

**PRI-1119 / G2 事前样本清单预注册（仅定义，不采集）**

- 产出：一页 preregistration，冻结机会分母的纳入/排除条件、观察窗口、事前字段、稳定机会键与 `unknown` 处理规则。
- 不包含：采集代码、census 系统、宿主回合、模型请求。
- 依赖：Owner 对 D-C08-1…3 的裁决；G2 启动授权。
- 完成标准：Owner 能据此判断「哪些机会算 T、哪些不算」，且无需修改 SPEC。

在裁决前，可立即执行的是 §9.1 的离线复跑与归档，不依赖新授权。

## 11. 本轮边界

- 宿主回合 0 / HTTP 0 / 工具调用 0 / 付费调用 0。
- 未写生产库，未清理数据，未安装，未发布。
- 未修改 PRI-1115 工作树、分支或文件；未合并任何 PR。
- 未新增评价平台、census 系统或采集路径。
