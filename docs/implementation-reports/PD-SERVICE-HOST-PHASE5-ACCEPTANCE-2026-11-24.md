# PD Service Host Phase 5 — 本地环境迁移验收报告

- **日期**：2026-11-24
- **执行载体**：WorkBuddy 本地代理（Windows / Administrator）
- **PD 安装**：Principles Disciple 2.8.11，Active Release `8643c8076189646376bef0a3e63edf9d1f80b90dd73a62bdd88ff9475d38e701`
- **工单**：PRI-1278（In Review，未关闭）
- **本报告结论**：**Phase 5 未完成**。Codex / WorkBuddy 两个 Workspace 的所有权**未切换**，仍为 `legacy_owned`。理由见 §5 与 §15。

> 判定依据：本报告只写入有可复现命令输出或文件证据支撑的事实。缺失能力一律标注为「未实施」，不以分析代替交付。

---

## 1. 原始环境基线（迁移前）

采集时间 2026-11-24T01:58Z。原始产物：`D:/pd-phase5/01-baseline/`。

| 维度 | 实测值 | 命令来源 |
|---|---|---|
| 产品版本 | 2.8.11 / generation 106 | `pd version --json --delivery` |
| 组件版本 | core 8.1.0 / pd-cli 2.11.0 / host-runtime 4.6.0 / plugin 4.3.0 / codex-adapter 0.14.0 | 同上 |
| Scheduler | registered=true, enabled=true, interval 120s, task `PrinciplesDisciple-ServiceHost-ae32ea21f7` | `pd service status --json` |
| 最近 Scheduler 执行 | `osLastRunAt=2026-11-24T09:57:17+08:00`, `osLastResult=0` | 同上 |
| 最近 managed run | `b7166e86-…` outcome=completed, `triggerSource=scheduler` | 同上 |
| `lastProgressAt` | `null`（**不作为成功或失败判据**，见 §10） | 同上 |
| 重复 Consumer | 0（无 worker 子进程、无 Companion 进程） | `Get-CimInstance Win32_Process` |

Workspace 所有权基线：

| Workspace | discovery | ownerState | effectiveOwner |
|---|---|---|---|
| `C:\Users\Administrator\.codex\pd-workspace` | authorized | legacy_owned | legacy |
| `C:\Users\Administrator\.workbuddy\pd-workspace` | authorized | legacy_owned | legacy |
| `D:\.openclaw\workspace` | authorized | service_host_owned | service_host (generation 2) |
| `C:\Users\Administrator\clawd` | discovered | legacy_owned | legacy |
| `C:\Users\Administrator\.openclaw\workspace` | discovered | legacy_owned | legacy |

安装清单 `~/.pd/install.json` 的 `backgroundExecutions` **只有** `D:\.openclaw\workspace` 一条记录（generation 2）。这是「其余两个 Workspace 未迁移」的权威事实来源。

### 1.1 两个 Workspace 的原始故障

**Codex**（`pd health --host codex`，`ready=false`，3 个 blocker）：

- `consent: flag_on_without_grant` — 采集开关开着但没有 Consent 记录
- `rollout: 01a1d813-… lag=80785530B`
- `codexCliVersion: unverified_above: 0.169.1`
- `mcp.status=RESTART_REQUIRED`（`binding_written_after_newest_codex_session_started`）

**WorkBuddy**：

- `pd workbuddy worker --status` → `mode=degraded`，`reason=pd_config_invalid:missing required field runtimeProfiles`
- `.pd/config.yaml` 仅 **24 字节**：`version: 1` + `features: {}`
- `.state/trajectory.db` 仅 **22 字节**，内容为 ASCII `sqlite-governance-data`（非 SQLite）
- `ingestion.*.checkpoints` → `trajectory_database_unavailable:file is not a database`

---

## 2. Codex 环境修复报告

### 2.1 Conversation Consent —— 已修复（Owner 决定）

按指令不得代为授权，已将官方冻结披露全文呈现给 Owner（`pd codex setup --show-disclosure --lang zh`），Owner 选择「接受授权」，随后执行正式流程：

```
pd codex setup --accept --workspace ~/.codex/pd-workspace --json
→ {"status":"ok","decision":"granted","consentStateBefore":"flag_on_without_grant",
   "consentState":"granted","disclosureVersion":"g2b-2026-11-12",
   "ingestionFlag":{"name":"codex_conversation_ingestion","enabled":true,"source":"user_config"}}
```

原始输出：`D:/pd-phase5/02-codex/consent-accept.json`。未直接写 Consent 数据库，未改 flag 冒充授权。

### 2.2 Transcript Lag 80,785,530 B —— 已定性，未清零

**调查结论（与「数据已丢失」的假设不同）：数据存在，是超大记录 + 压缩格式两个独立原因。**

| 检查项 | 结果 |
|---|---|
| Codex HOME 是否变化 | 否，`CODEX_HOME` 未设置，默认 `~/.codex` |
| Rollout 文件是否存在 | **存在**：`~/.codex/sessions/2026/11/14/rollout-2026-11-14T11-21-44-01a1d813-….jsonl`，82,127,336 B |
| 尺寸恒等式 | `byteOffset 1,341,806 + lagBytes 80,785,530 = 82,127,336` → 与文件大小**精确相等** |
| 卡住位置的记录 | offset 1,341,806 起，`event_msg/item_completed/image_gen.generation`（含 base64 图像），长 **2,101,992 B**，**有终止换行** |
| PD 批处理窗口 | `CONVERSATION_INGESTION_MAX_BATCH_BYTES = 1 MiB` → 2.1 MB 记录必然判定 oversized |
| checkpoint 是否推进 | **已推进**：跑一次真实 Cycle 后 `1,341,806 → 3,443,798`（= 记录终止换行+1），`updated_at=2026-11-24T02:25:20Z` |

即：已安装 2.8.11 的「跳过完整超大记录」逻辑有效，lag 每 Cycle 约消化 2 MB。**未清零 byteOffset、未删 checkpoint、未标记 lag 为成功。**

**第二个原因（未修复，属能力缺口）**：4 个 checkpoint 中 3 个报 `catch_up_transcript_missing`：

- `01a1d5c0`、`01a1d5df` — 磁盘上确实不存在
- `01a1d462` — 仅存在 `rollout-2026-11-13T18-10-06-01a1d462-….jsonl.zst`

Codex CLI 会把旧 rollout 压成 `.jsonl.zst`：本机 **318 个 `.jsonl.zst` vs 21 个 `.jsonl`**。`packages/codex-adapter/src` 与 `packages/host-runtime/src` 中 **没有任何 zstd 处理代码**（`git grep -i "zst|zstd"` 零命中）。因此这 3 个 checkpoint 会永久停在 `transcript_missing`——不是数据丢失，是**格式不支持**。

处置：按数据保护要求保留原状，未伪造、未重置。列为后续候选（§15）。

### 2.3 Codex CLI 兼容性 —— 已定性，未篡改

- 健康报告里的 `0.169.1` 来自**历史 rollout 元数据**，不是当前 CLI。
- 当前实际：`codex-cli 0.171.0`（`codex --version`）。
- PD 验证契约：`codexIngestionVerifiedVersion = 0.167.0`，最低 `0.148.0`。
- 结论：当前 CLI 高于已验证版本 4 个 minor。未修改任何版本检查结果，未绕过 blocker。Conversation Ingestion 之外的面（Hook、Worker、MCP）经实测可用（§2.4、§10），符合「Hook enforcement surfaces are separate」的设计声明。

### 2.4 MCP —— 静态 RESTART_REQUIRED，运行时握手已实测通过

- `codex mcp list` → `pd-recall` 已注册、`enabled`，cwd `~/.codex/plugins/cache/principles/principles-disciple/0.3.51/`。
- `pd mcp probe --host codex --timeout-ms 20000` → **ok=true**，`initialize` + `tools/list` 成功，工具 `["pd_recall_principle_pains","pd_submit_pain"]`，`workspaceMatchesRequest=true`。
- 默认 10 s 超时下会超时（冷启动），20 s 通过——这是探测预算问题，不是绑定问题。
- `staticStatus` 仍为 `RESTART_REQUIRED`：需要**下一次真实 Codex 会话进程**读取新的 `mcp-binding.json` 才会清除。本机当前无 Codex 会话在跑，无法在不干扰用户的前提下伪造这一事实。

---

## 3. WorkBuddy 环境修复报告

### 3.1 `runtimeProfiles` 缺失 —— 已修复并通过命令验证

**根因不是配置写错，而是配置被测试夹具覆写**（详见 §4.1）。

处置（可逆、留证）：

1. 备份损坏文件：`config.yaml.damaged-20261124T100353.bak`（24 B）
2. 用安装器自己写的备份 `config.yaml.bak-20261113`（1,502 B）恢复——该文件包含合法的 `runtimeProfiles.pd.default`（type=pi-ai / provider=openai / model=DeepSeek-V4-Flash-Vision-Exp / apiKeyEnv=AMD_RADEON_API_KEY / baseUrl=…）、`openclaw.default`、`internalAgents`、`ui`、`feedback`
3. 未手工编造 profile；全部字段来自安装器产物

验证：

```
pd workbuddy worker --status --json
→ {"mode":"ready","registeredInInstallManifest":true, …}
```

`degraded → ready`，`pd_config_invalid` 消失。

MCP 侧同样恢复：`pd mcp probe --host workbuddy` 由「仅 1 个工具、`submitTool=disabled`、`reasonCode=pd_config_invalid`、`errorCount=2`」变为：

```
ok=true, tools=["pd_recall_principle_pains","pd_submit_pain"],
submitToolPresent=true, workspaceMatchesRequest=true, 无 warn
```

### 3.2 真实 Worker Cycle —— 已执行成功

```
pd workbuddy worker --once --json --workspace ~/.workbuddy/pd-workspace
→ mode=ready
  reconcile.ok=true, tasksEnsured=0, degradations=[]
  stage2.ok=true, classifier=used, degradations=[]
  catchUp.status=skipped (feature_disabled — 采集开关未开，符合预期)
```

`.state/workbuddy-worker-liveness.json` 写入 `lastCycleMode=ready`，`lastCycleDriver=manual`。

---

## 4. Trajectory 数据恢复报告

### 4.1 损坏成因（已锁定，可复现）

损坏文件与 `packages/create-principles-disciple/tests/uninstall-host-scoped.test.ts` 的夹具字节**完全一致**：

| 真实文件 | 字节数 | 夹具 |
|---|---|---|
| `.pd/config.yaml` | 24 | `'version: 1\nfeatures: {}\n'` |
| `.state/trajectory.db` | 22 | `'sqlite-governance-data'` |

泄漏链条：

1. `seedThreeHosts()` 在 `makeLab()` **之前**调用 `getWorkbuddyWorkspaceDir(sandbox)`；
2. `resolvePdHome()` 把 `WORKBUDDY_CONFIG_DIR` 排在显式 `homeDir` **之前**；
3. WorkBuddy 宿主进程会把 `WORKBUDDY_CONFIG_DIR=C:\Users\Administrator\.workbuddy` 注入每个子 shell；
4. 于是「沙箱」解析成真实用户目录，夹具写进生产库。

实测复现（非推测）：

```
node -e "il.getWorkbuddyWorkspaceDir('<临时沙箱>')"
→ C:\Users\Administrator\.workbuddy\pd-workspace   # 期望 <沙箱>\.workbuddy\pd-workspace
```

时间线证据：文件系统上 **2026-11-22 该目录只有这两个文件被改动**；`.state/trajectory-retention.json` 的 `lastRunAt=2026-11-21T07:16:28Z` 证明前一天数据库仍在正常使用。

**本次执行期间该缺陷再次触发**：2026-11-24 10:29 在未修复副本上运行该测试，两个文件被第二次写成同样的夹具字节（mtime 10:29）。这既是一次事故，也是缺陷仍然活跃的直接证据。

### 4.2 恢复结论：历史轨迹不可恢复（Owner 已确认接受）

已穷举的恢复来源：

| 来源 | 结果 |
|---|---|
| canonical `trajectory.db` | 22 B 占位串，`SQLite header` 不存在 |
| `-wal` / `-shm` 旁文件 | 不存在 |
| `~/.pd/backups` | 无 trajectory 副本 |
| 全盘 `trajectory.db*` 搜索 | 仅其它 Host 的库、空实验副本，均非本 Workspace 历史 |
| `~/.Trash` 内的 workspace | `sessions=0, tool_calls=0`，是空实验体，不能作为来源 |

**未用一个空库冒充健康**。按 Owner 授权执行的是「声明丢失 + 官方路径重建」：

1. 写恢复记录：`.state/trajectory-recovery-1795486910758.json`（含损坏字节、sha256 `42b1946c…`、根因、穷举的恢复尝试、`dataLoss.declared=true`、未受影响的数据清单）
2. 保留原件：`.state/quarantine/trajectory.db.corrupt-placeholder` + `.state/trajectory.db.damaged-20261124T100353.bak`
3. 用官方命令重建：`pd runtime init --confirm`（幂等，全部 `CREATE … IF NOT EXISTS`，且「Existing config files are never overwritten」）

### 4.3 数据完整性校验

| 对象 | 修复前 | 修复后 | 结论 |
|---|---|---|---|
| `.pd/state.db` | 753,664 B, `integrity_check=ok`, approvals=3, schema_version=4 | 753,664 B, `integrity_check=ok`, approvals=3, schema_version=4 | **未改动** |
| `.state/trajectory.db` | 22 B 非数据库 | 143,360 B, `integrity_check=ok`, schema_version=1, 15 张基础表 | 结构重建，历史为空 |
| `.state/principle_training_state.json` | 3 条原则（全 candidate） | 不变 | 未改动 |
| Owner Marker / Lease / Handover 证据 | — | 未改动 | 未改动 |

**丢失范围**：WorkBuddy 会话轨迹行（sessions / user_turns / assistant_turns / tool_calls / pain_events / governance_*）。
**未丢失**：Task / Run / Artifact、原则树、Agent 产出物。

---

## 5. Host 专用 Handover 协议：审计结论（未实施）

### 5.1 审计方法与硬结论

用已安装 2.8.11 实跑（该步骤在任何状态变更之前就 fail-closed，无副作用）：

```
pd service handover --workspace ~/.codex/pd-workspace --json
→ {"ok":false,"outcome":"blocked","reason":"no_openclaw_host_binding", …}

pd service handover --workspace ~/.workbuddy/pd-workspace --json
→ {"ok":false,"outcome":"blocked","reason":"no_openclaw_host_binding", …}
```

源码层面确认（`origin/main@500c19993`）：

| 接缝 | 位置 | 现状 |
|---|---|---|
| Host 绑定判定 | `handover-claims.ts:44-65` | 只认 `claim.host === 'openclaw'`，`findForeignWorkspaceOwner('openclaw', …)` |
| 就绪探测 | `workspace-handover.ts:592,601` | 硬编码 `hostKind:'openclaw'` + `['openclaw','worker','--readiness']` |
| Quiesce Ack | `workspace-handover.ts:989-1047` | 只 `import('principles-disciple/openclaw-worker')` 的 `readGatewayQuiesceAck` |
| 首个 Cycle | `workspace-handover.ts:625` | 只 `createOpenClawWorkerAdapter()` |
| 证据 schema | `pd.service-handover-evidence.v1` | 无 host 字段 |

全仓 `git grep -i quiesce` 只命中 `packages/openclaw-plugin/src/service/gateway-quiesce-ack.ts` 一处 ack 生产者。**Companion 没有 quiesce ack 写入方**。

即：**当前 Release 只具备 OpenClaw Gateway Quiesce 协议，不具备 Codex / WorkBuddy 的 Companion Quiesce 协议。** 这与任务书判断一致。

### 5.2 已有的可复用资产（无需重建）

- `packages/pd-cli/src/services/service-host/worker-adapter-codex.ts` / `worker-adapter-workbuddy.ts`：Service Host 驱动两个 Host 的 Cycle 适配器**已存在且完整**（Phase 2 交付）。
- `packages/pd-companion/src/lib/workspace-workers.ts`：
  - `LEGACY_WORKER_BLOCKED_STATES = {handover_preparing, rollback_pending, service_host_owned}`
  - `computeOwnershipBlocked()` 从安装清单读所有权，决定「永不启动」
  - `beginTransitionStop()` 走 `pd.worker.drain.v1` 排空 + 超时强杀，并清除 restart timer（防止崩溃/重启复活）
  - **即 Companion 侧的「退役 + 不许复活」已经实现**
- `transitionWorkspaceBackgroundExecution` / `readWorkspaceBackgroundOwnership` / `withInstallManifestWriteLock` / `lease_generation` / operationId / CAS / Recovery Sweep：全部复用，无需第二套状态机。

### 5.3 缺的到底是什么

1. **Companion 侧 quiesce ack 写入方**（镜像 `pd.gateway-quiesce.v1`：绑定 workspace + operationId + generation + in-flight cycles=0 + 真实实例身份）。
2. **CLI 侧 5 个接缝的 host 参数化**（§5.1 表格）。

### 5.4 为什么没有在本会话实施

这不是「设计阶段停下」，而是一个**必须同批发版**的耦合体：

- 只改 CLI、不发 Companion ⇒ 两个 Workspace 会卡在 ack 等待直到 900 s 超时并回滚，功能不可用。
- 本机**根本没有安装 PD Companion**：`%LOCALAPPDATA%` 下只有 `@principlespd-companion-updater\installer.exe`，`Program Files` 无安装目录，进程列表无 Companion 进程。也就是说这两个 Workspace 的 legacy consumer 是「**不存在**」，而不是「正在跑、需要被请停」。
- 因此 Companion ack 协议在**本机**无法产生真实 ack。要让它可执行，必须先把 Companion 打包、分发、安装、常驻——这属于 Companion release train，超出「改完源码 + 装 CLI release」的范围。
- 在未完成上述两件事的前提下翻转 Owner，等于让一个 Workspace 交给 Service Host、而旧消费方既没被证明停止、也没被证明不存在——直接违反「所有消费者停止必须有真实证明」。

**因此：未提交半成品状态机改动，未安装未验证的 Release，未切换任何 Owner。**

### 5.5 需要 Owner 决策的协议问题

Companion 缺席时，「旧消费者已停止」的合法证据形态是什么？两个候选：

- **A（严格）**：必须 Companion ack。本机在 Companion 安装并被唤醒前，Codex/WorkBuddy 不可迁移。
- **B（等价证据）**：允许 `consumer_absent` 证据族——要求同时成立：① 无 Companion 进程 ② Companion 未安装（可核验安装路径不存在）③ 目标 Workspace 无 live worker 子进程 ④ 清单 generation 未前进 ⑤ 迁移后由 Companion 启动时的 `LEGACY_WORKER_BLOCKED_STATES` 守卫兜底。该证据**不得**命名为 Quiesce Ack。

建议 A 作为默认，B 仅在「Host 从未安装过 Companion」的场景作为显式例外，且必须在证据里区分。此项需 Owner 批准后才能改动协议语义。

---

## 6. Companion Worker 退役报告

- **机制**：已实现（§5.2），代码审计通过，无需改动。
- **本机实际状态**：Companion 未安装、未运行（`Get-Process` 无 `pd-companion`，`%LOCALAPPDATA%\Programs` 无安装目录）。
- **两个 Workspace 的 lastCycleDriver**：Codex = `companion`（2026-11-23T07:50:12Z，此后 `resident_driver_stopped`）；WorkBuddy = `manual`。
- **结论**：不存在「正在运行的 Companion 继续消费」这一风险；但同样不存在可产生真实 Quiesce Ack 的对端。退役**证明**无法取得，故未执行所有权切换。

---

## 7-8. Codex / WorkBuddy Owner 交接证据

**未执行。** 两个 Workspace 当前仍为：

```
C:\Users\Administrator\.codex\pd-workspace      legacy_owned / legacy
C:\Users\Administrator\.workbuddy\pd-workspace  legacy_owned / legacy
```

`~/.pd/install.json` 的 `backgroundExecutions` 未新增任何记录。没有 generation 变化，没有 CAS 翻转，没有伪造 Owner Marker。

迁移前置条件逐项对照：

| 前置条件 | Codex | WorkBuddy |
|---|---|---|
| Host binding 有效 | ✅ `mcp-binding.json` canonical、`workspaceMatchesRequest=true` | ✅ 同 |
| Workspace 已授权 | ✅ authorized | ✅ authorized |
| Service Host Adapter ready | ✅ `createCodexWorkerAdapter` 存在，`--status` ready | ✅ 同 |
| 无 in-flight Cycle | ✅ 无 worker 进程 | ✅ 无 worker 进程 |
| Companion Quiesce Ack | ❌ **协议不存在，且无 Companion 可产生** | ❌ 同 |
| Scheduler enabled | ✅ | ✅ |
| Host-specific Handover 能力 | ❌ **未实现** | ❌ **未实现** |

按任务书「如果某个 Workspace 不能安全迁移，保持原 Owner，报告明确原因，不要强制切换」，两个 Workspace 保持 legacy。

---

## 9. OpenClaw 原有接管状态复核

未重复 handover、未回滚、未改 Owner。

- `ownerState=service_host_owned`，`effectiveOwner=service_host`，generation 2
- 真实执行证据：`.state/openclaw-worker-liveness.json`
  ```
  {"lastCycleStartedAt":"2026-11-24T02:31:20.112Z","lastCycleDriver":"service_host",
   "lastInvocationId":"07ae134a-36a6-4cc0-87d2-9b0cd5e76ca4","lastCycleMode":"ready"}
  ```
  `driver=service_host` + `invocationId` 说明这是 **Scheduler 管理的 Cycle**，不是手工执行。
- 结论：OpenClaw 侧全链路成立。

---

## 10. 三个 Host 的真实 Worker Cycle 结果

| Host | 触发方式 | 结果 | 证据 |
|---|---|---|---|
| OpenClaw (`D:\.openclaw\workspace`) | Scheduler managed | `lastCycleMode=ready`，driver=service_host | `openclaw-worker-liveness.json` 02:31:20Z |
| Codex | 手工 `pd codex worker --once` | `mode=degraded`；reconcile/downstream/stage2 正常；catchUp 4 个 rollout：3 × `catch_up_transcript_missing`(.zst)，1 × `transcript_record_too_large`(**checkpoint 已从 1,341,806 推进到 3,443,798**) | `D:/pd-phase5/02-codex/worker-once.json` |
| WorkBuddy | 手工 `pd workbuddy worker --once` | `mode=ready`，reconcile ok，stage2 ok，无 degradation | `D:/pd-phase5/03-workbuddy/worker-once.json` |

关于 `lastProgressAt=null`：已按要求**不**把它当成功或失败。业务进展的真实判据是上面三个 liveness 文件的 `lastCycleMode` 与各自 report 的 `degradations` 数组；WorkBuddy 侧 `tasksEnsured=0` 且队列为空，属于「无业务任务可做」，不是「执行失败」。

---

## 11. Scheduler 自动执行结果

| 观测点 | osLastRunAt | osLastResult | managed run |
|---|---|---|---|
| T0 | 2026-11-24T09:57:17+08:00 | 0 | `b7166e86` completed / scheduler |
| T1 | 2026-11-24T10:31:17+08:00 | 0 | `abdb1ef7` completed / scheduler，1926 ms |

两次均为 OS 触发（`triggerSource=scheduler`），`osActive=false`（触发已结束，无悬挂实例）。`degradedReasons=[]`。

`lastRun.nextAction` 明确写着：*Only service_host_owned workspaces were consumed; legacy workspaces keep their legacy owner.* —— 这也是 Codex/WorkBuddy 即使已修复环境、仍不会被 Service Host 消费的原因。

---

## 12. 双消费者检查

- `Get-CimInstance Win32_Process` 过滤 `pd-cli|pd-companion|worker --`：**无任何 worker 子进程**，**无 Companion 进程**。
- 唯一 PD 进程是 `pd console open --workspace D:\.openclaw\workspace`（PID 652，遗留的只读 Web 控制台，不是消费者）。**建议清理**，属遗留进程，不影响所有权。
- 三个 Workspace 的 `liveness` 记录 driver 分别为 service_host / manual / manual，无并发重叠。
- 结论：**重复 Consumer = 0**。

---

## 13. 重启恢复测试

| 测试 | 状态 |
|---|---|
| Scheduler 连续周期自动触发 | ✅ 已观测 2 次真实触发（§11） |
| Service Host 重启后 Owner 不变 | ⚠️ 未执行（重启调度器会打断当前会话中的长任务，且不改变本次未迁移的结论） |
| Codex 关闭/重启后不复活 legacy worker | ❌ 无法执行——本机无 Companion 可复活它 |
| WorkBuddy 关闭/重启后不复活 legacy worker | ❌ 同上 |
| Handover 中断 / 崩溃 / CAS 冲突 / Lease 过期（隔离环境） | ❌ 未执行——被测能力本身未实现 |

不把未执行项写成通过。

---

## 14. 数据完整性报告

| 数据 | 状态 | 校验 |
|---|---|---|
| Codex `state.db` | 未改动 | — |
| Codex `trajectory.db` (43 MB) | 未改动 | `integrity_check=ok`，sessions=141、tool_calls=24103、governance_observations=11757 |
| Codex rollouts/checkpoints | 未删除、未重置 | checkpoint 仅按官方逻辑前进 |
| WorkBuddy `state.db` | 未改动 | `integrity_check=ok`，approvals=3，schema_version=4 |
| WorkBuddy `trajectory.db` | **历史丢失（已声明）**，结构重建 | `integrity_check=ok`，15 表，行数全 0 |
| WorkBuddy 原则树 | 未改动 | 3 条 candidate |
| Consent 记录 | 新增 Codex granted（g2b-2026-11-12）；WorkBuddy 原记录未动 | 文件可读 |
| Owner Marker / Durable Lease / Handover Evidence | 未改动 | `install.json` 仅 1 条记录 |

---

## 15. 剩余限制与风险

**P0 — 活跃的数据销毁缺陷（已修，未合并）**

`uninstall-host-scoped.test.ts` 的 `seedThreeHosts()` 在建立隔离**之前**解析路径。任何在 WorkBuddy 宿主 shell 里跑该测试的人，都会把夹具写进真实 `~/.workbuddy/pd-workspace`，覆盖 `config.yaml` 与 `trajectory.db`。

- 本会话已复现两次（11-22 原始事故、11-24 10:29 复现）。
- 修复：seed 前先 `pinSandboxHome()`（HOME/USERPROFILE + 清除 `WORKBUDDY_CONFIG_DIR` / `CODEX_HOME` / `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR` / `PD_EXPERIMENT_ROOT`），并显式传 `configDirOverride`，再加 `assertInsideSandbox()` 兜底。
- 回归测试：`seeding is hermetic even when the ambient host sets WORKBUDDY_CONFIG_DIR`。**已证红**（回退保护后失败：夹具落在沙箱外）**、证绿**（修复后 4/4 通过），且运行前后真实 workspace 的 config `md5` 与 trajectory `mtime/size` 完全不变。
- 风险：**未合并前该测试仍会毁数据**。建议优先合并。

**P1 — Codex `.jsonl.zst` 不被支持**

- 318 个压缩 rollout 永远 `transcript_missing`，3 个 checkpoint 永久停滞。
- 需要 codex-adapter 增加 zstd 解压 + 定位（Node 22.22 已有 `zlib.zstdDecompress`）。
- 不阻塞生命周期迁移（它只影响 Conversation Ingestion）。

**P1 — Codex CLI 0.171.0 超出已验证契约 0.167.0**

- 采集链路的兼容性未经验证。未篡改检查、未绕过。

**P1 — Host-specific Handover 未实现**（§5）

- Codex / WorkBuddy 无法迁移，Phase 5 目标未达成。
- 需 CLI + Companion 同批发版；本机还需先安装 Companion。

**P2 — Codex MCP `RESTART_REQUIRED` 未清除**

- 运行时握手已实测通过；静态标记需要一次真实 Codex 会话才会更新。

**P2 — 遗留 `pd console open` 进程（PID 652）**

---

## 16. PRI-1278 状态

- Linear：**In Review**，标题「[SPEC-PD-SERVICE-HOST-001] V1 实施总控与 Phase 5 生产生命周期交接」
- 描述中的既有结论仍成立：Runtime Phase 1–4 完成；**Phase 5 最终生产交接与 AC-01～AC-13 总验收未完成；Production Cutover 未授权**
- 本次未关闭工单（需 Owner 批准）
- 本次新增事实：Codex/WorkBuddy 环境已修复到可用；两个 Workspace 仍 legacy_owned；Host 专用 Handover 能力确认为缺口

---

## 附录 A — 证据文件清单

```
D:/pd-phase5/
  01-baseline/   service-status.json, version.json, codex-worker-status.json,
                 wb-worker-status.json, codex-health.json, wb-health.json
  02-codex/      consent-accept.json, worker-once.json
  03-workbuddy/  worker-once.json
  04-mcp/        codex-probe.json, wb-probe.json, wb-probe-2.json
  05-scheduler/  status-t0.json
   workspace-handover.ts, handover-claims.ts, gateway-quiesce-ack.ts,
   companion-workspace-workers.ts        # origin/main 审计快照
```

Workspace 内新增证据：

```
~/.workbuddy/pd-workspace/.state/trajectory-recovery-1795486910758.json
~/.workbuddy/pd-workspace/.state/quarantine/trajectory.db.corrupt-placeholder
~/.workbuddy/pd-workspace/.state/trajectory.db.damaged-20261124T100353.bak
~/.workbuddy/pd-workspace/.pd/config.yaml.damaged-20261124T100353.bak
~/.codex/pd-workspace/.state/conversation-ingestion-consent.json   # 新增 codex granted
```

## 附录 B — 未执行的破坏性测试（按指令不做）

- 真实生产 Workspace 上的 Handover 中断 / 崩溃注入 / CAS 冲突 / Lease 过期注入
- 未回滚 `D:\.openclaw\workspace`
- 未初始化 / 未授权 `C:\Users\Administrator\clawd` 与 `C:\Users\Administrator\.openclaw\workspace`
