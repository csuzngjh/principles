# Pain 提交能力小范围启用方案（OpenClaw 单宿主）

状态：**SUPERSEDED（2026-11-13，r6 更新）**。Owner 于 2026-11-13 下达「修改代码对全部的workbuddy开启」指令并授权 OG-4，同日追加「三个宿主都打卡」把启用范围定为 **Codex / OpenClaw / WorkBuddy 三宿主全部部署**；实现采用装配层已知 `PD_MCP_HOST` 判定（host 缺失/未知仍 recall-only），**不使用 env var**。授权记录见 `docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md` §〇 r5。本文的「仅 OpenClaw」「新增环境变量」「不做三宿主同时开放」三项不再作为执行依据；§2 观察期与 §3 停止条件未随新指令给出，列为 follow-up（全量开放前应补齐）。
适用范围：`pd_submit_pain`（Pain Ingress v0.8，SPEC-PD-AGENT-PAIN-INGRESS-001）。
历史状态（本提案撰写时）：OG-4 **BLOCKED**，生产入口未启用，三宿主 `tools/list` 均无该工具。

---

## 0. 已核实的前提（读代码得到，不是假设）

| 事实 | 位置 |
|---|---|
| 写工具默认不注册 | `packages/pd-mcp-server/src/server.ts:200`（`enableSubmitTool?: boolean`，默认 `false`） |
| 只有显式传 `true` 且绑定 `callSubmitCapability` 才注册 | `server.ts:263`（只开 `enableSubmitTool` 会 fail-closed）与 `server.ts:460` |
| 生产进程入口没有开启 | `packages/pd-mcp-server/src/index.ts:227-231`（`createPdMcpServer` 只传 workspace/host/logSink） |
| 能力本体已就绪 | `packages/principles-core/src/runtime/pain-submit-capability.ts:404`（`submitPainCapability`） |
| 回执合同 | `pd.pain-submit-receipt.v1`，四状态 `submitted / refused / failed / submit_unconfirmed` |

因此"开启"不是改一个配置值，而是**在宿主装配层做一次显式的代码选择**。

---

## 1. 启用范围

* **宿主**：仅 OpenClaw。Codex / WorkBuddy 继续 recall-only。
* **层**：MCP 进程的**装配层**（`main()` 所在的入口），不是 `server.ts` 内部。
* **形式**：新增一个显式环境变量（建议 `PD_MCP_ENABLE_SUBMIT_TOOL=1`）作为**装配层**的开关；
  `server.ts` 的 `enableSubmitTool` 语义保持不变，仍然只有显式传 `true` 才注册。
  开关为真时同时注入 `callSubmitCapability`，绑定启动时解析到的 workspace 与 `.state`。

  > 注意：当前合同写的是"没有环境变量或 feature flag 能打开它"。采用本方案等于**放宽该句**，
  > 需要一条显式的 SPEC 修订 + OG-4 授权记录，不能靠实现悄悄改变语义。
  > 若不希望放宽该句，备选是"临时专用启动入口/专用构建"：只给单宿主换启动命令，
  > 关闭时换回原命令。代价是部署层面多一个二进制/入口，可观测性略差。

* **关掉即回到当前状态**：移除该环境变量并重启 MCP 进程 → `tools/list` 回到只有 recall 工具，
  与今天完全一致；不触碰数据库、不迁移、不改 schema。

---

## 2. 观察期

* **时长**：5 个工作日，或累计 20 次真实提交，先到者结束。
* **指标**（全部来自 MCP 进程日志 + `tasks` / `diagnostic_json` 只读统计）：

| 指标 | 定义 | 判据 |
|---|---|---|
| 提交成功率 | `status=submitted` / 全部调用 | ≥ 90% |
| 回执状态分布 | 四状态计数 | 无异常偏移；`failed` 需逐条有 `error.code` |
| 锚点校验失败率 | `refused` 中 `anchor_*` / 全部调用 | ≤ 10% 且逐条可解释 |
| 重复提交 | `task_duplicate` 次数 | 同一 pain 至多 1 次 |
| 非本次授权提交 | 无 Owner 明确请求却出现的提交 | **必须为 0** |
| 后台/子代理提交 | 无对话轮次对应的提交（时间与 session 相关性） | **必须为 0** |
| 数据一致性 | `diagnostic_json.anchor` 形状、workspace 归属、任务数与 pain 数 | 无不匹配 |

---

## 3. 停止条件（任一命中立即关闭开关）

1. 出现 1 次**非本次授权**或**后台/子代理**提交。
2. `submit_unconfirmed` 出现 ≥ 2 次，或占比 > 5%。
3. 锚点校验失败率 > 30%，或同一错误码连续出现 ≥ 5 次。
4. 出现跨 workspace 写入、`workspaceDir` 与启动绑定不一致，或任务/pain 数量对不上。
5. `failed` 中出现无法归因的内部错误（非输入类）。
6. 任何需要人工修数据的迹象（例如同一 painId 多条任务）。

关闭动作：移除环境变量 → 重启 MCP 进程 → 在 Linear/交付记录中登记停止原因与证据。
已写入数据**只读保留，不删除**（见 §5）。

---

## 4. 验收清单

### 4.1 开启前可验（不需要开关）

| 项 | 判据 |
|---|---|
| `tools/list` 不含写工具 | 真实 stdio 握手后工具名集合 = recall 工具；无 `pd_submit_pain` |
| 工具 schema 形状 | 在测试装配下，`pd_submit_pain` 的 input schema 为 `reason / anchorType / anchorRef / painType?`，无 `score/severity/priority/sessionId` |
| Skill 投递 | OpenClaw 模板经 `build:production` 到 `dist/templates` 逐字节一致；npm 包内包含 |
| 回执构造 | 四状态与 `isError` 语义由单测覆盖（`refused` 不写库、`failed` 唯一错误） |
| 读取路径 | `diagnostic_json.anchor` → `diagnosisTarget.anchor` → 诊断提示词 ANCHOR 段 |
| 锚点校验 | 未知/过期/版本不符/无原则引用分别返回对应 `error.code` |

### 4.2 开启后才能验（开关打开、单宿主）

| 项 | 判据 |
|---|---|
| 真实写入往返 | 一次经 Owner 授权的提交在 `tasks` 中产生 `task_kind='diagnostician'` 记录，`diagnostic_json.anchor` 与输入一致 |
| 回执往返 | 返回的 `painId/taskId` 与库中记录可对上；`diagnosis.status=pending` |
| 拒绝路径 | 版本不符的原则锚点在真实宿主下返回 `anchor_not_found`/`anchor_not_currently_valid`，且库中无新记录 |
| 幂等 | 相同内容第二次提交返回 `task_duplicate`，不产生第二条任务 |
| Console 读取 | backlog / 详情页能读到该任务与锚点（若界面已接） |

---

## 5. 风险与回滚

| 风险 | 处置 |
|---|---|
| Agent 绕过授权自行提交 | 停止条件 1；Skill 已写明仅本次授权、禁止后台；关闭开关即止血 |
| 锚点格式不合规导致大量拒绝 | 观察期阈值；按错误码修 Skill 文案，不放宽校验 |
| 写入未知结果（超时） | `submit_unconfirmed` 按合同要求先对账再重试；阈值触发即关闭 |
| 数据污染 | 只读保留，不删除、不批量修复；逐条人工确认后再决定 |
| 开关本身失效 | 关闭 = 移除环境变量 + 重启；代码层默认值仍是 `false`，无需回滚版本 |

**回滚不是删数据**：已写入的 pain/task 与其 `diagnostic_json.anchor` 原样保留，可继续被只读消费；
若需停止后续诊断，使用既有的任务/管线停用机制，而不是删行。

---

## 6. 不在本方案内的事

* 不改 `server.ts` 的默认值，不改生产入口（本轮不执行）。
* 不做三宿主同时开放。
* 不为该能力新增独立 feature flag（沿用装配层显式选择 + 环境变量）。
* Console 逐任务列表读接口另行排期。
