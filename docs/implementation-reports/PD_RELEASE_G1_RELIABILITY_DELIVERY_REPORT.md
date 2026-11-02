# PD Release G1 Reliability Delivery Report

- 分支：`ai/PRI-1069-release-g1-reliability`（worktree `D:\Code\_worktrees\principles\PRI-1069-release-g1-reliability`，writer claim zcode）
- 基线：`b98e7e339`（= 实施时刻刷新后的 origin/main，0/0）
- HEAD：`cddefbd71`（4 个提交，见 §H）
- 工单：PRI-1069 + PRI-1070（PR 创建时 handoff）
- 裁定：**PASS_WITH_LIMITATIONS**（理由见 §G）

## A. 执行基线

| 项 | 值 |
|---|---|
| 仓库 | D:\Code\principles（primary 只读） |
| 实施基线 | `b98e7e339` = origin/main（fetch 后确认 0 ahead / 0 behind） |
| worktree | 独立池 worktree，claim `zcode:PRI-1069-release-g1-reliability`，READY（L1/L2/L3 零 leakage） |
| primary 工作区 | 18 项 untracked 全部原样保留；零修改 |
| 生产安装 | 未触碰（全部实验在 worktree `.tmp/` 与 temp HOME；~/.pd 仅只读） |

## B. SPEC v1.2 变更

见 `docs/specs/PD_Release_Delivery_SPEC_v1.2/SPEC-V1.2-REVISION-NOTES.md`（入库版）。要点：

- 六份文档版本升至 v1.2；DELIVERY-001 新增 §8.1 可靠性优先（G1 不以 G2/G3 全量调查为前置）；授权边界更新为"SPEC v1.2 + G1 已授权"。
- RELIABILITY-001：§2 复核表更新为 G0 复核后状态（含行号）；新增 §13-§17（A 执行代码来源 / B 探针诊断与身份 / C Windows EPERM 证据 / D Journal 与事务身份 / E 部分恢复语义）。
- ACCEPTANCE_PLAN：新增 §7.1 场景 F-19..F-33。
- RUNBOOK：当前授权改为 `SPEC v1.2 + G1 implementation authorized`，新增 §1A G1 执行序列。
- v1.0 自评材料原样保留；一致性检查通过（残留 v1.1 引用均为有意历史引用）。

### 工单→代码→SPEC 映射（摘要）

| 工单发现 | 代码 | SPEC 条款 | 修订 | 修复 |
|---|---|---|---|---|
| 更新由旧 runtime 执行（executor→RM→动态 import 旧 installer） | bootstrap-executor.ts / release-manager.ts:522-556 | §13(A) 新增 | ✓ | 核验（P0-5，无缺陷） |
| 探针无实例身份绑定 | installer.ts verifyConsole | §7+§14(B) | ✓ | P0-1 ✓ |
| 502 响应者未知（不预设归因） | pd-console health（无 502 分支） | §14(B) | ✓ | 诊断增强 ✓ |
| 事务 ID 格式异常/材料脱敏 | transaction-journal.ts | §16(D) | ✓ | 证据规则 |
| restoreBackup delete-then-rename | installer.ts:1187-1207 | §17(E) | ✓ | P0-3 ✓ |
| 备份部分成功丢路径 | backupExistingInstall:1159-1185 | §17(E) | ✓ | P0-3 ✓ |
| 恢复扫描跳过 terminal failed | update-transaction.ts:152 | §17(E) | ✓ | P0-4 ✓ |
| 子进程无 join | installer.ts:2977-2985,3987-3993 | §5-6 | ✓ | P0-2 ✓ |

## C. 缺陷修复（根因 → 影响 → 修复 → 测试 → 证据）

### C.1 P0-1 探针实例身份绑定（PRI-1069）

- **根因**：verifyConsole 成功判据 = HTTP 200 + 任意 JSON object，无实例身份证明；端口 3100-3199 固定窗口洗牌取样。
- **影响**：旧 Console/其他本地服务/代理返回的任何健康 JSON 都能"通过验收"（PRI-1069 实测 502 即未知响应者的现实表现）。
- **修复**：每次尝试生成一次性 nonce（randomUUID），经父进程 env `PD_CONSOLE_VERIFY_NONCE` 注入 child（非 argv、不落日志）；pd-console health 路由回显该 nonce（无 nonce 的正常用户启动完全不变）；探针要求 200 + PD health 形状（overall/authenticationMode）**且 nonce 精确匹配**，否则 fail-closed 记 identity_mismatch。502 等非 200 记为观测事实（http_error_status），归因保持 UNKNOWN。
- **测试**：`tests/console-verify-identity.test.ts` 5 用例（真实子进程 + 窗口内 in-process 响应者）：nonce 回显→verified；无 nonce 健康响应→identity_mismatch（fail-closed）；502→http_error_status；提前退出→exit code 分类；窗口隔离 sanity。
- **证据**：修复版 5/5 绿；基线源码上同套件 4 红（Red 验证）。

### C.2 P0-2 子进程退出确认（PRI-1069）

- **根因**：SIGTERM 后立即 SIGKILL、不等待 exit 事件（无 join）；成功路径 killConsoleChild 同模式。
- **影响**：被杀 child（可能持新 runtime 原生模块句柄）未确认退出即继续文件操作/下一端口尝试——与回滚 rmSync 竞争 = PRI-1069 损害链。
- **修复**：新增 `terminateAndJoinChild`（export）：**先订阅 exit 再发信号**（R8 实验 v1 反例证明 kill 后订阅会丢事件）、有界 SIGTERM 等待（5s）→ SIGKILL → 二次有界等待（5s）；`exited:false` 时调用方**禁止破坏性目录操作**（restore 转入 deferred）。verifyConsole 失败清理与 killConsoleChild 全部走 join。
- **测试**：`tests/console-child-lifecycle.test.ts` 4 用例（真实子进程）：dead→already_exited；live→真实 exit 事件到齐才返回；POSIX 忽略 SIGTERM→SIGKILL 升级（win32 跳过附理由）；不可确认退出（stub）→exited:false/timedOut。
- **证据**：修复版 4/4 绿；基线上 3 红。

### C.3 P0-3 rename-aside 恢复 + 备份补偿（PRI-1070）

- **根因**：restoreBackup 先 `rmSync(live)` 再 `renameSync(backup→live)`；两树顺序处理；备份中途失败时外层拿不到备份路径。
- **影响**：Windows 上对运行中安装 rmSync 遇加载中 .node 抛 EPERM 半路删除（R8 实验实锤：child 存活+模块映射时 rmSync EPERM、同卷 rename 成功）→ 半恢复现场（PRI-1069/1070 用户实测）。
- **修复**：`restoreTreeAside`：live 树**同卷 rename 到 `.restore-quarantine.<ts>`**（绝不先删）；备份 rename 归位；成功后 best-effort 清理隔离（残留上报不致命）；失败则隔离 undo 回 live 位；两树各自 `TreeRestoreResult`（restored/no_backup/failed + preservedDirs），**只有两树都真实归位才 restored:true**；幂等。`backupExistingInstall` 中途失败先补偿（undo 已移动的 ext 树）；补偿也失败则 `BackupIntegrityError` 携带路径给失败处理器。TOCTOU 防御：aside ENOENT 视为目标已不存在，继续恢复。
- **测试**：`tests/backup-restore-partial.test.ts` 5 用例（真实 fs + rename 注入 EPERM）：双树成功+幂等；runtime 树失败→ext 归位/runtime 备份保留/failed；ext 树失败对称；部分备份→补偿成功零副作用；补偿也失败→BackupIntegrityError 携带 preserved 路径。
- **证据**：修复版 5/5 绿；基线上 5 全红。

### C.4 P0-4 恢复可见性（PRI-1069/1070）

- **根因**：Console `recoveryStatus` 对 terminal 事务 `if (fact.terminal) continue` 全跳过；installer 失败 journal 无恢复状态语义。
- **影响**：terminal `failed` + `restore FAILED` 的半恢复安装（PRI-1069 现场）在恢复列表**不可见**。
- **修复**：installer 失败路径对"恢复失败/恢复被推迟"写入机器可读前缀 `restore_incomplete:` / `restore_deferred:`（detail 携带分树结果、preserved 清单、下一步指引）；Console recoveryStatus 新增 `recoveryRequired` 桶：terminal failed 且 detail 命中标记的事务进入 needsRecovery，普通 terminal 历史仍隐藏；GET 全只读不变。
- **测试**：`tests/recovery-visibility.test.ts`（pd-console，真实 journal+路由）4 用例：restore_incomplete 可见；restore_deferred 可见；普通 failed 不报警；rolled_back 不报警。
- **证据**：修复版 4/4 绿；基线上恰好 2 红（两个 marker 场景）。

### C.5 P0-5 更新生命周期与兼容性核验（无代码缺陷，记录结论）

- 更新事务由**旧版本 runtime** 执行（Console→旧 executor→旧 RM→动态 import 旧 installer.js）；修复发布后存量用户的**下一次**更新仍走旧代码——本次修复对存量用户的生效路径 = 旧代码在探针失败时进入 `restore_deferred` 类安全路径的稳定性**不受本次影响**（旧代码原样），新代码从修复版本安装起生效。executor 协议（ping|inspect|check|apply）跨版本稳定；bootstrap executor 投递 digest 校验在成功尾部重投，不阻断旧代码执行当前事务。
- Windows .node 实验结论（修复方案的平台依据）：加载中模块的**同卷目录 rename 成功**、rmSync EPERM——故回滚关键路径已不含对 live 树的递归删除。

## D. 测试结果

| 套件 | 结果 |
|---|---|
| 新增 P0 测试（4 文件） | **18/18 绿**（identity 5 + lifecycle 4 + partial 5 + visibility 4） |
| Red 验证 | 基线 `b98e7e339` 源码：installer 侧 12 红 / console 侧 2 红（恰为缺陷场景） |
| installer test:fast | 971 passed / 3 failed / 7 skipped |
| pd-console 全量 | **3072 passed** / 1 expected-fail（预期内） |
| BDD update-system（真实路径） | **11/11 绿** |
| 事务恢复/日志/active record | transaction-recovery 等既有套件绿（未改模型） |

**3 个失败为 pre-existing 环境性（实证）**：`workbuddy-packaged-install` 3 用例在本机因 `pwsh -c npm run clean && …`（bundle 链）失败，**在基线 `b98e7e339` 源码上同样失败**（已实测），失败发生在 npm pack 生命周期内、测试未开始，与本次改动无关；CI 的 Verify Merge Gate 会在真实 runner 上执行该套件复核。

### Windows 真实验证（R8 实验，本机 Windows 11 26200 + 真实 better-sqlite3 .node）

| 阶段 | 结果 |
|---|---|
| child 存活+模块映射：同卷目录 rename | **成功**（方案平台依据） |
| child 存活：rmSync 目录 | **EPERM**（精确复现用户故障） |
| 先订阅 exit 再 SIGTERM → join | **成功**（v1 反例：kill 后订阅丢事件） |
| 确认退出后 rmSync | **成功** |

实验脚本与输出：worktree `.tmp/g1/r8-node-experiment/`（gitignored，交付后可复查）。

### 故障注入矩阵映射（F-01..F-18 + F-19..F-33）

- F01/F07/F08/F10/F11/F12/F13/F-24/25/26/27/28/29 → backup-restore-partial（真实 fs + EPERM 注入）✓
- F02/F03/F04/F-19/20 → console-verify-identity（真实子进程+窗口响应者）✓
- F05/F06/F-21/22/23 → console-child-lifecycle + caller deferral ✓
- F16/F17/F-31/32 → recovery-visibility（真实 journal）✓
- F18/F-33 → identity 拒绝 + P0-5 核验 ✓
- F09/F14/F15 → 既有 BDD/transaction-recovery 覆盖（未改模型，回归绿）✓

分层说明：逻辑故障注入在本机 Windows 执行；POSIX 差异用例（SIGTERM 可忽略）以平台条件用例标注；每 ABI 重复不适用（RELIABILITY §10 分层条款）。

## E. 安全与复杂度

**复杂度变化表**：

| 维度 | 变更 |
|---|---|
| 新增公共抽象 | 3（terminateAndJoinChild、ConsoleVerifyAttempt/ConsoleVerifyError、BackupIntegrityError+TreeRestoreResult/RestoreBackupResult——全部为已证实风险的直接表达，零实现之外的新框架） |
| 新增状态/持久化 | 0（复用 journal detail 字段 + 机器可读前缀，无平行状态机、无新状态枚举） |
| 新增依赖 | 0 |
| 新增服务/进程/flag | 0 |
| 删除 | 旧 delete-then-rename restoreBackup；无 join 的 kill；nonceless 探针判据 |
| 安全能力 | 全部保留：TUF/签名/摘要/manifest/ABI 校验零触碰；nonce 为一次性 env 注入（非 argv、不落日志、无长期凭据）；GET 端点保持只读 |

## F. 剩余风险

- **已解决**：探针身份、child join、delete-then-rename 回滚、恢复可见性、备份补偿（R-1..R-4 全闭环）。
- **已知不阻断**：① 存量用户下一次更新仍由旧 runtime 执行（旧代码缺陷仍在其中；本 PR 发布安装后才替换——产品层不可解，属发布节奏事实）；② workbuddy-packaged 3 用例本机环境性失败（基线实证，CI 复核）；③ 隔离区清理失败会留 `.restore-quarantine.<ts>` 残留（显式上报，非静默）。
- **未解决且阻断**：无。
- **后续 G2/G3**：载荷瘦身（console/dist/ui、release-manager 收窄）、构建重复削减、pd-assets/遗留备份治理——按 SPEC v1.2 §8 Gate 待 Owner 授权。

## G. 最终裁定

**PASS_WITH_LIMITATIONS**

理由：G1 全部 P0 修复完成并有真实路径测试与 Windows 真实验证；限制项 = ① 上述 ①（旧 runtime 执行链的产品事实）与 ②（本机环境性 pre-existing，CI 复核），均不阻断恢复安全；G4 产品级平台矩阵验收（真实安装/升级/浏览器）按计划仍属 Gate 4。

## H. 提交清单

1. `3a72d2a51` docs(specs): SPEC v1.2 — Reliability First
2. `fda5c6e2a` fix(installer,console): G1 P0 四项修复 + 18 测试
3. `cddefbd71` test: harness 适配 + TOCTOU 防御

回滚方式：revert 三个提交即可（无 schema/数据迁移、无持久化状态变更、无 flag）。
