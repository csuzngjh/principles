# SPEC-PD-PL-001 v0.3 — PR-01 离线最小 Pilot（G1）+ G2 接线准备 实施报告

> 日期：2026-10-15 · 工单：PRI-966（umbrella）/ PRI-967 / PRI-968 / PRI-969 / PRI-970 / PRI-971
> 工作分支：`ai/PRI-966-principle-learning-lab`（worktree `D:\Code\_worktrees\principles\PRI-966-principle-learning-lab`，writer=zcode，基于 origin/main `10c7767ac`）
> 权威：`docs/specs/SPEC-PD-PL-001-principle-learning-dataset-v0.3.md`（随本 PR 入库）+ PR-00A/B 审计（docs/audit，本地参考副本）
> 交付物：`scripts/dev/principle-learning-lab/`（全部源码+冻结数据集）+ 本报告

## 0. 一句话结论

**G1 完成（DONE_VERIFIED）**：一条命令跑通「受控历史 → 未来任务 → 模拟 Agent 决策 → 机械 Oracle → 三层裁定 → sidecar 校验 → 对照报告」完整离线闭环；G1 gate 全绿（校准 14/14、四错误策略全部暴露、正/稳定性对照通过、8 项硬负测试全自动化）。**G2 接线准备完成、真实 Agent Pilot 未运行（NOT_RUN，凭据/预算未授权）**。本报告证明的是**实验方法可判别**，不是真实 Agent 有经验敏感性。

## A. 已完成内容（逐工单）

| 工单 | 交付 | 判定 |
|---|---|---|
| PRI-967 可判别夹具 | PLE-PILOT-01：svc-config 合成世界（动作手册+成本表）、4 历史（E0/EA/EB/EN，EN=EA+预注册无关差异）、4 Probe × 5 机会（P1 针对性验证/P2 不过检/P3 真冲突/P4 修订+保持双阶段）、机械环境（隐藏消费者/契约腐化/时限/授权/harness 状态机）、健康检查、fixtureHash 冻结 | **DONE_VERIFIED** |
| PRI-968 Oracle+校准 | 确定性交互式 Oracle（step 语义/成本/事故/时限/授权违规）、三层分离评估器（principleAlignment / objectiveTaskStatus / ownerCost）、4 退化策略 + 2 合理对照、14 案冻结校准电池（文风不变性×2、假查验、零工具正控、过度澄清、过检、欠检、越权硬边界、合理冲突×2、修订、腐化信赖、过度修订） | **DONE_VERIFIED**（14/14 复现） |
| PRI-969 Sidecar 契约 | `principle-study.v1` + `adjudication.v0.1` + `memory-manifest.v0.1` + `freezeCandidate` 冻结接口 + `validateSidecar` 校验器；复用 `experiment-manifest.v1`（pipeline-evolution lib）；8 项 SPEC 硬负测试全部自动化（NT-01..08） | **DONE_VERIFIED** |
| G1 集成验收 | 统一入口 `npm run dev:pl-pilot`：初始化→加载→执行→Oracle→校验→汇总→双格式报告；G1 gate 六类机器检查；46 项自动化回归；字节级确定性（重复运行 sidecar 逐字节一致） | **DONE_VERIFIED**（gate PASS） |
| PRI-970 预注册 | `fixtures/preregistration.json`（claims/信息截止/分配与分析单位/任务前机会/缺失处置/预算/OD-1..5 待决）+ `lib/prereg.mjs` 机器校验（防伪造 Owner 批准、防 arm 偷换、防事后加 claim） | **DONE_VERIFIED**（草案级：DRAFT_NOT_OWNER_APPROVED） |
| PRI-971 G2 准备 | 同通道投递 `deliverPayload`（research-same-channel-v1）、Model Stub Actor 接口、payload+prompt 双级污染检查、真实 profile Memory Manifest 指纹、`fixtures/pilot-run-config.json`（NOT_AUTHORIZED + OWNER_DECISION_REQUIRED 边界） | **DONE_VERIFIED**（接线级：无真实模型） |
| PRI-972/973 真实对照 | 未执行——模型凭据与费用上限未授权（OD-2/OD-3） | **NOT_RUN（BLOCKED_EXTERNAL→OWNER_DECISION_REQUIRED）** |
| PRI-974 独立裁定/报告 | 真实实验不存在，无可裁定对象；离线报告已交付 | **NOT_RUN**（依赖 972/973） |

## B. 实验可复现性

```bash
# 干净环境（本 worktree 或合并后的 main）：
npm run dev:pl-pilot                        # 完整闭环，退出码 0=G1 PASS
node scripts/dev/principle-learning-lab/run-pilot.mjs --out <任意目录>   # 指定输出
cd scripts && npx vitest run __tests__/principle-learning-lab.test.ts    # 46 项回归
```

- 输出目录默认 `<repo>/.tmp/principle-learning-lab/PLE-PILOT-01/`（git-15 合规）。
- 复核 Oracle：`comparison-report.json` 的 arms[].opportunities 逐格含 task/align/cost/incident/asks；
  `adjudications.jsonl` 120 行（24 arm × 5 机会）逐行含三层结果与 reason code。
- 复核研究完整性：fixtureHash `bfaf3f928078f97e5bafe291b58f0f7ca318e74c78dc4025b182f94d56cf736c`、
  studyHash `f4e771907fc7ff1f9eb3ca1d5f29075d0db7a631557ddc77de5d4147113c006d`（字节确定性已测）。

## C. 实际测试证据

| 命令 | 结果 |
|---|---|
| `node scripts/dev/principle-learning-lab/run-pilot.mjs` | G1 gate **PASS**（健康检查过；校准 14/14；120 裁定；sidecar 校验 0 问题；预注册草案校验过） |
| `cd scripts && npx vitest run __tests__/principle-learning-lab.test.ts` | **46/46 PASS**（含 NT-01..08、确定性双跑、CLI 子进程、G2 污染注入） |
| `npm run test:scripts` | **828/828 PASS**（45 文件，含既有套件零回归） |
| `npm run check:repo-hygiene` / `check:docs-structure` / `check:workspace-tools` | 全过 |
| `npm run verify:merge` | 见 PR 描述（后台执行完成后回填；本报告提交时若仍在跑，PR 中以 CI 为准） |
| `npm run lint` | scripts/dev 不在 lint 范围（lint-by-package 仅覆盖 packages/）；新增 TS 仅 `scripts/__tests__/*.test.ts`（test 文件被 lint 显式排除） |

未解决缺陷：无已知。开发中修复的自身缺陷：securityCritical 特征误配否定句（"not security-critical"）、E0 基线策略未分派、成本层级未计 staged/compat、EN 因果证据事件 ID 前缀误报——全部由 gate/测试暴露后修复，未削弱任何断言。

## D. 研究可信度（严格分层）

1. **本报告证明的**：实验**方法**可判别——四错误策略在指定 Probe 全部暴露（ALWAYS_VERIFY 于 P2/P3 时限 breach；NEVER_VERIFY 于 P1/P4a 事故含不可逆损失；ALWAYS_ABSTAIN 于全部机会不完成+Owner 负担≥4；ALWAYS_REVISE 在 EN 无关差异上策略漂移）；文风/免责声明/自述不改变评分；零工具但证据充分的行动判 ALIGNED；越权硬边界不被好结果 rescue；E0 基线在 P1 失败（先验+手册不足被证明）；EA/EB 产生方向适当且可测的行为差（EB 字面迁移在 P1/P3/P4a 边界误用）；EN 对合理策略零漂移；P4 双阶段同时展示可塑性（腐化触发局部修订）与稳定性（新鲜证据仍被信赖）。
2. **本报告不证明的**：任何真实 Agent 的经验敏感性（C-E）、抽象增量（C-A）、投递治理增量（C-D）、Owner 净价值（C-N）。所有 arm 是确定性模拟策略；`pipelineReachability` 恒 NOT_REACHED；无 LLM、零模型成本。
3. **结论用语**：C-E = `METHOD_VALIDATED_ONLY`；C-A = `NOT_ESTIMABLE`（待 G2/G3 真实候选冻结后同通道对照）。

## E. Go/No-Go

- **G1：达到验收**（§3.4 全链路真实运行 + 正反例校准 + 自动化回归全绿）。
- **G2：可执行的部分已执行**（隔离接口/冻结/Stub/污染检查/运行配置）；**真实 Agent Pilot（阶段三）NO-GO**，阻塞项 = OD-1 预注册冻结、OD-2 模型凭据+费用上限、OD-3 重复次数、OD-4 LLM judge 取舍（详见 preregistration.json ownerDecisionsPending 与 pilot-run-config.json）。
- **未制造任何虚假成功状态**：真实实验相关条目全部 NOT_RUN，原因成文。

## F. Git / Linear 状态

- 分支 `ai/PRI-966-principle-learning-lab`：SPEC v0.2/v0.3 入库（v0.3 从 primary staged-but-uncommitted 副本复制，内容未改）、`scripts/dev/principle-learning-lab/` 全部源码与冻结数据集、46 项测试、README、npm 脚本一行、本报告。
- PR：本报告所在 PR（创建后回填编号）；未合并（Owner 合并）。
- Linear：PRI-967/968/969/970/971 附证据置 In Review；PRI-972/973/974 保持未启动并在 PRI-966 留 OWNER_DECISION_REQUIRED 备注；不将未验证工单标 Done。

## Owner Review Card

1. **Problem**：PD 要研究「Agent 未来判断是否因过去经历而有价值地改变」，但仓库里没有能区分「合理验证策略 vs 错误策略」、防金标泄漏、可复现的实验基础（PR-00A 审计确认 Missing）。
2. **Before**：S001/S006 夹具只测「有没有查」，无成本/风险/时限结构；Evolution Lab 的 NOT_REACHED 语义不能评无 PD 组行为；无 sidecar、无预注册、无泄漏守卫。
3. **After**：一条命令的离线闭环 + 46 项回归 + 8 项硬负测试 + G2 真实 Agent 接线（未运行）。
4. **复用机制**：`experiment-manifest.v1`（pipeline-evolution lib，直接 import 复用）；closure-lab 的「lab 自持夹具」仓库习惯；evidence-package 的「事实与结论分层」纪律。未新建数据库/服务/flag/生产路径。
5. **Complexity Delta**：新事实源 NO（sidecar 是派生研究视图，权威仍归生产 store）；新持久 schema NO（JSON 文件，随 git 版本化）；新子系统 NO（dev-script lab，同 closure-lab 级别）；新公共抽象 YES（lab 的 9 个 lib 模块——研究协议本身，删除即整个 lab 消失，无生产耦合）；新 flag NO；新跨包依赖 NO；新 host 行为 NO；新外部能力 NO。
6. **最小性**：全部位于 `scripts/dev/`（研究工具区），生产包零改动；唯一生产文件改动 = package.json 一行 npm script。
7. **验证**：§C 表格；核心证据 = G1 gate 的「实验必须能失败」设计（退化策略不暴露即 gate FAIL）。
8. **风险**：合成世界的判别力不能外推到真实 Agent 行为分布（报告已分层声明）；策略实现是研究者的行为模型，可能带建模偏差（预注册的竞争解释已列）。
9. **回滚**：删除 `scripts/dev/principle-learning-lab/` + 测试文件 + package.json 一行即可完全移除；无状态残留。
10. **未纳入的相邻工作**：6 PLE/24 Probe 扩建（PR-04 未授权）；LLM judge；PRI-904 旧效应复算；C-D/C-N 对照设计。

**END — 实施报告**


## G. Independent Review Fix ? PR #2037 (2026-10-15)

??????????????????? **46/46**?**828/828**?fixtureHash ? studyHash ??????????**??????????**?

- **RF-01 P1**????? Owner sign-off ?????? \`requestType=deployment-signoff\` ??? \`targetKey\` ?????????????????????? Owner ??????????P3 ???????????????????
- **RF-02 P1**????????????? Owner APPROVED??????? G1 Gate ????? CLI ????????????? preregistration ???
- **RF-03 P1**?????? Arm ????????? runner??????????????????? Arm ?????? CLI ????? fail closed?
- **RF-04 P2**???????????? timeout ? step-cap ??? deadlineBreached/delayLoss?9 ?? deadline?16 ???????????? 5 ????? 35 ???
- ?? 5 ????\`cd scripts && npx vitest run __tests__/principle-learning-lab.test.ts\`?**51/51 PASS**?\`npm run dev:pl-pilot\`??? 14/14?120 ????G1 PASS?
- ?? P3 ???????????????fixtureHash ? \`bfaf3f928078?\` ??? \`4c3ea4ab29ced329c28d916c8be0360952ca0d23b36786f64693e9319391e9a4\`?studyHash ??? \`5a617d508e2f81b6ef127c72aaf4a82e4b1f901e61245f2a362251d071a587af\`?????????? Agent/Owner ???????**??**???????????????????????
- ?? Agent ? C-E/C-A ?? **NOT_RUN**?G2 Owner ??????????????????????


**Full script-suite verification note:** \`npm run test:scripts -- --testTimeout 15000\` => **833/833 PASS** (45 files). On this heavily loaded Windows machine, the default 5000ms timeout caused three unrelated \`workspace-lifecycle.test.ts\` cases to time out when run concurrently (830/833); the same file passed separately 26/26. No test assertions or application implementation were relaxed. Local \`npm run verify:merge\` remains **NOT PASS** in this new worktree because package-local dependencies (e.g. \`@earendil-works/pi-ai\`, \`typebox\`) are not installed here; it fails in \`packages/principles-core\` TypeScript compile, outside the changed lab code. Final merge evidence must rely on a clean-install GitHub CI rerun after this fix commit.
