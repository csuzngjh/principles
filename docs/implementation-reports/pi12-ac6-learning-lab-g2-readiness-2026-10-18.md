# Pi 1.2 AC-6 真实验收 + Principle Learning Lab G2 接线 — 交付报告

- 日期：2026-10-18
- 工作树：`D:\Code\_worktrees\principles\PRI12-G2-pi12-ac6-g2-actor`（分支 `ai/PRI12-G2-pi12-ac6-g2-actor`，基于 `origin/main` f2539e07e；原指定工作树 `PRI12-PHASE3-pi12-phase3-ac6-preflight` 已随 PR#2075 合并清理，按任务规则从最新主干新建）
- 任务模式：一次性目标执行，零中途交互

## 0. 结论速览

| 交付项 | 状态 |
|---|---|
| **AC-6（真实模型验收）** | **`BLOCKED_COST_GUARD`** — 未发起任何真实请求（0 次 HTTP、$0 花费）。官方计费规则不可核实 + B1 场景无请求级输出 token 上界，最坏费用 $1.38 > $0.80 门限 |
| **Learning Lab G2（真实 Actor 接线）** | **`READY`**（工程就绪：接线、离线演练、预注册草案全部交付并通过测试；真实运行仅待 Owner 决策 OD-1..OD-3，见 §5） |
| **G1 回归** | gate **PASS**，校准电池 **14/14**，fixture 健康检查 PASS，prereg 草案校验 PASS |
| **真实请求数 / 费用** | **0 次 / $0**（全程零真实模型调用；Learning Lab 演练全部为确定性 Fake Transport，零网络） |
| **冻结数据集** | **未修改**（13 个冻结文件 git diff 为空；fixtureHash `4c3ea4ab29ce…` 不变；仅更新了不在哈希范围内的 `preregistration.json` 与 `pilot-run-config.json`） |
| **生产治理状态** | **未触碰**（无 Principle/Approval/Activation/RuleCode 写入；lab 产物只写 `.tmp/`；`frozenCandidate.principleId` 恒 null，NT-06） |

**纪律声明：本报告中的全部"通过"均为离线 Mock 演练与既有离线门禁的通过。Mock 通过、G1 通过、AC-6 阻塞、真实 G2 未执行——这四件事都不构成"真实原则学习已得到验证"的证据。真实学习主张在 OD 授权的真实运行前保持 NOT_ESTIMABLE。**

---

## 1. 阶段 A：AC-6 费用预检 → BLOCKED_COST_GUARD

### 1.1 预检事实（全部零费用取得）

**测试与请求上限（代码核实）**：

| 场景 | 测试文件 | 请求硬上限 | 重试/回退语义 | 请求级输出 token 上限 |
|---|---|---|---|---|
| B3 One-shot json_schema | `pi12-ac6-oneshot-real-llm.test.ts` | 3 | `maxRetries: 0` + `maxRepairAttempts: 0` | **1024**（显式） |
| B1 Dreamer L2 submit_output | `pi12-ac6-dreamer-real-llm.test.ts` | 3 | `maxEmptyRetries: 0` + `l2FallbackToL1: false` + `maxTurns: 5` | **无**（见下） |
| B2 Artificer L2 全链路 | `pi12-ac6-artificer-real-llm.test.ts` | 6 | 无 L1 fallback（PRI-439 设计）+ `maxTurns: 8` | **4096**（显式） |

- 请求计数封顶是**严密**的：三个适配器的出站 HTTP 全部经过共享传输层 `pi-ai-http-transport.ts` 的 `getPiAiFetchForApi`，测试 harness 在该层包裹并在发送第 N+1 个请求**之前**抛错（fail-loud）。SDK 内部重试也走同一 fetch，因此 3/3/6 = 最坏 12 次请求的上界在传输层成立，与上层任何重试机制无关。
- 解锁门：`LLM_E2E_ENABLED` 未设置（本任务即授权，此项不构成阻塞）；`SENSENOVA_API_KEY` 存在（只验证存在性，值未打印、未写入任何文件）。

**B1 关键缺陷（本次预检实锤）**：Dreamer 的 `loopConfig` 不传 `maxTokens`。pi-ai 回退到 `model.maxTokens`，而 `resolveL2Model('sensenova','deepseek-v4-flash', baseUrl)` 经 catalog-first 借用了 **opencode-go** 命名空间下同一模型名的条目（实测探测结果：`maxTokens: 384000, contextWindow: 1000000, reasoning: true, thinkingFormat: deepseek`）。即 wire 上 `max_tokens ≈ 384,000`——这是一个**其他中转商的模型元数据**，不是 SenseNova 的官方约束。最坏输出：3 × 384,000 = 1,152,000 tokens。

**官方计费核实（2026-10-18 实时抓取）**：

- `sensecore.cn` 官方帮助中心定价页（按量后付费权威页）**不含 deepseek-v4-flash**——该模型在官方定价体系中**无官方单价**。
- `sensenova.cn/token-plan` 官方页：公测"完全免费"，付费档"即将上线"；**免费名单当前已不含 DeepSeek V4 Flash**（只剩 SenseNova 6.8 Flash Lite 与 U1 Fast）。该模型从免费名单消失而付费档未上线，说明其计费状态**未定义/漂移中**，不能按"免费"计。
- 社区数据（不可作为官方规则引用）：GitLab 文档记 $0.30/M 输入、$1.20/M 输出；llm-ring catalog 记 maxOutput 65,536。任务明确禁止用其他 Provider 价格替代——pi-ai catalog 中 opencode-go 条目的 $0.60/M、DeepSeek 官方 flash 价均不可替代 SenseNova。

### 1.2 裁决与依据

按任务规则三重独立不满足：

1. **官方计费规则不可核实**（官方定价页无此模型，token-plan 免费名单已移除它）；
2. **无法限制最大 Token**（B1 无请求级输出上限，wire 值来自第三方 catalog 借用）；
3. **费用上界无法证明 ≤ $0.80**：按唯一可引用的请求级上界（3 × 384k 输出）× 社区记载付费输出价 $1.20/M = **$1.38 > $0.80**。

→ **AC-6 = `BLOCKED_COST_GUARD`。0 次真实请求，$0 花费。** 三个测试在 `LLM_E2E_ENABLED` 缺席下的零费用跳过路径已实跑验证（3 skipped，exit 0）。

### 1.3 解锁 AC-6 的条件（供 Owner 决策）

1. Provider 侧计费规则获得**官方**确认（免费公测延续的官方公告，或官方单价页收录 deepseek-v4-flash）；且
2. B1 获得请求级输出上界——最小修复是 Dreamer 测试或 `L2AgentLoopAdapter` 配置显式 `maxTokens`（如 4096，则最坏 3×4096×$1.20/M ≈ $0.015，任意官方价下都远低于 $0.80）；或 Provider 官方文档其输出上限；
3. 之后 `LLM_E2E_ENABLED=true` 串行各跑一次三场景（总量 ≤12 请求），保留现有硬上限，失败即停。

附带发现（未扩大范围处理，仅记录）：`resolveL2Model` 对自定义 baseUrl 的 catalog 借用会把**另一家中转商的 maxTokens/计费元数据**带到 wire 上——对生产自定义端点同样是隐性风险，建议后续立单（本任务不改生产逻辑）。

---

## 2. 阶段 B：Learning Lab G2 真实 Actor 接线（零费用交付）

### 2.1 设计（复用优先，不另造框架）

- **transport seam**（`lib/actor.mjs`）：真实 Actor 的模型调用只有一个接缝。
  - `createPiAdapterTransport({ adapter })` — 包裹**生产 `PiAiRuntimeAdapter`**（同一 startRun/fetchOutput 公共边界），schema ref 走生产 `OUTPUT_SCHEMA_REGISTRY` 新登记的 `learning-lab-actor-action-v1` → 复用生产 tool-call / json_schema rewrite / 有界修复全套机制。生产适配器由调用方在 OD 授权后构造（`maxRetries: 0` 等实验室安全默认在 pilot-run-config 模板中固化）。
  - `createFakeActorTransport(...)` — 确定性离线 provider（B4），逐字记录每次调用与响应，零网络。
- **core 侧最小连接**（不新增模型调用框架）：`packages/principles-core/src/runtime-v2/learning-lab/actor-action-output.ts`（动作 schema + ref + 名单），登记进 `output-schema-registry.ts`，从 runtime-v2 barrel 导出。动作名单与 lab 的 `ACTION_COSTS` 权威保持机器交叉校验（同 world-manual 成本表纪律）；生产 runner 永不传该 ref。
- **逐轮交互循环**（`runRealActorOpportunity`）：Actor 每轮只看到允许信息（world manual + 任务文本 + 同通道投递内容 + 自己的历史动作与 Oracle 观察），返回**恰好一个动作**，由现有 Oracle `step()` 执行并产生新观察，直到终局或上限。硬上限全部前置检查：请求 16/机会、步数 40（=Oracle STEP_CAP）、单请求 token 512、单请求超时 60s、总预算 300s、无效输出最多 2 次有界重提后 FAILED。**无效动作永不进 Oracle、永不无界修复**。
- **arm 引擎**（`lib/real-runner.mjs`）：`runRealArm` = I0 反思（1 次调用）→ `freezeCandidate`（原样字节+sha256，**不润色**；E0 无内容 arm 用透明哨兵 + `deliveredRepresentation: 'none'`）→ `deliverPayload` 同通道投递（预算 2000 chars，超限响亮失败——截断权属研究设计）→ 逐机会交互 → **同一三层裁定器**（`adjudicate` 增加 `actorRunStatus` 参数，默认 `'COMPLETED'` 保持 G1 语义）。judge 泄漏即停整场研究（后续 arm 不启动，pilot-run-config exitConditions）。
- **数据集零改动**：E0/EA/EB/EN、P1–P4、gold、校准电池、splits 全部原样复用；真实候选走现有 `freezeCandidate()`；sidecar 走现有 `validateSidecar()`（`sourceStage: 'i0-reflection'` 本就在允许清单）。

### 2.2 泄漏防护（B2）— 含一项设计级修正

- 禁泄清单逐项落实：gold 答案/隐藏消费者预设损失/评分器 internals/Canary/未挣得的未来观察均不进入 Actor 输入；`synthetic` 标记保留；NT-01..NT-08 继续由现有 sidecar 校验器执行。
- **设计级修正（本次发现并修复）**：gold canary 字符串同时是隐藏消费者 ID（如 `ledger-reconciler`），而 `consumer-graph-query` 的**合法 Oracle 观察会揭示它们**——这是任务本身，不是泄漏。初版把 canary 扫描套在整轮 prompt（含 transcript）上，导致正常查验被误判 INVALID_PROTOCOL。修正为：**NT-01 守卫只扫通道文本**（system 角色 + 任务文本 + 投递内容 + 无效输出提示——Actor 未经 Oracle 动作就能看到的一切），transcript（挣来的观察）明确豁免。修正后的守卫仍然捕获真实的通道泄漏（I0 输出复述 canary、投递内容夹带等，均有测试正控）。
- 跨 arm 隔离：每 arm 独立 transport 实例、无模块级可变状态；隔离由测试用每 arm 唯一 policy-marker 证明。

### 2.3 离线演练（B4）— `scripts/__tests__/principle-learning-lab-actor.test.ts`，18/18 绿

任务要求的验证点 → 测试证据：

| 要求 | 测试 |
|---|---|
| Actor 依据第一次观察改变后续动作 | P4:phase-a：harness-status → rot 揭示 → consumer-graph（第二轮动作以第一轮观察为条件） |
| 任务结束后不再调用模型 | P2 终局后 transport 调用数不再增长（scripted 第二轮永远未被消费） |
| 无效输出与超时明确记录 | 未知动作/garbage → 有界重提 2 次后 FAILED、steps=0（未进 Oracle）；transport 错误 → FAILED；no_response → NO_RESPONSE |
| 隐藏答案不进入 Actor 输入 | 全部记录调用扫 canary 为空 + 投递夹带 canary 的正控（守卫在调用前触发，requests=0） |
| 跨组无记忆泄漏 | 四 arm marker 互不串扰（含 E0 空 payload） |
| Oracle 记录与 Evaluator 评分一致 | adjudication.realOutcomes.checksRun/terminalAction/taskCompleted 与 Oracle 状态及 transport 实际执行一致（P2 零查验直进、P1 含 consumer-graph） |
| 失败不写生产治理状态 | `frozenCandidate.principleId` 恒 null（NT-06）；产物仅 sidecar（research view）；无任何 store 引用（by construction）+ validateSidecar 通过 |
| 单次运行请求/动作上限可证 | `maxRequestsPerOpportunity: 2` 下 requests==2、budget_capped、INTERRUPTED、terminal='timeout' |
| 生产接线形态（零网络） | fake adapter 证明 schema ref/agentSpec/inputPayload/systemPrompt 逐字段落到 `StartRunInput`；fetchOutput null → no_response |
| 研究级停止语义 | 投毒 arm（I0 输出含 canary）→ 整场停止、后续 arm 不启动、行标 INVALID_PROTOCOL |
| 冻结完整性 | I0 输出原样冻结（contentHash == sha256(policyText)），投递字节 == 冻结字节 |

**再次声明：以上为 Mock 演练证据，仅证明接线与控制机制，不冒充真实模型实验结果。**

### 2.4 Complexity Delta

```text
New durable source of truth: NO（动作名单仍以 lab ACTION_COSTS 为权威，core schema 名单与其机器交叉校验，同 manual 成本表既有纪律）
New persisted schema/state: NO（零数据库/零迁移/零后台服务；研究视图仍是 sidecar 派生数据）
New subsystem/service/background process: NO
New public abstraction/interface: YES — (a) 注册表条目 learning-lab-actor-action-v1 + schema 导出；(b) lab transport seam（fake/pi-adapter 两个实质不同实现，变化轴=离线演练 vs 生产模型，当下即真实）
New runtime feature flag: NO
New cross-package dependency: NO（scripts/dev 引用 @principles/core 既有先例；core 不依赖 lab）
New host/platform-specific behavior: NO
New external/network capability: NO（本次交付零网络；真实调用待 OD 授权）
```

两个 YES 的理由：(a) 现有 owner（PiAiRuntimeAdapter 的注册表）加一行连接即可服务该需求，任何更小的方案都要在 lab 重造结构化输出机制（任务明令禁止）；(b) seam 是任务本身要求的离线演练/真实运行二态。移除方式：删 4 个新文件 + 还原注册表/barrel/快照 3 处登记。

### 2.5 阶段 C：预注册草案（保持 DRAFT_NOT_OWNER_APPROVED）

`preregistration.json` 在**不破坏 validatePrereg 机器契约**（G1 实跑校验 PASS）前提下补齐任务 §五 全部 7 项：研究主问题（何时该谨慎 vs 机械加检查）、E0/EA/EB/EN 对照方式与投递不变式、P1/P2/P4 逐探针主指标（P4 双阶段即核心研究问题的单探针浓缩）、重复/随机化/失败处理规则、数据集 hash + 模型 + 上下文冻结要求、真实实验独立预算/停止条件/费用记录（估算与账单分离，token 缺失如实记 null）、四类指标分别统计（完成率/对齐分布/验证成本/Owner 打扰成本，禁加权合成掩盖分层回退）。`ownerDecisionsPending`（OD-1..OD-5）原样保留；状态字段未动。`pilot-run-config.json` 更新为已落地接线 + 演练证据 + 仍 NOT_AUTHORIZED。

---

## 3. 验证记录（命令与结果）

| 命令 | 结果 |
|---|---|
| `npx vitest run __tests__/principle-learning-lab-actor.test.ts`（scripts/） | **18/18 PASS**（新增） |
| `npx vitest run`（scripts/ 全量） | **865/865 PASS（47 文件）** |
| `node scripts/dev/principle-learning-lab/run-pilot.mjs --out .tmp/ac6/g1-rerun` | 健康 PASS；24 arms × 5 = 120 adjudications；**校准 14/14**；prereg 草案 PASS；**G1 gate PASS**；studyHash `5a617d508e2f…` |
| `npx vitest run src/runtime-v2/__tests__/architecture-regression.test.ts`（core） | **499/499 PASS**（barrel 面快照按契约更新后） |
| `npx vitest run src/runtime-v2/adapter/__tests__/pi-ai-runtime-adapter.test.ts`（core） | **139/139 PASS** |
| AC-6 三测试（无 LLM_E2E_ENABLED） | 3 skipped，exit 0（零费用跳过路径实证） |
| `npm run build --workspace @principles/core` | PASS（= 类型检查 + dist 卫生检查） |
| `npx eslint`（3 个改动 core 文件） | 0 发现 |
| 冻结数据集 | `git diff origin/main -- …/fixtures/` 仅 `preregistration.json`、`pilot-run-config.json`（两者均不在 fixtureHash FILE_ORDER 内）；fixtureHash `4c3ea4ab29ce…` 不变 |

注：本任务不建 PR、不合并（按指令），故未跑全量 `verify:merge`；以上为受影响面的定向门禁。`npm run test:scripts`、lab 套件、core 定向套件、构建类型检查覆盖了全部改动代码。

## 4. 变更清单

**新增**：
- `packages/principles-core/src/runtime-v2/learning-lab/actor-action-output.ts` — 动作 schema/ref/名单
- `scripts/dev/principle-learning-lab/lib/actor.mjs` — transport seam + 逐轮交互循环 + 上限/无效/canary 机制
- `scripts/dev/principle-learning-lab/lib/real-runner.mjs` — I0→冻结→投递→Oracle→三层裁定 arm 引擎
- `scripts/__tests__/principle-learning-lab-actor.test.ts` — 18 项离线演练
- `.changeset/pri966-g2-actor-schema.md` — @principles/core minor

**修改**：
- `output-schema-registry.ts`（+1 条目）、`runtime-v2/index.ts`（+4 导出）、`runtime-v2-barrel-surface.json`（快照 +4 名，PRI-775 契约）
- `evaluator.mjs`（adjudicate 可选 actorRunStatus，默认不变）、`README.md`（§3/§6.1）、`preregistration.json`（阶段 C）、`pilot-run-config.json`（接线模板）

## 5. 阻塞项与进入真实 G2 的前置条件

**AC-6 阻塞（解除即真实运行）**：见 §1.3 —— 官方计费确认 + B1 请求级 maxTokens + `LLM_E2E_ENABLED=true`。

**真实 G2 前必须满足（全部为 Owner 决策，非工程缺口）**：
1. **OD-1** 冻结预注册草案（或修订）；
2. **OD-2** 真实 pilot 的模型凭据 + 独立费用上限（与任何 AC-6/e2e 预算互不共享）+ 固化 `DEFAULT_REAL_ACTOR_CAPS` 真实值；
3. **OD-3** 重复次数/种子（草案 ≥3）；
4. G1 gate 持续 PASS（已满足）；真实 profile 的 memory manifest 首跑前指纹（机制已备：`buildMemoryManifest`）；
5. 真实运行时每机会 per-round usage 自动记录；token 用量以 Provider 面板/账单为准，估算必须标注为估算。

**明确不做/未做**：未建 PR、未合并、未改 Linear、未跑任何真实模型调用、未触碰生产治理状态、未修改冻结数据集、未为 catalog 元数据借用风险做生产修复（建议后续立单）。
