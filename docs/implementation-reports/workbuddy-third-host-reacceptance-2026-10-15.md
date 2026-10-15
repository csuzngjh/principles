# WorkBuddy 第三宿主 — 合并后重验收与残余缺口收尾（2026-10-15）

> 任务：在 PRI-952 实现已合并（PR #2020，squash `5e794be8e`）的前提下，于最新 `origin/main` 上重新执行任务书要求的完整验收（Phase 0 新鲜度、真实宿主 E2E、Owner 闭环、兼容边界），并按证据修复仍然真实的残余缺口。
> 本报告对象：任务分支 `ai/adhoc-20261015-workbuddy-reacceptance-a27903`（基点 `3846fea63` = origin/main）。
> 隔离纪律：全程未写真实 `~/.workbuddy`、`~/.pd`、`~/.openclaw`（前后 SHA 校验见 §8）；所有 lab 位于 `D:/Code/wb-probe-lab/` 与 worktree `.tmp/`。

## 1. 结论（Verdict）

**GO（有边界）** — WorkBuddy 第三宿主在当前 HEAD（`3846fea63`）真实可用：

- 真实引擎（Desktop 5.8.2 / 引擎 2.161.0，二进制与 Phase 0 冻结契约完全一致）上的治理主回路 **6/6 PASS**；
- 正式安装产物链（pack → 签名式 asset → 官方安装器 → 真实引擎发现 → canonical wrapper 无 env 覆盖）**8/8 PASS**；
- 全链真实学习（真实 LLM 诊断→审批→真实引擎注入中文原则原文→撤回→停注）**17 PASS / 0 FAIL / 0 BLOCKED，SCENARIO VERDICT OK**；历史的 tarball-installer-entry NOT RUN 腿随发布边界闭合转为 **PASS**（§5.4）；
- Console Owner 闭环（真实 console server + HTTP API）**5/5 PASS**（对历史 run-4f lab 与今日 lab 双验证）；
- 两个真实残余缺口修复：G1 引擎多盘探测、G3 阈值常量导入（§6）；G2 以新脚本闭环；
- 发布尾巴：PRI-979（channel 构建镜像）已于本 session 开始后由 Owner 合并（`3846fea63`），发布链路对 `@principles/workbuddy-adapter` 已闭合。

## 2. 代码改动清单（已合并，本 session 只读盘点）

PR #2020（PRI-952 全量）+ #2026（0.2.0 发版）+ #2028（官网 en/zh）+ #2029/#2030（identity fixture / install outcome）+ #2031（npm train，PRI-979）+ #2034（channel build 镜像，PRI-979，本 session 期间合并）+ #2032/#2033/#2035（版本/license/hygiene）。

当前 HEAD 分布：10 包 141 个 workbuddy 相关文件（workbuddy-adapter 40、create-principles-disciple 26、core 24、host-runtime 15、pd-console 14、pd-cli 8、website 7、install-layout 3、codex-adapter 2、pd-companion 2）。

本 session 新增改动（§6）：G1 安装器引擎多盘探测 + 回归测试、G3 三处阈值常量导入、E2E-06 console 闭环脚本（G2）、1 份 changeset。

## 3. 宿主版本与协议依据

- 本机：WorkBuddy Desktop **5.8.2**（`D:\Program Files\WorkBuddy`，startup-seed/last-launch 双证）；引擎 CLI **2.161.0**，sha256 前缀 `1b1a01bc5f7b1121` — 与 Phase 0 探针冻结契约（2026-10-12/13）所钉引擎**完全一致**，桌面壳 5.8.1→5.8.2 为应用版本变化，协议事实不受影响。
- 官方协议快照：`docs/plans/2026-10-12-workbuddy-official-hooks-reference.md`、`...-official-plugins-reference.md`（hooks beta 27+ 事件）。
- 冻结契约：`packages/workbuddy-adapter/tests/fixtures/host-contract/`（11 事件金样 + hook-runtime-contract.json + manifest-facts.json），由 adapter 套件内守卫测试执行（本 session 全绿）。

## 4. Phase 0 新鲜度（本 session 增量）

| 项 | 结果 |
|---|---|
| 引擎身份 | 2.161.0 / sha256 `1b1a01bc…` 与冻结值一致（本 session 实测） |
| p06 治理目录探针 | **8/8 PASS**（隔离 lab 重跑，长路径目录） |
| 事件矩阵/exit-code 矩阵 | 引擎二进制未变 + 金样守卫测试全绿 + 本 session 四次真实引擎 E2E（治理环/安装产物×2/学习链）全部复证 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse 真实行为 |
| 含空格路径 | P05 历史事实（带空格+中文路径 wrapper 探针）覆盖；本 session 各 lab 均为长路径，未触发 8.3 短路径崩溃类 |

## 5. 真实宿主 E2E（硬门禁重跑）

### 5.1 治理主回路 `e2e-governance-loop.mjs` — 6/6 PASS（lab `e2e-gov-1792041792410`）

| 场景（任务书） | 结果 | 证据要点 |
|---|---|---|
| E2E-02 原则注入 | PASS | Owner 批准的原则文本经 UserPromptSubmit additionalContext 进入 mock 模型请求体 |
| E2E-03 RuleHost deny | PASS | 受保护 Write：roundRan=true、**fileExists=false**、denyReason 进模型请求 |
| E2E-04 合法放行 | PASS | 放行不输出显式 allow（encoder 白名单），未绕过宿主原生审批 |
| E2E-05 Pain Evidence | PASS | 真实失败工具（Read failure）→ trajectory 失败行，session_id 真实记录，workbuddy 归因 |
| E2E-07 停用 | PASS | `pd activation deactivate` exit 0 |
| E2E-07 恢复验证 | PASS | 撤回后下一轮不再注入（post-withdraw clean） |

### 5.2 安装产物链 `e2e-installed-product.mjs` — 8/8 PASS（lab `e2e-install-1792046428099`）

pack → build-release-asset（8 组件戳版 payload）→ extract → **installer-run exit 0**（真实引擎发现、canary、Console ready、浏览器自启）→ deploy-register-init（runtimeEntry/nodeModules/registered/govReady 全 true）→ enable（治理 config flag 写入 ok）→ **installed-injection**（真实引擎轮次，注入 marker 达模型请求）→ **installed-deny**（受保护文件未写、deny reason 达模型）。

E2E-01（插件发现）由 installer-run + installed-injection 的真实引擎发现/加载腿覆盖。

> 首跑 3 PASS/2 FAIL 的归因：installer-run 的 console 健康检查 3 端口全 ECONNREFUSED → 隔离复现证明 payload console 在静默/重定向 HOME 下均 2-3 秒起（health 200），失败系当时机器高载（挂起 vitest fork + openclaw 套件并行）超出 6s×3 预热窗；静默重跑 8/8。**非产品缺陷**，已在 §9 记录韧性 follow-up。

### 5.3 Console Owner 闭环（E2E-06）— 5/5 PASS

新脚本 `scripts/dev/workbuddy-probe/e2e-console-owner-loop.mjs`（本 session 交付，闭合 E2E-06 自动化缺口 G2）：真实 console server + 真实 HTTP API，对 run-4f lab 与（回填：本日 lab）验证——批准的 prompt 通道审批行（artifact 归因）、`GET /api/v1/activations?host=workbuddy` 返回激活行、治理经验快照 200。

### 5.4 全链真实学习 `e2e-installed-full-learning.mjs` — **17 PASS / 0 FAIL / 0 BLOCKED，SCENARIO VERDICT OK exit 0**（lab `e2e-installed-learn-1792047098456`，sourceCommit `3846fea63`）

14 条必需腿全 SATISFIED，真实 LLM（AMD RADEON / DeepSeek-V4-Flash-Vision-Exp）真实引擎全链：

| 腿 | 证据要点 |
|---|---|
| tarball-installer-entry | **由历史 NOT RUN 转 PASS**——打包 tarball 自带安装入口在全新 HOME + registry 依赖下 exit 0（发布边界随 #2026/#2031/#2034 闭合，治理 profile 携带安装参数） |
| installer-run / deploy-register-init | exit 0；adapterEntry/installedPdCli/registered/govInit 全 true（三库由安装器共享 runtime init 创建） |
| governance-config-from-args + enable | 安装参数 model/apiKeyEnv 写入治理 config 且经真实 loader 消费 |
| real-failure-evidence | 真实引擎 Bash 失败（exit_code=7）经 canonical wrapper 进 adapter（Bash 按冻结政策 evidence-only，pain=none 如实记录） |
| eligible-signal-synthetic | 合成协议信号（已标注）经已安装 adapter → pain score 90、host_kind=workbuddy |
| background-chain / chain-disposition | 4 轮真实 worker cycle（真实治理 LLM）→ 身份链可溯：principle 候选 pending_approval（dreamer/philosopher/scribe/rollout_reviewer 全 succeeded） |
| owner-approval | 已安装 pd-cli `pd activation approve` exit 0 → `act_prompt_bc31ae15…` |
| next-turn-injection | **真实引擎下一轮注入 approved principleDraft.statement 中文原文**（probe 命中请求体） |
| withdraw / post-withdraw | 真实 deactivate exit 0；撤回后 `statementStillInjected=false` |

### 5.4b E2E-06 对今日链复验 — 5/5 PASS

`e2e-console-owner-loop.mjs --gov <今日 lab>`：批准行 `apr_prompt_pi-art-scribe-915c126b…`、激活行 `act_prompt_bc31ae15…`（host=workbuddy 查询）、治理快照 200——Owner 可见性闭环在当日本轮产出上复证。

### 5.5 E2E-08 兼容与异常映射

| 项 | 状态 |
|---|---|
| WorkBuddy 5.8.2 / 引擎 2.161.0 | 本 session 全部 E2E 实测 |
| Windows Git Bash + Node 26.7.0 | 本 session 全部 E2E 实测（hook 经 Git Bash `node` 启动） |
| 受支持 Node LTS（20/22） | **NOT RUN**（本机无 Node 20；node22 便携版已不存在）；CI 矩阵在 Node 22.23.3 上跑同 commit 套件为绿 |
| 插件路径含空格 | P05 冻结事实覆盖（含空格+中文）；本轮 lab 长路径无空格 |
| 缺失 cwd / generation_id | 金样 fixtures + decoder 事件级校验（session-start fixture 无 cwd 字段）测试全绿 |
| JSON 非法输入 / exit 矩阵 / 超时 | p02 冻结矩阵 + adapter 进程级测试（stdin/stdout/exit code）全绿 |
| Hook 并发 | `evidence-concurrency` 真并发测试全绿（同步起跑屏障 + 量化断言） |
| 依赖缺失 / stdout 写失败 | 进程级 belt 测试全绿（guarded writes + EPIPE） |
| 插件重载 / 卸载 | P01 生命周期冻结事实 + installer uninstall 测试（仅删 PD-owned、保留邻友与治理库） |
| 多宿主并存 | installer 合成环境回归（S1）+ openclaw/codex 回归套件全绿 |

## 6. 本 session 修复（均带回归证据）

### G1 — 引擎路径多盘探测（真实产品缺口，本机实证）

- **缺陷**：`resolveWorkbuddyEnginePath()` 只探 `ProgramFiles`/`ProgramFiles(x86)`/`SystemDrive`；本机 WorkBuddy 装在 `D:\Program Files\WorkBuddy` → 返回 undefined → `detect()` 报 engine not found、install SKIP 引擎验证，且 `workbuddy-real-engine-isolation.test.ts`（S2 真实引擎注册隔离）在本机**静默 SKIP**。
- **修复**：`workbuddyEngineCandidateRoots()`（win32 下扫描全部固定盘符的两种标准 Program Files；env 优先；去重；非 win32 行为不变）。
- **证据**：新单测 3/3 绿；**S2 真实引擎隔离测试在本机由 SKIP 变为真实运行并 PASS**（真实引擎注册进声明根、CodeBuddy 根零触碰、卸载干净）。
- changeset：`create-principles-disciple` patch。

### G3 — 验收阈值常量导入（终审 P3-3 挂账）

- `workbuddy-bdd.test.ts` 本地 `0.5` 改为从 `@principles/core/runtime-v2` 静态导入；`e2e-full-learning.mjs`、`e2e-installed-full-learning.mjs` 同步改为生产常量（createRequire 加载 core dist）。

### G2 — E2E-06 Console 闭环自动化（缺口补齐）

- 新脚本 `e2e-console-owner-loop.mjs`（§5.3），真实 API 断言非"配置成功"。

## 7. 测试与门禁电池（当前 HEAD）

| 套件 | 结果 |
|---|---|
| `@principles/workbuddy-adapter`（vitest 全量，含金样守卫+进程级） | 126/127（唯一失败=BDD 学习场景，见 §9-F1） |
| `@principles/host-runtime` | 471/471 |
| `@principles/codex-adapter` | 288/288（1 skip） |
| create-principles-disciple（installer 38 + profile-routing 12 + target-matrix 7 + engine-path 3 + S2 真实引擎 1 + packaged-install 7） | 全绿 |
| `@principles/pd-console` | 2818 passed + 1 expected-fail |
| pd-cli `workbuddy-worker-registration` | 7/7 |
| core `workbuddy-host-contract` + `evidence-chain-host-kind` | 12/12 |
| openclaw-plugin unit | 1916/1920（4 例本机环境债：core 全桶导入超 5s 测试超时；同 commit CI 绿；§9-F2） |
| lint + `verify:merge` | **PASS exit 0**（最终任务树；首跑唯一失败=G1 引入的 `NodeJS` 命名空间 lint error，改结构化类型后复跑全绿；runtime-writer 10 trips 全 allowlist） |

## 8. 隔离与纪律证明

- 真实 `~/.workbuddy/settings.json`（enabledPlugins 面）与 `~/.pd/install.json`：**前后 SHA 字节一致**（8e4391e9… / 551c86d5…）。
- `~/.workbuddy/plugins/installed_plugins.json` 在 session 期间（15:10:20 local）由**宿主应用自身**改写（54→56 个插件，全部 `@workbuddy-builtin`/connector/wecom/teams 官方来源，**零 PD 条目**；同时段 15:10:36 出现 WorkBuddy 应用进程启动）。PD 归因排除依据：PD 写入路径只会留下 `principles-disciple@principles-disciple-market` 键（不存在），且本 session 全部引擎/安装器调用均以双 CONFIG_DIR + fake HOME 钉死沙箱。
- 所有写入均在隔离 lab（`WORKBUDDY_CONFIG_DIR`+`CODEBUDDY_CONFIG_DIR` 双变量 + fake HOME）；主 checkout、他人 worktree（含 PRI-979 locked 树）零触碰。

## 9. 诚实边界与遗留

- **F1（BDD 学习场景时延敏感）**：今日三次运行 = FAIL（候选置信度低于准入阈值，fail-loud 如实上报）→ PASS（全链到 pending_approval）→ FAIL（780s 窗口内 rollout_reviewer pending + artificer retry_wait）。链路本身由治理环 6/6 与学习链 E2E 证明可用；这是真实 LLM 时延/方差下的验收窗口标定问题，非产品缺陷。CI 无 key 时该场景诚实 SKIP。Follow-up：窗口自适应或把该场景移入夜间 E2E（与契约脚本同源）。
- **F2（openclaw-plugin 4 例本机超时）**：`await import('@principles/core/runtime-v2')` 全桶导入本机 >5s 测试超时（import 占套件 79% 时长）；同 commit CI 绿。本机环境债（与 delivery-prep 期档案化的"4 个套件本机失败基线从未绿"同类）。Follow-up：测试内定向导入或放宽该类用例超时。
- **F3（console 健康检查窗口）**：installer 的 console 验证窗（6s×3）在高载机器上会误判（§5.2 归因）。Follow-up：拉长预热/失败时读子进程存活状态再判（本次不改：需要独立单据，避免本 PR 扩面）。
- Node 20 LTS、桌面 GUI /hooks 审核门、resume/compact 持久性：维持 SPEC v0.4.0 §13 的 NOT RUN/UNKNOWN 边界。
- PostToolUseFailure 证据-only（score 20<70 准入地板）、implementation 类信号 skill-channel MVP-disabled 政策终态：Owner 决策点，维持挂账。

## 10. 回滚

- 本 session 代码改动：单一 PR revert 即可（G1 有独立测试，revert 后 S2 在 D 盘机器恢复 SKIP——即回到已知状态）。
- 运行时回滚：`host.workbuddy.enabled: false`（flag-off = 中性 JSON + exit 0 + 可观察 skip）；卸载 = installer uninstall（仅删 PD-owned 条目）；`pd health --host workbuddy` 提供结构化诊断。

## 11. E2E-06 同链断言收口（2026-10-15 补充）

针对后续独立核查提出的「审批行与激活行各自存在，但未证明属于同一治理链」问题，本 PR 补充严格测试：

- `e2e-console-owner-loop.mjs` 仅将已批准的 `prompt` 通道行计入审批通过；以 `artifactId` 精确关联审批和激活；核验 `activationId`、`prompt_activate` 行为、审批/激活时间顺序及 `promptInjectionRoute.hostKind=workbuddy`、`status=confirmed`。因学习链最终撤回，允许关联的激活行处于 `deactivated`，不能把 flag-off 误判为注入失败。
- 对带 `e2e-results.json` 的学习 lab，从 `owner-approval` 原始收据固定预期 artifact/activation 身份；历史 lab 若无该收据，仅可报告「同 artifact 行关联」，不能假称同次实验的收据已验证。
- `console-owner-loop-assertions.regression.mjs` 有 11 个 Node 内置测试，覆盖合法同链、错误通道、不匹配 artifact/activation、非 WorkBuddy 宿主、路由未确认、时间倒序/无效、字段缺失与收据不可解析。已纳入根 `test:guard-contracts`，通过 `verify:merge` 持续执行。
- 基于 `e2e-installed-learn-1792047098456` 的真实 Console API 验证：**5/5 PASS**；`--artifact-id definitely-not-this-lab` 故意篡改预期身份：**3 PASS / 2 FAIL，exit 1**。两个场景均在隔离治理 workspace 内只读运行，未产生新的模型请求。
- `governance/experience` PASS 表示服务返回成功且有解析后的 schemaVersion，**不表示其业务 readiness 一定健康**；该 lab 的 `primaryAttention=degraded` 应如实保留。
- **证据基线声明**：原先 17/17 真实学习链 `e2e-evaluation.json` 明确记载 `sourceCommit=3846fea63`；它支持已运行链路，但不能冒充 #2038 新提交的完整学习链重跑。收口仅复验 Console E2E、反例、相关工程门禁。Node 20、GUI /hooks、resume/compact、真实自然 Pain 自动触发完整学习场景仍维持原有未覆盖状态。
