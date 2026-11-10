# PRI-1044：原痛苦信号在 Codex 上的真实闭环验收（2026-11-02）

## 结论状态：BLOCKED（外部账号配额 + 观察窗口未满足）

原规则已经完成“正式修订 → 新工件 → 新审批 → 版本化 shadow 激活 → 旧版原子停用”，新规则已在真实 Codex 的原生会话中实际评估，拦放矩阵与 shadow 不阻止实际动作均已交叉核实。

但无法继续推进到 live 晋升与撤回验收，原因是可复现的外部阻断：

1. **Codex 账号配额耗尽**：真实 `codex exec` 新会话与 resume 均返回
   `You've hit your usage limit … try again at Nov 6th, 2026 12:11 AM`（UTC）。
   解除条件：配额恢复（2026-11-06T00:11Z，约北京 11-06 08:11）或升级账号。
2. **既有 shadow 阈值未满足，且不可伪造**：观察窗口要求 `observed>=20`、`matched>=3`、`neutralControl>=1`、年龄 `>=24h`。
   当前新激活：observed 6、matched 3、neutral 3、errors 0、firstObservedAt `2026-11-02T03:11:17.150Z`（24h 最早 `2026-11-03T03:11:17Z`）；`observed>=20` 未满足，且配额耗尽无法继续产生真实样本。

没有降低阈值、缩短时间、刷样本或伪造审批。

---

## 1. 冻结基线（现场核实）

| 项 | 值 |
|---|---|
| 仓库 HEAD | `b98e7e339d7061a5d9a06efef8991c4b2e4ce349`（main，干净） |
| PR #2275 merge commit | `495ddf8d7` |
| 安装产品版本 | `2.8.0`，sourceCommit `0ff5f9f031d83f8243f26c62881db4c13e6ab4ab`，generation 59 |
| 安装事务 | `update-1793585251548-817c12cf`，releaseId `7d85a50a…` |
| Canonical runtime | `C:\Users\Administrator\.pd\runtime`：core `1.298.1`、host-runtime `0.14.4`、codex-adapter `0.6.2`、pd-cli `1.162.6` |
| Codex 插件私有 runtime | `C:\Users\Administrator\.codex\plugins\data\principles-disciple-principles\runtime\node_modules`：core `1.298.1`、host-runtime `0.14.4`、codex-adapter `0.6.2`（installedAt `2026-11-02T02:19:36Z`） |
| Hook 实际解析路径 | `C:\Users\Administrator\.codex\plugins\data\principles-disciple-principles\runtime\node_modules\@principles\codex-adapter\dist\pd-hook.js` |
| 治理 workspace | `C:\Users\Administrator\.codex\pd-workspace` |
| Console | `http://127.0.0.1:3100`（authenticated，Owner `csuzngjh` / credential `pd-owner-credential-primary`） |
| Worker | `pd codex worker --workspace C:\Users\Administrator\.codex\pd-workspace --interval 120000`；安装前旧进程 pid 22696 已停止，Companion 以新进程 pid 49344（`10:52:27`）重启，`liveness.verdict=live` |
| 模型 profile | `zai / glm-5.3-flash / timeoutMs 600000 / maxTokens 32000 / reasoning low`（`pd.default`） |

新旧代码核对：canonical 与 Codex 私有 runtime 的 core dist 均含 `action.recoveryControl`、`approved-rule-revision`、恢复控制面注册表；Console dist 含 `rule-revision-preview` / `revise-rule-once` 路由。

## 2. 原对象基线与“未被其他助手推进”核实

- pain `manual_1791868470372_8c47edyh`，task `diagnosis_manual_…`，trace `succeeded`。
- candidate `52d98a96-65b9-4952-82c5-51ba2d853c53`；principle `ce2b7885-a9ea-4f6e-94da-b0e6c9b85110`。
- 修订前唯一 code_tool_hook 激活：`act_code_rule-evaluator-…-code_tool_hook`，shadow、未停用。
- 旧工件：`…run_evaluator-…_3`，`validated`，digest `sha256:2359ecdf32e39c7b0c0aa7e356951f6468902ce3e618d6be2197a4c53e43befb`；旧审批 approved。
- 控制状态 `eligible` v1；`design_gate_declarations` 基线 0 行。
- 结论：无新工件/新审批/新激活，其他助手未推进该链。

## 3. 正式一次性修订（官方 Console 入口）

- `GET /api/v1/activations/<id>/rule-revision-preview` → `ready`，值与历史一致。
- `POST /api/v1/activations/<id>/revise-rule-once` → `started`，`taskRevisionEpoch=4`，`causeId=approved-rule:293eaa645d7c7a5298484ce6effd549b8a74cf75ba59d334aec7f36b65b9a442`。
- 反馈限定在原原则范围内：保留意图与可信事实；只读/搜索/确认安全执行放行；真实 not_approved 受管变更阻止；approved/not_required 放行；unknown/missing 中性；官方恢复消费宿主 `action.recoveryControl`，不写命令特例。
- 未改预算、未重置额度、未重跑诊断/Dreamer/Philosopher/Scribe。

修订链真实执行（新 worker）：

| 阶段 | 结果 | 时间 |
|---|---|---|
| Artificer | succeeded | 02:54:28 → 03:02:52Z |
| Evaluator | succeeded，`approved` | 03:04:53 → 03:06:18Z |
| RolloutReviewer | succeeded | 03:08:26 → 03:09:14Z |

新工件 `pi-rule-evaluator-…-code_tool_hook-run_evaluator-…_4`：`validated`，digest `sha256:7c121063b9294bec082e10235e1c5f199fe19eea02605eb6d72ba1ac63320c01`，`ruleHostInputContract.version=2`、`hostKinds=["codex"]`、`requiredFactKinds=["design_approval"]`，原则绑定 `ce2b7885…`。

确定性/恢复检查（安装版生产函数独立复跑）：

- 旧工件恢复组合检查：`ok:false`，`probe-pd-status`，reason `recovery probe probe-pd-status would be blocked … (empty:not-approved)`。
- 新工件恢复组合检查：`ok:true`（`pd activation list --json` 与 `pd activation deactivate --activation-id …` 两条探针）。
- Evaluator 报告：契约覆盖 86/86 执行并通过；3 条历史案例仅作 evidence-only（缺 `design_approval` 事实），未伪造回放。

## 4. 正式审批与版本化替换（官方 Console）

审批 `apr_code_tool_hook_…_4` 经认证 Console 批准（`expectedReview` 审阅 CAS + `intentReviewed` + `reviewedArtifactId`）。结果：

- 新激活：`act_code_rule-evaluator-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook_4c16d34c9895797f78d5c138227ca08896246327b4b5e727ab83761b56f72219`
- 新 targetRef：`impl://…_4c16d34c9895797f78d5c138227ca08896246327b4b5e727ab83761b56f72219`
- `supersededActivationId` 指向旧版；旧行 `deactivated_at=2026-11-02T03:10:15.017Z`，新行 shadow、未晋升。
- 激活表 2 行、0 重复 `activation_id`；控制状态 2 条各自 `eligible` v1；`supersede` 决策 1 条；旧工件/旧审批/旧决策历史保留（17 个历史工件仍在）。
- Console owner-review 按新 `activation_id` 唯一解析；重放同一审批返回 409（already decided），行数不变。
- 新激活 id 与工件派生一致：`act_code_${ruleId}_${sha256(artifactId)}`。

## 5. 真实 Codex 原生 shadow 验收（从磁盘更新到实际加载）

隔离项目：`D:\Code\principles\.tmp\pd-52d-native-20261102`，SPEC `SPEC.md`。
真实 native session：`01a19a2f-4f16-7f21-9594-d9a4455404ac`（`codex exec`，`hostKind=codex`；Hook 实际执行并写入 `.state/logs/events_2026-11-02.jsonl`）。
正式 design declaration：`sourceRef=bd396348-…`，绑定同一 session/project/SPEC digest `ff592360…`，scope `paths=["."]`、`actions=["read","write","execute"]`。

| 场景 | 事实态 | 新规则 shadow 评估 | 实际动作 |
|---|---|---|---|
| 官方状态 `pd activation list --json` | not_approved | allow，`matched=false`，新 activationId | 执行成功 |
| 受管写入 `Set-Content managed-new-rule.txt` | not_approved | **block**，`matched=true`，新 activationId | 实际写入成功（shadow 不阻止） |
| 受管写入 `Set-Content managed-new-rule-2.txt` | not_approved | **block**，`matched=true` | 实际写入成功 |
| 宿主确认安全只读 `cat SPEC.md` | not_approved | allow，`matched=false` | 执行成功 |
| 声明改为 approved 后 `Set-Content managed-approved.txt` | approved | allow，`matched=false` | 实际写入成功 |

交叉核实：同一 `activationId`/`ruleId`/`hostKind=codex` 出现在 `rulehost_evaluated` 事件、session 轨迹与文件时间戳中；无 `no_rules_armed`（新激活已真正评估）、无 `duplicate_active_activation`、无 `activation_control_state_invalid`。

shadow 汇总（core `summarizeRuleCodeShadowEvents`，hostKind=codex）：

```json
{"observed":6,"matched":3,"wouldBlock":3,"wouldAllow":3,"errors":0,"neutralControl":3,"firstObservedAt":"2026-11-02T03:11:17.150Z","lastObservedAt":"2026-11-02T03:14:25.931Z"}
```

## 6. 未完成 / NOT RUN

- `observed>=20` 与 `>=24h` 观察窗口未满足；不能晋升 live。
- live 拦放（未批准真实阻止、approved 成功、只读成功）与正式紧急暂停/停用撤回后行为恢复：**NOT RUN**。
- 新工件下的 unknown/missing 原生案例：**NOT RUN**（turn 1 无声明时旧代码显示 `no_rules_armed` 并实际放行，但未在新激活上复验）。
- 上述剩余原生验证均需新的真实 Codex 模型调用；当前账号配额阻断。

## 7. 阻断证据与最小解除条件

- 复现命令：`codex exec ...` / `codex exec resume ...` → `turn.failed`，`You've hit your usage limit … try again at Nov 6th, 2026 12:11 AM`。
- 最小解除：配额恢复（2026-11-06T00:11Z）或升级账号；随后继续产生真实 shadow 样本至 `observed>=20` 且跨过 24h，再按既有 Console 晋升流程执行 live 与撤回矩阵。
- 观察窗口最早检查时间：`2026-11-03T03:11:17Z`（仅年龄条件；`observed` 仍不足）。实际最早可完成时间不早于配额恢复时间。

## 8. 残余风险 / Follow-up

- 宿主 bash 风险分类原为 POSIX 白名单：Windows 原生只读命令（如 `Get-Content`）被归为 `unknown`，在 not_approved 下会按“非确认安全的执行”记为 would-block。**源码修复已完成**（worktree `adhoc-20261102-winreadonly-7f3a91`，分支 `ai/adhoc-20261102-winreadonly-7f3a91-bash-risk-powershell-readonly`）：为完整 PowerShell 查询 cmdlet 增加有界 allow-list 形状校验，未列参数/别名/未加引号 glob 仍为 `unknown`；见 `.changeset/windows-powershell-readonly-bash-risk.md`。**尚未安装**：安装版 core 1.298.1 仍是旧分类，需按正常发布/installer 流程才生效。
- 重复 Console 实例已在 2026-11-02 清理：仅保留 `127.0.0.1:3100`，`3101` 已停止，`pd console open` 复用时返回 `reused:true`。

## 证据位置

- 事件：`C:\Users\Administrator\.codex\pd-workspace\.state\logs\events_2026-11-02.jsonl`
- 原生会话输出：`.tmp/pd-52d-native-20261102/turn1..turn7-unknown.jsonl` 与对应 `*.stderr.log`
- 状态库只读查询：`C:\Users\Administrator\.codex\pd-workspace\.pd\state.db`
- 隔离项目/SPEC：`.tmp/pd-52d-native-20261102/`、`.tmp/pd-52d-native-unknown/`

## 恢复方式

- 规则仍处 shadow，未晋升 live；影响可随时通过正式停用/暂停控制撤回。
- 旧版已原子停用但历史保留；源码可回滚（revert PR #2275）；治理历史不删除。

## 附录 A：隔离 `CODEX_HOME` 验收前必读 —— hook 信任绑定插件绝对路径

2026-11-10 的隔离验收曾把「Codex 不派发 PD hook」误判为环境限制，实际原因是 hook 信任失效。
做同类验收前先读本节，可省掉一整轮误判。

**机制**：`$CODEX_HOME/config.toml` 的 `[hooks.state]` 以**解析后的插件绝对路径**参与哈希，
键形如 `"principles-disciple@principles:hooks/hooks.json:pre_tool_use:0:0"`，值含
`trusted_hash` / `trusted_content_hash`。把插件目录复制到另一个 HOME 后路径改变 → 哈希不匹配。

**现象**：非交互 `codex exec` **静默跳过**插件 hook。没有报错、`logs_2.sqlite` 里 0 行、
PD 侧 0 事件。看起来完全像「该宿主不支持插件 hook」。

**正解**：隔离 HOME 的 `plugins/cache/principles` 用 **junction/symlink 指回原插件路径**，
并让隔离 `config.toml` 与原 HOME **字节一致** → 哈希重新匹配 → hook 正常派发，无需任何 bypass。
验证：跑一次真实会话，确认出现 `runtime_v2_prompt_activations_injected` 与 `rulehost_evaluated`。

**禁忌**：`--dangerously-bypass-hook-trust` 只能用于**诊断**（确认「是不是信任门」），
不能作为验收结论的依据；用它跑出的绿不能算宿主原生验证。

**已排除的无效尝试**（不要重复）：复制 `state_5.sqlite`、`-c features.plugin_hooks=true`（死 flag）、
把 plugins 从 junction 换成真实拷贝、`codex plugin list` / `codex doctor` 输出（这三个都显示正常）。

**根因证据**：`.tmp/pri-1044-acceptance-20261110/e2e6-bypasstrust.jsonl`（带 bypass 立即派发）、
`e2e7-junction.jsonl`（junction 修复后**不带** bypass 同样派发）。
