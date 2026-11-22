# PD 宿主反馈链路只读审计报告（2026-11-17）

**范围**：Codex / WorkBuddy / OpenClaw 的反馈（痛苦信号与对话轨迹）从宿主进入 PD 后，是否存在**串工作区、丢证据、卡队列、误报结果**。以 PRI-1260..1266 为复现入口，PRI-1247/1248/1249 为安装与绑定先例。源码按 origin/main 核验，运行时按本机实际加载版本实测。

**审计性质**：只读。现有工作区仅观察；所有写入型验证均在 `.tmp/pd-feedback-audit-20261117/sandbox/` 隔离沙箱内（独立工作区 + 合成转录 + 本地假模型服务 127.0.0.1:8792）完成；生产库核对一律走快照副本（`.tmp/pd-feedback-audit-20261117/dbs/`）。

---

## 0. 两问总答

**Q1：哪些同类缺陷已在当前安装版本复现？**

| 工单 | 主题 | 当前安装版本（bundled-2.8.8）上的结论 |
|---|---|---|
| PRI-1260 | MCP 信号无会话关联/无证据 | ✅ **复现**（协议层拒绝一切会话字段；落库 `session_id='cli'`、`sessionIdHint=null`、`evidence=[]`、`unbound/missing_host_session`，与真实事故逐字段同构） |
| PRI-1261 | 超长记录卡检查点 | ✅ **复现 ×2**：Codex 沙箱端到端（停滞于偏移 1903，两周期零推进）；**WorkBuddy 同型分支实测**（安装版 decoder，停滞于 555） |
| PRI-1262 | 健康检查与运行时授权条件不一致 | ✅ **复现**（consent=revoked 时运行时仍 inserted=2，health 报 revoked；真实工作区活体同态 `flag_on_without_grant` 且当日仍在采集） |
| PRI-1263 | 准入拒绝误报账本失败 + 建议内化 | ✅ **复现**（trace `degraded/ledger_write_failed` + 顶层 nextAction 建议对被拒候选执行 internalize；成功对照 `succeeded/null`） |
| PRI-1264 | worker ready 但无周期 | ✅ **定因**：唯一常驻驱动（pd-companion）未运行——三工作区 liveness 协同停止于 09:15:40Z，审计时无任何 worker/companion 进程；**采集降级（catch_up degraded）不阻塞任务领取**（降级周期内 diagnostician 照常领取并 succeeded，沙箱+活体双证） |
| PRI-1265 | CLI/Codex/WB worker 缺轨迹读取器 | ✅ **复现（无懈可击版）**：会话已绑定（--session/--rollout-id/--host-turn-id 全通过 lineage 校验）、轨迹正文确实在库（operational 档 120 字符），Stage A 模型输入仍**不含该轮任何原文**（假服务全文断言 false） |
| PRI-1266 | 父运行 runtimeKind 写死 openclaw | ✅ **复现**（沙箱与真实库同型：父 run `openclaw`，三子阶段 `pi-ai`） |
| PRI-1247（已修） | 错绑其他宿主工作区 | ⚠️ **修复对默认目录有效**（F2 案例正确拒绝）；**新发现 N1：对非默认位置的其他宿主工作区不设防**（本机 OpenClaw 实际工作区 `D:\.openclaw\workspace` 恰为非默认，launcher 直接放行）。事故残留记录 `mcp_1794880713515_048c4c28` 仍在 OpenClaw 工作区库中 |
| PRI-1248（已修） | 同版本缓存重建丢绑定 | ✅ **修复验证有效**（载荷副本删除后 launcher 经 PLUGIN_DATA 持久副本正常握手） |
| PRI-1249（未修） | WB 绑定版本落后共享运行时 | ✅ **活体复现**（盘上绑定 0.4.1 vs 运行时 0.4.3 → `binding_version_mismatch` exit 1；仅改版本字段即恢复 → 证明唯一阻塞是版本门） |

**Q2：哪些路径仍缺少能阻止复发的测试？**（§5 汇总，含每项对应缺陷）

> 工单锚定的十个缺陷中，有七个的现有测试要么不存在、要么把缺陷行为钉死为预期；另有三个新缺陷（N1–N3）完全无测试。

---

## 1. 现场基线（谁提供事实、实际加载的是什么）

| 事实 | 值 | 取证 |
|---|---|---|
| 代码基线 | origin/main `9dd5b01f9`（本地检出 7b5fd0273 落后 9 提交；工单锚点行号与 origin/main 一致） | `git rev-parse origin/main` |
| 安装身份 | `~/.pd/active.json`：releaseId `bundled-2.8.8-2d0fdd27f45b`，**sourceCommit `57948395d`**（= origin/main 的 version-packages 提交）→ **本机运行时就是 origin/main 代码，含 #2690（PRI-1247/1248 修复）**；generation 93，安装事务 2026-11-17T08:07Z | active.json |
| 组件版本 | pd-cli 2.8.1 / codex-adapter 0.12.1 / workbuddy-adapter 0.6.7 / host-runtime 4.4.0 / core 7.10.1 / install-layout 0.8.3 / **pd-mcp-server 0.4.3**（= npm latest，逐一核对） | `~/.pd/runtime/*/package.json` + `npm view` |
| Codex 插件 | 缓存 **0.3.42**（修复版）；PLUGIN_DATA 持久绑定在位（mcpServer 0.4.3 / core 7.10.1，writtenAt 11-17T08:09Z），runtimeDir=插件自带 runtime | `~/.codex/plugins/...` |
| PATH `pd` | `~/bin/pd` → `~/.pd/runtime/bin/pd.cmd`（即安装运行时；`pd --version` 的 2.8.8 是 release bundle 版本，与组件版本独立编号——version-report.js 读 active.json，非 bug） | shim 内容 |
| OpenClaw | 扩展 4.1.8；**实际工作区 `D:\.openclaw\workspace`**（openclaw.json:29 显式配置，非默认目录）；绑定 mcpServer 0.4.3=运行时一致；插件 `hooks.allowConversationAccess: true` | openclaw.json + mcp-binding.json |
| Codex | 实际工作区 `C:\Users\Administrator\.codex\pd-workspace`；**codex.exe（app-server）在运行，PD MCP launcher 存活（PID 2676，19:07 启动，父进程 codex.exe）** | 进程枚举 |
| WorkBuddy | 桌面在运行；工作区 `~/.workbuddy/pd-workspace`；**marketplace 绑定仍为 0.4.1**（writtenAt 11-13）vs 共享运行时 0.4.3 —— PRI-1249 活体状态 | mcp-binding.json |
| 调度驱动 | **pd-companion 未运行**；无任何 `codex worker`/`workbuddy worker` 进程；三工作区 `codex-worker-liveness.json`（文件名由 worker 实现固定，非串写证据）协同停止于 09:15:40–44Z；Codex worker 末周期 `degraded catch_up:01a1d5c0` | 进程枚举 + liveness 文件 |

**生产库快照核对（只读副本）**：工单实体全部在场——任务 `diagnosis_mcp_1794913741967_235379ba`（diagnosticJson `sessionIdHint=null / evidence=[] / unbound`）、候选 `b9d7b954`（pending + admission `needs_evidence confidence_below_threshold:0.45<0.5`）、检查点 `01a1d462`(offset 4192462/lag 2.7MB) 与 `01a1d813`(offset 1341806/**lag 80.8MB**，盘上文件已 82MB)、pain_diagnoses 的 evidence_json 自述"conversationWindow 两条目文本为空，缺乏原始行为证据"。

---

## 2. 四个交接点的验证

### 2.1 安装 → 启动 → 实际工作区

launcher 矩阵（真实安装版 launcher + 沙箱绑定副本 + 真实运行时入口；MCP stdio 握手 initialize→tools/list；`evidence/gate1-*.json|txt`）：

| 案例 | 配置 | 结果 | 判定 |
|---|---|---|---|
| P（codex 正例） | 双副本绑定→ws-audit | 握手 OK，tools=`[pd_recall_principle_pains, pd_submit_pain]`，提交落库 ws-audit（pain_events + tasks，workspaceDir 逐字节吻合） | ✅ 启动指纹→实际库一致 |
| **F（错绑→非默认 OC 工作区）** | 绑定 `D:\.openclaw\workspace` | **握手 OK 并启动**（workspaceFingerprint `8c8d0c900b0c…` = O2 案例同值，证明服务的就是 OpenClaw 工作区） | ❌ **新缺陷 N1** |
| F2（错绑→默认 OC 目录） | 绑定 `~/.openclaw/workspace` | `binding_workspace_foreign_host:openclaw` + exit 1，零服务器启动 | ✅ 修复对默认目录有效（差分证明） |
| R（PRI-1248 正例） | 载荷副本删除，仅 PLUGIN_DATA | 握手 OK | ✅ 持久副本机制有效 |
| W（PRI-1249 活体） | WB 市场副本原样 0.4.1 | `binding_version_mismatch:0.4.1!=0.4.3` + exit 1，无握手 | ❌ 未修缺陷复现 |
| W2（W 对照） | 仅版本字段改 0.4.3 | 握手 OK | 证明唯一阻塞=版本门 |
| O（openclaw 非声明工作区） | 绑定 ws-audit | `binding_workspace_not_declared` + exit 1 | ✅ OpenClaw 专属声明匹配门（Codex/WB 无对等物） |
| O2（openclaw 正例） | 绑定声明工作区 | 握手 OK | ✅ |

**N1 细节**：`launcher.cjs hostOwnedWorkspaces()`（镜像 install-layout `findForeignWorkspaceHost`）只枚举**默认**目录（openclaw=`~/clawd`,`~/.openclaw/workspace`；codex=`<codexHome>/pd-workspace`；workbuddy=`~/.workbuddy/pd-workspace`）。本机 OpenClaw 实际工作区在 `D:\.openclaw\workspace`——**PRI-1247 事故的真实写入目标**——不在清单内，launcher 放行。安装侧同样暴露：`env.ts detectWorkspace({host:'codex'})` 候选顺序为 codexHome/pd-workspace → 最近含 `.pd/config.yaml` 的项目 → cwd；`D:\.openclaw\workspace` 自带 `.pd/config.yaml` 且非默认目录，可成为候选且过滤不掉。

**待证实**（未执行项）：安装器级全链（隔离 USERPROFILE/CODEX_HOME 跑真实 `create-principles-disciple --host codex`、cwd 置于 OpenClaw 工作区内）——避免触碰真实 install manifest 与大体积安装未执行；代码路径已核，观察点缺失仅为"安装器实测指纹"。

### 2.2 宿主身份与授权 → 原始证据

**PRI-1260（复现，`evidence/gate2-*.json`）**：
- 带会话元数据提交（sessionId/threadId/score）→ MCP 输入 schema `additionalProperties:false`（server.ts:117-145）协议层拒绝："data must NOT have additional properties"×3，**字段根本无法到达 handler**；
- 干净提交 → 回执 `submitted`，回执**含** `context_unbound` 明确警告（回执能指出中断原因——验收的回执面合格）；
- 落库（沙箱）与真实事故逐字段同构：`pain_events.session_id='cli'`、`host_kind='codex'`、task diagnosticJson `sessionIdHint=null / agentIdHint=null / evidence=[] / correlation unbound,missing_host_session / evidenceClass unavailable,not_applicable_unbound`。
- 源码事实：pd-mcp-server 不读任何会话字段；`pain-submit-capability.ts:247-249` 固定写 unbound；bound+带证据的写法只存在于治理钩子路径（governance-signal-admission.ts:581/2291-2310）。

**PRI-1262（复现，`evidence/gate3-driver-output.txt`）**：
- 沙箱：v3 consent=**revoked** 在盘 → `ingestCodexTranscriptFromPath` 照常执行且 **inserted=2**（codex 运行时 `ingestion.ts:246` 固定传 `granted`，仅文本策略读台账）；`pd health --host codex` 同工作区报 `consent.state=revoked`（health-codex.ts:405-428 真实读台账）。运行时与健康判定分歧实证。
- 缓解层事实：非 granted 时正文策略降为 bounded、`expired` 保留档**写入时即置 NULL**（真实库 305 条 expired user_turn 全部无正文，operational/promoted 132+19 全有正文）——即"采集不停止但正文扣留"。WorkBuddy 无此分歧（wb ingestion 真实读 consent，非 granted 即 skip）。

### 2.3 转录 → 检查点 → 任务调度

**PRI-1261 Codex 端到端（复现，`evidence/gate3-*.txt|json`）**：合成 rollout（4 条正常行 → **1,500,213 字节超限完整行@1903** → 18 条后续可采集轮次 → 未完成尾部），安装版 `ingestCodexTranscriptFromPath` 直驱（catch-up 同款生产函数）：
- pass1：窗口 1 正常行入窗，`ok` 推进至 1903（byte_bound）；
- pass2/pass3：整窗无换行 → `transcript_record_too_large`，**nextByteOffset 恒 1903，零推进**——超限行之后的所有完整轮次（真实用户轮、assistant 轮、tool 桥）**永久阻塞**；
- 真实工作区同态：两检查点 `transcript_record_too_large`，`01a1d813` lag 80.8MB 且当日（09:15:44Z）仍在重复撞同一窗口。

**正例与幂等（对照，全部通过）**：
- 未完成尾部：截断行无尾换行 → 暂态持有（lagBytes=203，两周期零重复）；补齐尾部后一次性消费（lagBytes→0），重跑零新增零重复（logical_key + transcript_record_key 双去重实证）；
- 附带发现：截断行**带**尾换行会被判 `transcript_record_malformed`（稳态、可 quarantine），与暂态尾部是两条不同降级路径，行为自洽。

**WorkBuddy 同型分支（实测复现，`evidence/gate3-wb-decoder.json`）**：安装版 `decodeWorkbuddyTranscriptWindow`——窗口 1 正常行 1 条入观察、推进至 555；窗口 2/3（超限行体内）`oversized_record`、nextByteOffset 恒 555。工单"尚未在该宿主实测"一项就此闭环（decoder 级；wb 管线与 codex 共用 host-runtime pipeline，codex 已端到端）。

**任务调度（PRI-1264 定因）**：
- 活体：worker `mode=ready, registeredInInstallManifest=true` 与 liveness `verdict=no_recent_cycle`（审计时 age≈2.8h）并存；**无 companion、无 worker 进程**——三工作区 liveness 同秒协同停止＝单一驱动（pd-companion）消失；
- 沙箱控制实验（`evidence/g4-s4-worker-once*.json`）：制造"pending 诊断任务 + catch_up degraded（超限 rollout 在场）"，`pd codex worker --once` 单周期内 **catch_up degraded 与 diagnostician 领取执行并存**（`diagnostician:{taskId,status:succeeded}`）——降级不阻止领取，工单怀疑的"采集降级→停调度"因果链被否定；
- 代码佐证：周期早退分支仅 host flag / capability / consumer flag（workspace-worker.ts:241-306），`catchUp.status` 只汇入上报 mode（:515-524）。

### 2.4 任务 → 诊断 → 准入 → 状态展示

假模型服务（127.0.0.1:8792，SSE，按 `response_format.json_schema.name` 分阶段返回固定 JSON；`fake-llm.cjs` + `evidence/g4-*.json`）：

| 场景 | 构造 | 结果 |
|---|---|---|
| S1 准入拒绝 | CLI pain（无 owner statement），conf 0.45 | 候选 pending + admission `needs_evidence: confidence_below_threshold:0.45<0.5`；`pd trace` → **`degraded / ledger_write_failed`**（误报复现）；diagnose 顶层 nextAction → **"pd candidate internalize --candidate-id …"**（徒劳建议复现）；exit 1 |
| S2 成功对照 | + `--owner-statement`，conf 0.85 | admitted + 账本条目 `d1060eb5…`；trace → `succeeded / failureCategory:null`（读模型**能**区分成功，只是不区分"拒绝 vs 写失败"） |
| S2b 绑定会话（PRI-1265） | `--session/--rollout-id/--host-turn-id` 全通过 lineage；rollout E 时间戳改写为当前（operational 档，正文 120 字符在库） | 诊断 succeeded；**Stage A 模型输入全文断言：不含用户轮原文、不含 assistant 轮原文**（`hasFixtureUserTurn:false` 等）——正文在库、会话已绑、模型仍看不到。根因：`diagnose.ts:393` 构造装配器未传 `trajectoryTurnReader`（全树唯一注入点=openclaw-plugin hooks/pain.ts:52-68）；assembler L191 三条件门静默跳过 |
| S3 真实账本写失败 | `--no-intake` 产候选 → state.db 设只读 → `candidate internalize` | exit 1 + **裸 `SqliteError: attempt to write a readonly database` 栈**（无 JSON、无 reason/nextAction）；该候选 trace 同样 `ledger_write_failed`——与 S1 拒绝**同分类** |
| S1266 kind 错标 | 所有场景 | 父 run `runtime_kind='openclaw'` vs 三子阶段 `pi-ai`（沙箱表 `g4-sandbox-run-kinds.json`；`--preflight` 正确报 `runtimeKind: pi-ai`）；源码 `split-diagnostician-runner.ts:256` 写死 |
| 腿覆盖 | `pd pain retry`（S1r） | 重试路径同样无 reader、同样产出"拒绝+徒劳建议"（pain-retry.ts:621 同型构造点） |
| worker 腿 | S4 | worker 经 factory 跑诊断（reader 同缺，PRI-1265 覆盖 codex worker 构造点 :323/:404、wb worker :237） |

---

## 3. 新缺陷（此前无工单覆盖）

### N1｜错绑防护只认"默认目录"，非默认位置的其他宿主工作区直接放行（PRI-1247 同族，建议重开 PRI-1247 或开新 P1）
- **最小复现**：`.tmp/.../gate1-mcp-driver*.mjs` 的 F vs F2 差分——同一 launcher，绑定 `D:\.openclaw\workspace` 启动成功（fingerprint 8c8d0c…），绑定 `~/.openclaw/workspace` 拒绝。
- **用户影响**：PRI-1247 原事故形态（Codex MCP 写入 OpenClaw 工作区）在"宿主工作区不在默认位置"的机器上可完整重演；本机恰是此形态，事故残留 `mcp_1794880713515_048c4c28` 仍在 OpenClaw 工作区 `trajectory.db`（按 DATA_CLEANUP 默认保全，处置留 Owner）。
- **能失败的验收用例**：绑定指向"存在、可读、由 openclaw.json 配置但非默认路径的 OpenClaw 工作区"时，launcher 应拒绝（现启动成功→测试红）。
- **位置**：`plugins/principles-disciple/mcp/launcher.cjs hostOwnedWorkspaces()`（三份 launcher 字节相同）+ install-layout `findForeignWorkspaceHost` + `create-principles-disciple/src/utils/env.ts` 候选过滤。

### N2｜`pd candidate internalize` 不检查准入门，为被拒候选排入内化任务（并入 PRI-1263 验收范围）
- **最小复现**：S1 被拒候选（`needs_evidence`）执行 internalize → 返回 `status:'created'`（dreamer-<id>-prompt 任务入列），exit 0；候选仍 pending。
- **用户影响**：diagnose 的顶层 nextAction 恰恰引导执行该命令（PRI-1263）；工单假设"该命令会重新执行准入检查"实际不成立——它**静默排任务**而非拒绝。下游 dreamer 执行是否再设门未测（任务停在 pending）。
- **能失败的验收用例**：对 admission_json=needs_evidence 的候选执行 internalize 应 refused（现 created→测试红）。
- **位置**：`pd-cli/src/commands/candidate.ts:331 handleCandidateInternalize`（无任何 admission 检查；准入检查在另一命令 `handleCandidateIntake`）。

### N3｜账本路径真实写失败无结构化失败面（cli-6 / rc-9 违例）
- **最小复现**：S3——state.db 只读后 `pd candidate internalize` → 裸 SqliteError 栈、exit 1、无 reason/nextAction。
- **用户影响**：故障可诊断性——操作者只见栈不见"下一步"；与 N2 叠加时（同一命令）行为分裂。
- **能失败的验收用例**：库不可写时 internalize 应输出结构化 refused/degraded（reason + nextAction）（现裸栈→测试红）。
- **说明**：diagnose 内联阶段的账本写失败需进程内故障注入，未执行（见 §4）。

### 观察（不计缺陷）
- MCP 入口在当前准入政策下**结构性必然被拒**：provenance=agent_reported + inputEvidenceCount=0 + 无 ownerStatement → 无论 confidence 多高均 `needs_evidence`。与 PRI-1260 叠加＝"MCP 提交只能造出必被拒的候选"。这是政策使然还是入口设计缺口，属产品决策（工单 1260 验收已覆盖"缺证据时的明确原因"）。
- `pd codex worker --once` 在 degraded 时 exit 1（脚本/CI 语义陷阱，与 PRI-1222 同族）。
- OpenClaw launcher 有声明工作区匹配门（`binding_workspace_not_declared`），Codex/WorkBuddy 无对等物——非缺陷，但解释了三宿主防错绑强度差。

---

## 4. 待证实清单（源码有同型分支/断言，本轮未取得直接观察）

| 项 | 缺的观察点 | 已有证据强度 |
|---|---|---|
| N1 安装器级全链 | 隔离 HOME 下真实 installer 实测绑定指纹 | 代码路径全核（env.ts 候选序 + hostOwnedWorkspaces 清单）+ launcher 级差分实测 |
| OpenClaw hook 侧 reader 正例 | 需 OpenClaw 网关真实会话 | 代码锚点（hooks/pain.ts:52-68 唯一注入点）+ e2e 测试引用 |
| WorkBuddy 管线级超长行 | wb catch-up/pipeline 端到端 | decoder 级实测复现 + 与 codex 共用 host-runtime pipeline（codex 已端到端） |
| PRI-1249 官方更新链修复 | WB 0.4.1→共享 runtime 升级推进绑定 | 属工单验收实施工作；W2 证明仅版本门阻塞 |
| diagnose 内联账本写失败 | 进程内故障注入 | internalize 腿已测（N3） |
| companion 停止的精确原因（09:15:40Z） | companion 自身日志/退出记录 | 驱动缺失事实已证（进程枚举+liveness 协同停止）；为何停止（人为关闭/崩溃）无日志可考 |

---

## 5. 测试缺口（能阻止复发的用例清单）

| # | 缺口 | 对应缺陷 | 应存在的失败用例（现缺/现钉死） |
|---|---|---|---|
| T1 | oversized 后续窗口端到端 | PRI-1261 | "超限行之后的完整轮次应可入库（或显式跳过+可恢复路径）"——现 `transcript-decoder.test.ts:204` 断言 `nextByteOffset===0` **把停滞钉死为预期**；wb :192 同型 |
| T2 | Codex 运行时 consent 门 | PRI-1262 | "consent revoked/缺失时 codex 采集应 skip（wb 有 ：168/:179 用例，codex 零条）" |
| T3 | liveness/no_recent_cycle 判定 | PRI-1264 | 全树无任何测试触及 `no_recent_cycle`/`lastCycleCompletedAt` |
| T4 | 装配点 reader 契约 | PRI-1265 | "diagnose/pain-retry/codex worker/wb worker 构造 bridge 必须传入可用 reader"——C3 用例只测装配器自身降级，无构造点契约 |
| T5 | 拒绝≠账本失败分类 | PRI-1263 | pain-chain-read-model 无 "admission 拒绝（pending+needs_evidence）不得记 ledger_write_failed" 用例；`pain-chain-read-model.test.ts:226` 只钉 consumed 缺 ledger |
| T6 | 顶层 nextAction 排除 | PRI-1263 | diagnose.test.ts 只有 parked 排除用例（INTAKE-02b），无 admission-refused 排除 |
| T7 | 父 run runtimeKind | PRI-1266 | `split-diagnostician-runner-retry.test.ts:390` **断言 `runtimeKind:'openclaw'`**——把写死值钉死 |
| T8 | launcher 非默认目录 foreign 检查 | N1 | parity 测试 fixture 全为默认目录（`mcp-binding-contract-parity.test.ts:340-376`） |
| T9 | internalize 准入门 | N2 | 无 |
| T10 | 库写失败结构化面 | N3 | 无 |
| T11 | WB 升级刷新腿失败→绑定停留旧版 | PRI-1249 | `workbuddy-profile-routing.test.ts:781` 只测刷新成功侧 |
| T12 | MCP 提交利用会话元数据 | PRI-1260（修复方向） | 现有测试全部钉死"拒绝读取"（submit-tool.test.ts:181 等）——修复时这些是行为变更清单 |

---

## 6. 方法、边界与披露

- **隔离**：沙箱工作区 `ws-audit`（自带 config/库/consent 台账）、`CODEX_HOME` 指向合成 sessions、假模型服务 127.0.0.1:8792（服务端记录每次模型请求全文断言）。launcher 测试用安装版 launcher 副本+沙箱绑定，runtime 入口为真实安装文件（只读使用）。
- **对真实工作区的触碰披露**：① O2 案例（OpenClaw 正例握手）使真实 OpenClaw 工作区 `.state/logs/daily-stats.json` 更新——服务器启动遥测，与网关日常重启同级，配置/绑定/数据库未动；② 只读 CLI 探针（health/task/run/trace/worker --status）按其设计向工作区 `.state/logs` 追加事件日志——与工单自身的复验操作同类。WorkBuddy 工作区零触碰。
- **stream 纯度**（cli-1）：`--json` 命令的 stdout 均为单一 JSON；workspace 警告走 stderr（验证）。
- **血缧行为正例**（顺带实证）：`--host codex` 缺 `--rollout-id/--host-turn-id` 时 fail-loud（`codex_lineage_required`）；假模型响应中 artifact id 截断被 `sourceRootCauseArtifactId mismatch` 精确拦截（rc-6）。
- **复现脚本与证据**：全部在 `.tmp/pd-feedback-audit-20261117/`（gitignored）——`mksandbox.cjs`（夹具）、`gate1-setup.cjs`/`gate1-mcp-driver*.mjs`（绑定矩阵）、`gate3-ingest-driver.mjs`（采集）、`gate4-rolloutE.mjs`（正文在库证物）、`fake-llm.cjs`（假服务）、`evidence/`（22 份原始输出）、`dbs/`（三工作区只读快照）、`query-*.cjs`（快照查询）。
- **未执行项**：§4 全表；真实宿主故障注入；WorkBuddy Desktop 真实 .mcp.json 握手（其注册探针属 PRI-1249 验收实施）。

## 7. 收口对照

| 交接点 | 结论 |
|---|---|
| 安装→启动→工作区 | 正例全通；N1（非默认目录错绑放行）+ PRI-1249（版本门拒启）为两个真实缺口；PRI-1248 修复验证有效 |
| 身份与授权→原始证据 | PRI-1260/1262 复现：MCP 入口证据结构性缺席；Codex 授权"健康面/运行时"分歧（有正文扣留缓解）；回执原因链合格 |
| 转录→检查点→调度 | PRI-1261 双宿主复现（永久阻塞+80MB 活体积压）；尾部/幂等/去重正例全过；PRI-1264 定因为驱动缺失而非降级耦合 |
| 任务→诊断→准入→展示 | PRI-1263/1265/1266 复现；N2/N3 新缺陷；成功链路（S2）与血统/校验防线（lineage、rc-6、malformed 分级）行为正确 |
