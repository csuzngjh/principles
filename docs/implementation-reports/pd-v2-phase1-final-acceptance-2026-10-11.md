# PD v2 Phase 1 实宿主最终验收报告（2026-10-11，第三轮）

> 状态：**已交付 · PARTIAL（维持）**。本轮为 Phase 1 收尾后的最终验收轮（任务书 §一～§十一）。
> 前序：`pd-v2-phase1-host-acceptance-2026-10-10.md`（r1/r2/r3）、`pd-v2-phase1-b1-diagnosis-2026-10-11.md`、`pd-v2-phase1-closeout-2026-10-11.md`（#1986）。
> 验收 worktree：`D:\Code\_worktrees\principles\pdv2-p1-final-pdv2-p1-final-acceptance`（基线 = 合并后的 origin/main `ce1ba2ca`，含 #1986 squash `4b84634b`），writer=zcode（租约）。
> 隔离环境：新沙箱 `D:\Code\_pdtest\p1-final\`（A2 内化链）、历史沙箱 `D:\Code\_pdtest\p1-acceptance\sandbox`（D/C 线，含 10-10 批准与激活，本轮前置快照）、网关 18798（`~/.pd-p1test\openclaw-state-p1f`）、Console 3202、Codex `~/.pd-p1test\codex-home-p1f`（官方 marketplace→plugin add→$pd-setup 安装链）。

## 0. 一句话结论

**Phase 1 维持 PARTIAL**：Codex 宿主首次完成**真实非空 Phase 1 证据摄入**（真实会话 hook 注入 → recorder → ingress → evidence ledger 全链，诚实 submitted 封顶），四问/重放/重启/失败边界在真实数据与 main 构建上复核通过；但 GJ-01（OpenClaw 强制拦截全链）因**无可在隔离环境激活的已批准 RuleHost 原则**而 BLOCKED，本轮授权的唯一一条内化链在修复后代码上仍 `generation_rejected`（两轮同败于同一条确定性用例，定性为规则表达性/指令遵循能力缺口而非输入保真缺陷），Outcome 依赖 GJ Episode 故 NOT RUN。

## 1. 实际版本与安装来源（任务 §二/§三）

| 层 | 版本 | 来源 | 本轮用途 |
| --- | --- | --- | --- |
| 仓库 main | `ce1ba2ca`（#1987）；#1986 = squash `4b84634b`（12:40Z 并入；评审 head `66331ce0` 已核实在 main 内容中） | origin/main | 验收基线 |
| A2 内化链运行代码 | worktree `npm run build`（根构建 + 单独 `@principles/pd-cli` 构建，**根构建不含 pd-cli**——已知坑） | worktree 构建（当前代码） | 内化链 CLI（#1986 修复全量生效） |
| C4 边界回归 | 同 worktree 构建 | 同上 | BDD/model/route 24 测试 |
| npm 发布包（pin 目标） | codex-adapter **0.5.1** / host-runtime **0.8.1** / core **1.291.2**（1.291.2 = 2026-10-11T03:51Z 火车，含 #1982；**#1986 的 prompt 修复不在任何 npm 包中**，属仓库未发布代码） | npm registry | D 线安装来源 |
| Codex 隔离实装（p1f） | `adapter@0.5.1 + host-runtime@0.8.1 + core@1.291.2`（`.pd-runtime.json` 实测；与 repo pin 逐字一致） | 官方链：本地 marketplace（worktree）→ `codex plugin add` → `$pd-setup` | **D 线运行时** |
| OpenClaw 网关运行时 | `~/.pd/runtime`：core 1.291.0 / host-runtime 0.8.1 / codex-adapter 0.5.1 / plugin 2.1.0（只加载未修改） | 官方安装器（实装机） | 网关/会话/Console 3202（安装版读侧） |
| 宿主与模型 | OpenClaw 2026.10.1 (e178c39)；codex-cli 0.162.1；AMD DeepSeek-V4-Flash（实测可用）；本地 lmstudio `qwen/qwen3.8-27b`（实测可用） | 本机 | 真实会话与 LLM 管线 |

生成器/执行者差异已如上分列；D 线注入内容由 p1f 实装运行时从 10-10 沙箱 ledger 的**既有激活**读取（非本轮生成）。10-10 沙箱 DB 本轮前置快照：`D:\Code\_pdtest\p1-final\snapshot-p1-acceptance-sandbox-state-db-20261011.bak`。

## 2. Owner 决策与激活引用（任务 §三/§四）

- 本轮**零新批准、零新激活、零手工插表**。全部治理/证据写入经真实 CLI/Console/hook/ingress。
- 复用的既有治理对象（10-10 轮产物，均在本沙箱 ledger）：
  - 批准 `apr_prompt_pi-art-scribe-f116754d-…-prompt_1`（channel=prompt，status=approved，decided_by=operator，note=「Acceptance-GJ: Owner 授权的测试原则批准（隔离 workspace）」——该批准方式随 #1977 入库获 Owner 认可）；
  - 激活 `act_prompt_0a54f406-…`（prompt_activate，2026-10-10T00:15:54Z，deactivated_at=null，**本轮仍处 active**）。
- 实库（真实 Owner workspace）只读盘点：57 批准 / 32 激活；其中 **code_tool_hook（RuleHost）已批准 2 条**（2026-09-15，见 §5 决策卡）；当前活跃激活全部为 prompt 通道（18 条）。未对实库做任何写入（一处 mtime 异常见 §9 披露）。

## 3. 验收 A：正式、可审查的原则

### A1（既有合格 RuleHost 原则）——**BLOCKED（对象存在、机制缺失）**

- 沙箱侧：全部测试 workspace（p1-acceptance/pd-workspace、p1-acceptance/codex-ws、p1-closeout/sandbox、p1-closeout/codex-ws）approvals/activations 均 0；10-10 主沙箱仅 prompt 原则。**无任何沙箱内已批准 RuleHost 原则**。
- 实库侧（只读）：2 条已批准规则（pain_host_cffdcb9f 链）——
  1. `…evaluator-r1-mu2yt8y7`：approved 2026-09-15T17:51Z，shadow 激活 29 分钟后停用；语义=「基线锚定与对比验收」（write/edit/apply_patch 改基线生产产物须有改前勘察或基线锚定证据，否则 block）；replay passed=true。
  2. `…evaluator-r1-mu3ayqqa`：approved 2026-09-15T23:31Z，**live 激活 09-15→09-17 约 1.5 天**；语义=「基线锚定」门控（动作级安全守卫 + 基线路径模式 + 系统目录写入拦截）；replay passed=true。
  两条均为路径/模式触发型，**技术上可在安全隔离测试目录触发**（如向 `assemble/final/manifest/baseline` 命名文件或系统目录路径发起 write）。
- 机制缺口（GJ-01 的真实阻塞）：Phase 1 无跨 workspace 原则使用机制（ADR-0028 Owner Asset 层为后续授权项）；隔离使用只有三条路——在实库真机测试激活（污染实账本）、复制 DB（任务 §五明令禁止）、或在沙箱内重新内化出候选（A2，本轮失败）。**结论：A1 对象存在，SPEC §13.9 要求 Owner 选择 + 机制裁决，见 §5 决策卡 1。**

### A2（唯一授权内化链）——**FAIL（generation_rejected），证据已固定**

在修复后代码（main=ce1ba2ca，含 #1986 的 v12 facts / v8 评判映射 / caseInput 分预算 / 目标优先 digest 全部修复）上执行**一条完整链**（任务限额）：

- 真实前置链（全部落库可查）：隔离网关 18798 真实会话 `1e9f69d2`（AMD DeepSeek-V4-Flash，纯 `write` 配对：负例 tool_call id7=`write protected/secret-plan.txt`、正例 id8=`write worklog.md`，与 10-11 v2 pack 形态一致）→ `pd pain record`（score 75，富理由，会话绑定）→ 诊断管线（rootcause r1 瞬时失败 r2 成功）→ 4 候选（principle/rule/implementation/prompt）全部 admitted/consumed（implementation 走 MVP-disabled skill 通道被拒=预期 degraded）。
- 内化链五阶段：dreamer ✓（13:34–13:35）→ philosopher ✓（13:35–13:39）→ scribe ✓（13:39–13:42）→ **对抗循环 2 轮耗尽 → `generation_rejected`**（artificer r1 13:42–13:50 / evaluator r1 13:50–13:52 / artificer r2 13:52–13:56 / evaluator r2 13:56–13:59）。
- **两轮失败点完全相同**：确定性用例 `v2-path-boundary`——`tool=write, priorReadOfTarget=no, readCount=1, target="worklog.md.bak"`，期望 **block**，实际 **allow**（`replay_decision_mismatch`）。即：读过 X 后写 X 的兄弟/变体路径未被拦——正是 Owner 纪律「读取 X 之后写 X 的变体（例如 X.bak）必须先确认」。
- **输入保真已排除**：evaluator r1 工件失败条目携带完整 caseInput（context facts 前置、target 带引号可见、rationale 完整）——#1986 修复在真实链上生效；r2 artificer 在完整可见的失败输入下仍未实现兄弟变体拦截。
- **能力缺口定性**（evaluator v12 摘要原文佐证）：「未将『读取与授权分离』…具体化为可执行的 verifiable 动作」「需补充…先读受保护文件后写其兄弟/变体路径的语义混淆拦截」；risks 明示 stateless 单次 evaluate 无法建模读取/授权独立状态机（PRI-508 能力边界）。**判定：剩余阻塞=规则表达性（跨调用授权状态）×模型指令遵循，非输入保真缺陷。** 按任务规则（重复同因失败停止重跑）不再重试。
- 副产物如实披露：intake 种子的 prompt 链 dreamer 任务被并行消费后随主链进程退出冻结在 `running`（孤儿行，无治理影响）。

## 4. 验收 B：OpenClaw GJ-01 —— **BLOCKED（无授权激活对象；场景就绪）**

- 前置不满足：A1 需 Owner 选择+机制裁决，A2 未产出候选；沙箱 0 规则批准/0 规则激活。本轮不代 Owner 批准、不复制 DB、不在实库测试激活。
- 场景就绪度（可复跑）：`D:\Code\_pdtest\p1-final\sandbox`（protected/secret.txt 前置哈希 `3adc3af1…`、worklog.md `a21cdf4e…`、config.json `d84f7d98…`；网关配方=克隆 p1c 配置改端口/workspace 正斜杠；会话驱动 POST /v1/chat/completions）。获得批准对象后按任务 §六矩阵执行（Approval/Activation/Delivery=runtime_loaded/Application=runtime_verified/Episode/Effect/文件独立检查）。
- 诚实边界：本轮 OpenClaw 侧维持 10-10 已证范围（prompt delivery submitted + agent_claimed），**对强制证据链正确性不作任何断言**（从未执行）。

## 5. Owner 决策卡（本轮集中提交）

**决策卡 1 —— GJ-01 路径（阻塞 COMPLETE 的第一环）**
对象：§3-A1 所列实库 2 条已批准规则（mu2yt8y7 / mu3ayqqa，均 replay-passed、测试目录可触发）。为何不能代决：SPEC §13.9 指定 Owner 选择；且三条隔离机制均改变治理边界（实库写入/DB 复制豁免/等待新候选），超出验收者权限。选项：
- **A** 授权在实库 workspace 对指定测试目录做一次**有标记的测试激活**（真实链，测试会话证据入实账本，事后停用+披露）；
- **B** 授权对某一隔离测试环境**一次性豁免 §五 DB 复禁令**（复制实库到隔离盘做基础设施验证，明确不构成新批准）；
- **C** 先投资 A2 缺口修复（见决策卡 2），再走沙箱内候选→沙箱审批（10-10 先例路径）→GJ-01。

**决策卡 2 —— 规则表达性缺口（A2 根因）**
证据：本轮链两轮同败 v2-path-boundary（worklog.md.bak）；10-11 五链+本轮一链共 6 次内化未产出正式候选；失败已收敛到「读取≠授权 + 兄弟/变体路径拦截」需要跨调用或显式授权信号，而 RuleHost v2 契约是 stateless 单次 evaluate（PRI-508）。为何不能代决：涉及规则契约/宿主语义边界（是否引入授权标记、跨调用状态或 Owner 确认信号通道）=架构边界变更。可选：立项「读取-授权分离」契约设计（ADR 级）或调整 Owner 期望表达（确认语义可观察面）。

**决策卡 3 —— 重放拒绝原因语义缺陷候选（低危，可立单）**
现象：对已入库来源事件**原样重放**（同 session_id/turn_id/prompt），append 被拒：`evidence_batch_rejected:observation_contentRef_resolved_requires_payloadDigest`（nothing was written；raw source durable）。无重复（幂等目的达成），但**拒绝理由与「同键同内容幂等 no-op」契约不符**——首录时 contentRef 实为 unresolved（Q1 可见 4 条 revision 引用未解析）。建议：立单核查 producer/validator 在重放路径的 contentRef 解析状态与幂等分支（本报告不修码）。

## 6. 验收 C：Outcome、四问、重放、重启、失败边界

| 项 | 判定 | 证据 |
| --- | --- | --- |
| C1 Outcome 实宿主提交 | **NOT RUN** | 前提=B 线 Episode；全账本 episodes=0（无归属 gate 干预）。入口本身由 C4 路由回归覆盖（evidence-outcomes 9/9）。不编造 Owner 反馈、不以 task_outcomes 替代 |
| C2 四问（真实 Console，安装版运行时 3202→10-10 沙箱） | **PASS** | Q1（principle）：4 delivery（1 openclaw + 3 codex）+1 application（agent_claimed）+0/0/0，12 能力声明（6 openclaw+6 codex），coverage sourceStatus=available/valid；Q2（activation）：同链可从激活面追及；Q3/Q4（不存在的 episode/effect）：**诚实空集**+available（区分“未观察到”≠“从未发生”）；自述（agent_claimed）与 Runtime 事实（runtime_verified，0 条）分开呈现；**4 条未解析 revision 引用可见**（revision:<标题>，诚实暴露该原则无正式内容版本——同时是 §11 COMPLETE 标准的已知未闭项）。响应文件 `q1-principle.json`～`q4-effect.json` |
| C3a 重放幂等（真实路径） | **PASS（附缺陷候选）** | 以完全相同载荷经真实 pd-hook 再提交：记录数 5→5 不增；degraded 原因结构化（见决策卡 3） |
| C3b 重启可查 | **PASS** | 停 Console 3202→重启→Q1 重跑：计数/evidenceId 集合/coverage.observedFrom 逐项一致（`q1-after-restart.json`） |
| C4 失败边界（正式回归，main 构建） | **PASS** | `intervention-evidence.steps.test.ts` 6/6（BDD：submitted 不升 delivered、错误身份不成链、缺失返 Unknown、写失败不改 deny、更正/争议不改治理）+ `receipts-evidence-audit` 9/9 + `evidence-outcomes` 9/9 = **24/24** |

## 7. 验收 D：Codex 非空证据摄入 —— **PASS（按其支持范围）**

安装链（任务 §D1 全项记录）：repo commit `ce1ba2ca`（pin=0.5.1/0.8.1/1.291.2）→ npm 三包均已发布 → 官方流程隔离安装（marketplace=worktree → `codex plugin add` → `$pd-setup`）→ 实装 `.pd-runtime.json` 实测 = `adapter@0.5.1 + host-runtime@0.8.1 + core@1.291.2`（**与 pin 逐字一致**；10-11 轮实装为 1.291.1，本轮为 pin 终值的首次实测安装）。未手改任何安装文件。

真实摄入证据（任务 §D2 六项逐条）：

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | 确实选择了具体 Principle | 3 次 UserPromptSubmit（手动探针 + 真实会话 01a12b54 + 01a12b55）均选出唯一活跃激活 `act_prompt_0a54f406…` |
| 2 | 正确内容进入实际 hook 输出 | hook stdout `hookSpecificOutput.additionalContext` 逐字含 `<directive id="有后果变更前强制确认精确目标路径并前置校验闸门" source="runtime_v2_activation">` 及 MANDATORY 正文与自述行指令；真实会话日志可见注入块尾部进入上下文（`codex-session5.log` permissions 段） |
| 3 | durable receipt 存在 | evidence 行 sourceLocator=`codex-pd-hook-event-log:<session>`；原始 rollout jsonl 留存于 p1f sessions/ |
| 4 | 非空批次经 recorder→ingress→evidence ledger | `intervention_evidence_records` 2→5：`codex\|delivery\|agent_context\|<session>\|<turn>\|act_prompt_0a54f406…` ×3（真实会话 ×2 + 探针 ×1） |
| 5 | 能力声明按机制实际落库 | 6 条 `host_kind=codex` 声明随首批证据懒物化：agent_context_delivery=**supported(submitted)**；application_self_report=**Unsupported**（无通道）；enforcement/behavior/outcome/application_runtime_verified=**Unknown**（含 PRI-780 暂停注记）——与 10-11 记录的 recorder 契约一致，本轮为**实装实证** |
| 6 | 审计可按 Principle/Activation 查询 | §6 C2：Q1/Q2 从 principle/activation 两 selector 均追及全部 4 条 delivery |

诚实封顶：**Delivery 确认度=submitted**（hook stdout 编码即边界，宿主消费不可证）——不报 host_accepted/context_present（任务 §D2 规则遵守）。legacy trajectory 工具采集本轮未重跑（10-11 已证；session6 模型未发真实工具调用，read-only 语义下 Windows workspace-write 回落见 §9）。

**环境发现（复用价值）**：① codex exec 必须带 `--dangerously-bypass-hook-trust`，否则 plugin hooks **静默不执行**（无任何警告落盘——10-11「五 hook 触发」应即此配置；建议插件文档/pd-status 显式提示）；② Windows 下 `-s workspace-write` 回落 read-only（会话头实读 sandbox: read-only），需 `--dangerously-bypass-approvals-and-sandbox` 才能真实写（本轮隔离沙箱内使用）；③ codex 0.162.1 配置键迁移：`web_search` 为顶层字符串枚举（`"disabled"`），`[tools] web_search/view_image_tool` 被忽略——AMD 端点 2026-10-11 起强制拒绝含 web_search 工具的请求；④ adapter 的 0.147.0 hook 载荷契约（model/permission_mode/turn_id 必填）在 0.162.1 下仍被满足（hooks Completed + 证据入库）。

## 8. 失败边界汇总（任务 §十-7）

- 正式回归 24/24 绿（§6 C4）。
- 实宿主可观察边界：submitted≠delivered（能力声明 max_confirmation=submitted 实证）；错误/不存在 selector 返回诚实空集+available（Q3/Q4）；重放不重复（5→5）；自述与 Runtime 事实分离展示。
- `runtime_verified` 本轮零样本（enforcement 未执行）——**不以任何代理（含 10-10 agent_claimed）冒充**。

## 9. 环境过程披露（诚实清单）

1. **实库 state.db mtime 单次触碰**（21:07:37，恰逢本轮回合操作窗口）：前后两次只读盘点计数完全一致（approvals 57 / activations 32 / evidence 909），20s 观察窗无后续写入——判定为某次打开触发的 WAL checkpoint 类触碰，**零逻辑变更**；具体触发源未定位（同期操作：runtime init dry-run ×2、只读 better-sqlite3 查询）。如实记录，不掩盖。
2. 主仓 `D:\Code\principles\.pd`：本轮 `$pd-setup --ingest accept` 在 cwd=主仓时误写 ingestion consent（默认应关）。**已回退**（删除 consent 文件 + feature 显式 `enabled: false`）；`update-history.json` 为既有文件未动。
3. `~/.pd/install.json` workspaces 新增 2 条（主仓 + 10-10 沙箱，pd-setup 注册）；沿前轮处置保留待 Owner 清理（前轮 p1-acceptance/codex-ws、p1-closeout/codex-ws 条目仍在）。
4. 首次 `pd pain record` 在网关停止时挂起 2 分钟被中断（未落库）；重启网关后成功——「pain record 需网关在跑」为可复现环境行为。
5. 网关首启后修改沙箱 config 触发一次 `Workspace filesystem changed while preparing state` ——重试即自愈。
6. A2 沙箱 prompt 链 dreamer 孤儿 running 行（§3）。

## 10. 未执行项与原因

| 项 | 状态 | 原因 |
| --- | --- | --- |
| OpenClaw GJ-01 全链 | BLOCKED | 无可激活的已批准规则（§3/§4/决策卡 1） |
| Outcome 实宿主提交 | NOT RUN | 依赖 GJ Episode（§6 C1） |
| Codex legacy trajectory 重采 | NOT RUN | 10-11 已证非本轮 D 目标；session6 模型未发工具调用 |
| 为造绿修改任何期望/断言 | 未发生 | —— |

## 11. 完成标准矩阵（任务 §十一）与最终判定

| # | 标准 | 判定 |
| --- | --- | --- |
| 1 | ≥1 真实宿主 GJ-01 全链 | ✗ BLOCKED |
| 2 | 另一宿主真实接入+诚实披露 | **✓（本轮达成）**：Codex 非空摄入 PASS（§7），能力矩阵按实装契约披露 |
| 3 | Outcome+四问真实成立 | 部分：四问 PASS；Outcome NOT RUN |
| 4 | 完整链重放、重启可复核 | 部分：**真实数据重放/重启 PASS**；「完整链」无 Episode 可验 |
| 5 | 关键失败边界+适用回归 | ✓ 24/24 |
| 6 | 身份无未解析缺口 | ✗ 4 条 revision 引用未解析（可见、SPEC 允许，但 §11 完备标准未满足） |
| 7 | 源码/发布包/安装差异已解释 | ✓ §1（含「#1986 修复不在 npm 包」明示） |

**最终判定：Phase 1 维持 PARTIAL。** 相比 10-11：Codex 证据面从「0 行未实证」推进到「真实非空全链实证」（标准 2 首次达成）；A1 从「无可审批对象」精确到「实库 2 条对象+机制缺口」（决策卡 1）；A2 缺口从「实现缺陷已修待跑」收敛为「修复后代码上仍不收敛的表达性缺口」（决策卡 2）。到 COMPLETE 仍需：Owner 裁决策卡 1 → GJ-01 → Episode/Outcome → revision 引用解析 → 六条标准重判。

## 12. 证据索引（脱敏）与可重跑命令

证据根：`D:\Code\_pdtest\p1-final\`。无任何真实凭据；网关 token 为测试自造值。

| 证据 | 路径 |
| --- | --- |
| 10-10 沙箱前置快照 | `snapshot-p1-acceptance-sandbox-state-db-20261011.bak` |
| 真实会话请求/响应（OpenClaw） | `session1-resp.json`（chatcmpl_1333318a/fff1a50b）、`gw-p1f.log` |
| pain/诊断/内化链 | `pain-record.json`（painId manual_1791725051123_tijbp07y）、`run-rulehost.json`（stages+adversarialLoop+degradationReason=max_rounds_exhausted_after_2）、行为包 `behavior-examples-p1f-v2.json` |
| Codex 会话与 hook | `codex-session1/2/3/5/6.log`、`replay-probe-out.txt`（重放探针全输出）、rollout `~/.pd-p1test/codex-home-p1f/sessions/2026/10/11/` |
| 四问/重启 | `q1-principle.json`、`q2-activation.json`、`q3-episode.json`、`q4-effect.json`、`q1-after-restart.json` |
| 回归 | `c4-bdd.log`（24/24） |

可重跑要点：网关（OPENCLAW_STATE_DIR=openclaw-state-p1f + PD_WORKSPACE_DIR=沙箱 + `openclaw gateway`，POST /v1/chat/completions model=openclaw）；Console（`node ~/.pd/runtime/console/dist/server.js --workspace <ws> --port 3202 --no-auth`，GET `/api/v1/receipts/evidence-audit?type=…&id=…`）；Codex 会话（CODEX_HOME=codex-home-p1f，cwd=10-10 沙箱，**必带 `--dangerously-bypass-hook-trust`**）；内化链（worktree CLI `runtime internalization run-rulehost --pain-id … --behavior-examples … --timeout-ms 900000 --confirm`，跑前停网关）。

## 13. 测试实例停用与回滚

- 本轮**未创建任何新激活**，无需停用；10-10 既有激活维持原状（非本轮创建，处置权在前轮/Owner）。
- 已停：网关 18798、Console 3202/3201 系、全部 codex 进程；端口复核空闲。
- 已回退：主仓 `.pd` ingestion consent（§9-2）。
- 隔离目录可整体删除：`~/.pd-p1test/openclaw-state-p1f`、`~/.pd-p1test/codex-home-p1f`、`D:\Code\_pdtest\p1-final\`（建议 Owner 裁决后处置，快照优先）；10-10 沙箱保留（含本轮新增 3 条 codex 证据与 consent 文件——证据链完整性所需）。
- install.json 测试条目待 Owner 清理（§9-3）。历史沙箱 `p1-closeout/`、`p1-acceptance-r2/` 未动。
