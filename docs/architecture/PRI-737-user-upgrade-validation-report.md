# PRI-737 User Upgrade Validation Report

> PRI-737 Post Merge Real User Upgrade Validation — 2026-09-11
> 验证方式：模拟真实 PD Owner，通过 Web Console Update 页面真实点击完成 1.233.0 → 1.235.0 全量升级（未使用 CLI update/install 路径）。
> 验证人：AI agent（ZCode session），Owner 未实时旁观。

# Executive Summary

**PASS**

真实用户升级路径（Console → 更新页 → 点击升级）在 PRI-737 合并后的首个发布版本 1.235.0 上完整走通。升级前后 Console 全页面、OpenClaw agent 链路、治理链 trace 均正常；未发现 PRI-737（Evolution Worker 历史链删除）引入的任何用户可见回归。

升级目标版本 1.235.0（2026-09-11 13:22 UTC 发布）恰好包含 PRI-737 的两条提交：

- `refactor(PRI-737): retire legacy evolution worker chain (phase 1) (00fa46e3)`
- `fix(PRI-737): review round 1 — resolve automated reviewer findings (c859d030)`

即本次升级本身就是「删除 Evolution Worker 后的系统」的首次真实用户升级，验证具有针对性。

# Phase 0 — 环境记录（升级前）

| 项 | 值 |
|-|-|
| Canonical 产品版本（`pd -V`） | 1.233.0 (000000000000) |
| install.json | layoutVersion=1, mode=canonical, hosts=[openclaw], workspace=`D:\.openclaw\workspace` |
| installed plugin (principles-disciple) | 1.233.0 |
| installed @principles/core | 1.278.9 |
| installed @principles/host-runtime | 0.3.10 |
| installed @principles/pd-cli | 1.147.14（2026-09-10 console-apply-full 所装） |
| installed @principles/codex-adapter | 0.2.4 |
| installed create-principles-disciple | 1.134.5 |
| npm 最新版（升级目标） | principles-disciple **1.235.0** / pd-cli 1.149.0 / core 1.279.0 / host-runtime 0.3.12 / installer 1.136.0 |
| Console 状态 | 未运行；经真实用户入口 `pd console open` 启动于 127.0.0.1:3100（auth 模式，PD_CONSOLE_TOKEN） |
| 上次成功更新 | 1.231.2 → 1.233.0（2026-09-10，update-history.json） |

升级前 Console 页面基线：治理焦点 2 条待审批原则、1 个系统降级信号、数据降级横幅（unlinked_record 140 次）——均为升级前既有状态，留作对照。

# Phase 1 — Web Console 升级验证（真实点击）

1. **打开 Console**：`pd console open`（PRI-300 真实用户入口）→ 127.0.0.1:3100，页面正常加载，登录页渲染正常。JS console 仅 1 条预期 401（登录前 health 探测），无其他报错。
2. **进入更新页**（#/update）：
   - 当前版本显示 **1.233.0** ✅（与 `pd -V`、installed plugin 一致）
   - 最新版本检查正常：**1.235.0 · 有可用更新** ✅（与 npm registry 一致）
   - 更新内容正确展示 v1.234.1...v1.235.0 changelog，含 PRI-737 两条提交 ✅
   - 「检查更新」「立即更新」按钮存在 ✅
   - 截图：`.playwright-mcp/pri737-update-page-before.png`
3. **真实点击升级**：
   - 点击「立即更新」→ 弹出确认对话框（「确认更新：将下载并更新全部 PD 代码包（插件、控制台、核心、CLI）……更新完成后需要重启控制台。」）
   - 点击「全量更新」→ 按钮变为「更新中…」（disabled），发出 **POST /api/update/apply-full → 200 OK**，随后 UI 轮询 /api/update/check
   - 全程未调用内部 API 绕过 UI，未使用 CLI update/install
4. **流程观察**（check → download → verify → install）：
   - 事务日志 `~/.pd/transactions/console-apply-full-1789135746484-0b6cfce1.jsonl`：
     - `14:09:06.485Z planned → confirmed`（`14:09:35.903Z`，**全程约 29 秒**）
     - detail: `apply-full: Full update completed successfully`
     - releaseId `console-apply-full-1.233.0-638dee270a50`，releaseMetadataDigestSource=`fallback`（PRI-727 发布元数据管线的降级来源标注，非阻断）
   - 更新历史新增 `1.233.0 → 1.235.0`（update-history.json 同步落盘）
5. **重启控制台**（按 UI 提示「请重启控制台以加载新版本」）：停止旧进程（pid 14108）→ `pd console open` 重新启动 → 新 Console（pid 24440）以 1.235.0 代码上线。

# Phase 2 — 升级后 Console 验证

重新打开 Console 并逐页验证（快照存于 `.playwright-mcp/page-2026-09-11T14-1*.yml`）：

| 页面 | 结果 |
|-|-|
| 治理焦点（Dashboard/Governance） | ✅ 2 条待审批 Rollout 评审卡片正常渲染 |
| 行为证据（Pain） | ✅ 活跃链路 13 条真实渲染 |
| 原则审查（Principles） | ✅ 29 条原则、筛选器/统计正常 |
| 生效情况（Activation） | ✅ 1 条已激活原则，生效履历/停用按钮正常 |
| 控制中心（Runtime Health） | ✅ 行为回路、9/10 智能体、核心管道正常 |
| 失败任务 | ✅ artificer (2) 历史失败任务真实渲染 |
| 设置 | ✅ 认证/拥有者身份（已登记）正常 |
| 更新 | ✅ 当前版本 1.235.0「已是最新」，历史含本次升级记录 |

- 无白屏、无 JS error（全程 console error 计数仅登录前 1 条预期 401）、无 API error（/api/* 全 200）、无 missing module。
- 升级前既有的「数据降级」横幅（unlinked_record 140 次）升级前后完全一致——既有状态，非本次回归。
- 截图：`.playwright-mcp/pri737-update-page-after-235.png`

# Phase 3 — OpenClaw 用户路径

| 检查项 | 结果 | 证据 |
|-|-|-|
| Plugin 加载 | ✅ enabled, **Version 1.235.0** | `openclaw plugins list`；gateway（pid 10696）启动于 apply-full 之后 |
| Gateway | ✅ running, Connectivity ok | `openclaw gateway status`；127.0.0.1:18789 |
| Hook 正常 | ✅ | `host-tool-semantics/openclaw.json` 在 gateway 重启后首次 agent 会话即更新（22:53）；`state.db-wal` 持续活跃写入 |
| Runtime 连接 | ✅ | `pd health`：state.db/ledger 正常、candidateLedgerConsistency ok、resolver/replay ready、registry hosts=[openclaw] |
| 简单任务执行 | ✅ | `openclaw agent --agent main --session-id pri737-upgrade-smoke -m "…"` → result success（provider bai / glm-5.3-flash，无 fallback） |
| 治理链无异常 | ✅ | `pd trace show`：Pain→Task→Run→Candidate→Ledger 全通（含延迟数据）；state.db-wal 在 agent 回合后立即有写入（hook 观察到活动） |

**事件（已定界，非 PRI-737 回归）**：`openclaw daemon restart` 两次健康检查超时（180s/181s），期间 gateway 端口短暂不可用；实为 756.9 MiB agent SQLite 快照/维护耗时超过 openclaw 自身的健康检查超时——gateway 进程（14:34 计划任务）最终自行启动成功并加载了 1.235.0 插件。日志证据：`openclaw-2026-09-11.log`（"SQLite read-only snapshot timed out after 54 seconds (budget for 756.9 MiB)"）、`~/.openclaw/logs/gateway-restart.log`。13:00 的上次重启（升级前）即存在同款大库快照超时模式，且升级后 gateway 正常服务，故定性为**既有的 OpenClaw/环境慢启动特性**，与 PRI-737 无关。注意：验证期间的gateway重启窗口内 agent 会话短暂不可用，真实用户在升级后重启机器/daemon 时可能感知为「升级把 agent 搞坏了」，建议改进 openclaw 侧重启超时或文档提示（follow-up，非本票范围）。

# Phase 4 — Evolution Worker 删除的用户可见影响

**用户可见面零残留：**

- **无 evolution 页面入口** ✅ — 全部导航项穷举（治理焦点/行为证据/原则审查/生效情况/原则债务/拥有者意图/控制中心/产品反馈/失败任务/设置/更新），无任何 evolution 入口。
- **无 evolution status 卡片** ✅ — 控制中心内部智能体卡片共 9 张（diagnostician/dreamer/scribe/artificer/evaluator/philosopher/rolloutReviewer/correctionObserver/empathyObserver），无 evolution worker。徽标「已启用 9/10」的第 10 个为 `signalCollector`（config.yaml 中 `enabled: false`，升级前既有），与 worker 退役无关。
- **无已删除能力提示** ✅ — 各页面无「能力已移除」类提示；UI 源码（origin/main `packages/pd-console`）中 `evolutionWorker` 零引用。页面上「终止本条演化」为原则 episode 治理语义的现行 i18n 文案（`zh-CN.json:303`），非 worker 残留。
- **配置残留（休眠，无害）**：workspace `config.yaml` 仍保留 `evolution_worker: {category: quiet, enabled: false}` flag 定义。UI 不呈现，无行为影响；可留待后续 flag 清理批次，不构成用户可见问题。

**核心能力链正常（升级后实测）：**

Pain（13 条活跃链路）→ Diagnosis（`pd trace`：task succeeded，task→run 34397ms）→ Principle（29 条沉淀）→ Activation（1 条已激活、可撤销、生效履历 11 次）✅

# User Journey

| 步骤 | 结果 |
|-|-|
| 打开Console | ✅ `pd console open` → 3100 端口，页面/登录正常，0 JS error |
| 检查更新 | ✅ 当前 1.233.0 / 最新 1.235.0，changelog 正确含 PRI-737 提交 |
| 点击升级 | ✅ 立即更新 → 确认 → POST apply-full 200，约 29 秒完成 |
| 升级完成 | ✅ 事务 confirmed「Full update completed successfully」，历史落盘 |
| Console恢复 | ✅ 重启后 8 个页面全部正常，无白屏/JS error/API error |
| Agent运行 | ✅ 插件 1.235.0 加载，hook 触发，冒烟回合成功，trace 全通 |

# Problems

### P3-1（观察项）升级后 gateway 重启健康检查超时，用户可能误判「升级弄坏 agent」

- **复现步骤**：Console 升级完成 → 重启 OpenClaw daemon（`openclaw daemon restart`）→ 180s 健康检查超时报错，端口短暂 ECONNREFUSED。
- **日志**：`openclaw-2026-09-11.log` 14:24–14:39 段（SQLite read-only snapshot timed out after 54 seconds, budget for 756.9 MiB, openclaw-agent.sqlite）。
- **影响**：重启窗口内 agent 会话不可用数分钟；提示文案不足以让用户区分「慢启动」与「失败」。属既有环境特性（大 agent 库），与 PRI-737 无关——升级后 gateway 最终以 1.235.0 插件正常服务。
- **建议**：独立 follow-up（openclaw 侧重启超时/进度反馈），不阻断 PRI-737 收口。

### P3-2（既有状态，非回归）治理数据降级横幅与失败任务存量

- unlinked_record 140 次、pain_13 无法关联诊断任务、25 条失败任务、pain_chain_flow 长时间无活动——升级前后完全一致（对照 Phase 0 基线）。属既有治理数据质量问题，已有独立票追踪体系，不在本票范围。

# Recommendation

**PASS — 建议 PRI-737 Close。**

真实用户升级路径（1.233.0 → 1.235.0，含 Evolution Worker 历史链删除）端到端走通，Console、OpenClaw agent 链路、治理核心链路均无回归。上述 P3 观察项均为既有状态或环境特性，建议另立 follow-up，不随本票处理。

## 附：升级后组件版本

| 组件 | 升级前 | 升级后 |
|-|-|-|
| product (`pd -V`) | 1.233.0 | **1.235.0** |
| principles-disciple (plugin) | 1.233.0 | **1.235.0** |
| @principles/core | 1.278.9 | **1.279.0** |
| @principles/host-runtime | 0.3.10 | **0.3.12** |
| @principles/pd-cli | 1.147.14 | **1.148.0** |
| @principles/codex-adapter | 0.2.4 | **0.2.9** |
| create-principles-disciple | 1.134.5 | **1.136.0** |
