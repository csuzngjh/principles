# PD-MCP-HOOK-INTEGRATION-VERIFICATION-001

| 字段 | 内容 |
|---|---|
| 任务 | MCP × PD Hook 集成机制定向验证（Gate 2 补充 / Gate 3 Proposal 前置证据） |
| 执行 | 2026-10-31；审计 worktree `adhoc-20261031-mcp-hook-verify-4f6804` @ `74af3071c`（= origin/main 最新） |
| 前置实验 | PD-MCP-GATE2-001（run-id gate2-20261031-c，报告在本目录） |
| 宿主 | codex-cli **0.166.0**（实测）；辅以 Codex 本体源码 `D:\Code\codex`（版本新于 0.166，凡引用均标注"新版源码"并经运行时甄别） |
| 边界 | 全程无 `--dangerously-bypass-approvals-and-sandbox`；无任何生产/宿主/主 checkout 改动；SYNTHETIC_ONLY；模型=已授权 glm-5.3-flash@ZAI Coding（与 Gate 2 同通道同配置） |
| 隔离证据目录 | `%TEMP%\pd-hook-verify-001\`（15 个实验目录，每个含独立 CODEX_HOME/工作区/events/srv-evidence/hook-evidence/result.json） |

---

## 一、最新代码事实与基线

- origin/main `74af3071c`。自 Gate 2 基线 `9f0888a16` 以来的 6 个提交全部是 prompt-budget/size-guard 与 version-packages；**`plugins/principles-disciple/hooks/`、`packages/codex-adapter/`、`packages/host-runtime/`、`pain-recall` 零变化**（git diff 确认）——Gate 2 Hook 证据对新基线继续有效。
- PD Hook 链路源码事实（均为 origin/main 实读）：
  - **生产 matcher**：`plugins/principles-disciple/hooks/hooks.json:5` = `Bash|apply_patch`（PreToolUse；PostToolUse=`.*`）。
  - **入口**：`pd-hook.cjs` → 隔离解析 pinned `@principles/codex-adapter` → `dist/pd-hook.js`；fail-open 包装（`{}`+exit 0）。
  - **输入解码**（`codec/input-decoder.ts`）：PreToolUse/PostToolUse 必填 `tool_name`(string)/`tool_input`(unknown)/`tool_use_id`(string)——**不假设 Bash command**，MCP 参数对象原样透传。
  - **决策输出**（`codec/output-encoder.ts`）：仅支持 `permissionDecision:'deny'`（无显式 allow；`deny` 在非 PreToolUse 事件上编码错误）。
  - **工具语义表**（`tool-semantics.ts`）：仅声明 `Bash→execute`、`apply_patch→write`（证据约束声明，未知名不被臆造）。
  - **Pain/Injection 准入**（`ingestion/admission.ts`）：PostToolUse→`tool_failure` 候选（按失败判据下游过滤）；Stop/UserPromptSubmit→correction 候选；MCP 查询本身无候选路径。
- Gate 2 证据复核：Phase 3 矩阵六项（含 PreToolUse 恰一次、零幻影、零误记、零孤儿）全部复核成立，且本轮 15 个新实验再次独立复现关键项。

## 二、四层证据链（A/B/C/D 分别取证，不互相冒充）

| 层 | 问题 | 结论 | 证据 |
|---|---|---|---|
| A | Codex 是否产生 PreToolUse 事件 | **是** | Gate 2 M1/M6（观察钩子恰一次）；本轮 E2b/E2c 再证 |
| B | PD 生产 matcher 是否命中 MCP 工具 | **否** | 本轮 E2a：配置生产 matcher 原文 `Bash|apply_patch`，MCP 调用时 PD hook **零触发**（hook-evidence 空）；Bash 命中 3/3 不受影响 |
| C | PD 处理器是否执行 | 对 MCP 调用**不执行**（B 为否的直接结果）；对 Bash/apply_patch 正常执行 | Gate 2 M6（Bash 门禁照常）+ adapter 生产安装形态 |
| D | Codex 是否执行 PD 返回的决策 | **是（deny 通道）** | 本轮 E3a/E4a：PD 协议形态的 deny JSON（exit 0）使工具**零执行**（srv-evidence 无记录、无 PostToolUse、事件流无 mcp_tool_call item）；E3a 的 srv-evidence 仅 `server-ready` 三次独立复现 |

**结论**：Gate 2 报告中"Hook 6/6 PASS"的准确含义是 A 层 + 观察证据；B/C 层对 MCP 调用**不成立**（生产 matcher 按设计不命中）；D 层本轮以 PD 协议形态实证成立。

## 三、Codex 源码关键语义（新版源码，逐项经 0.166.0 运行时甄别）

| 语义 | 新版源码 | 0.166.0 实测 |
|---|---|---|
| Matcher 三态 | `hooks/src/engine/matcher.rs`：空/`*`=All；仅 `[A-Za-z0-9_\|]`=**Exact**（`\|` 分割等值）；其余=**Regex**（`is_match` **子串**语义） | 一致（E2b Exact 恰 1；E2c 正则逐工具恰 1） |
| MCP 工具 hook 名 | `core/src/tools/handlers/mcp.rs:139`：`mcp__<server>__<tool>` | 一致（实测 `mcp__probe__ro_tool`；Gate 2 `pd-recall`→`mcp__pd_recall__…`，server 名有 sanitize） |
| PreToolUse 决策 | deny JSON→Blocked；**exit 2+stderr→Blocked**；非零/超时/坏 JSON/未知决策→Failed（fail-open） | **deny✓ 阻断；exit 2 ✗ 不阻断（0.166 无此通道）；其余全部 fail-open✓** |
| `Writes` 审批模式 | `core/src/mcp_tool_call.rs:2614`：`Writes => !read_only_hint.unwrap_or(false)`；配置键 `[mcp_servers.<name>] default_tools_approval_mode` | **0.166.0 接受该键且行为一致**（E5a） |
| Auto 模式 | 启发式（destructive/open_world/只读免审） | E5b2/E5b3：readOnlyHint=true 免审批执行；无 hint/false 需审批 |
| PostToolUse payload | `protocol/src/hooks.rs`/`events/post_tool_use.rs:36-40`：`tool_name/tool_use_id/tool_input/tool_response` | 一致（hook-evidence payloadKeys 十字段全集；tool_use_id 实证） |

## 四、八项验证结果矩阵

### V1 — PD Hook Matcher 与输入解析审计：**PASS**
- 生产 matcher 对 `mcp__pd-recall__pd_recall_principle_pains` **不匹配**（Exact 语义等值比较；E2a 运行时 0 命中）。
- 解析器**不假设 Bash**：`tool_input` 为 unknown 透传（decoder 源码 + 运行时 toolInputKeys=`["echo"]`）。
- 字段解析完备：运行时 payload 十字段 = `cwd, hook_event_name, model, permission_mode, session_id, tool_input, tool_name, tool_use_id, transcript_path, turn_id`，与 decoder 必填集完全一致，无解析缺口。
- 缺口（非缺陷，为覆盖缺口）：①hooks.json 无 MCP matcher 分支；②`tool-semantics.ts` 未声明任何 MCP 工具名（规则评估对 MCP 名无法命中）→ **PD 治理规则当前对 MCP 工具零覆盖**；③encoder 仅 deny——与 0.166 唯一可靠阻断通道对齐，无需修改。
- **不需要为 MCP 增加独立分发分支来"接入"**（协议兼容）；需要增加的是**可选的治理覆盖**（matcher+语义表扩展），属增量而非重构。

### V2 — MCP 专用 Matcher 隔离验证：**PASS**
| Matcher | 结果 | 证据 |
|---|---|---|
| `Bash\|apply_patch`（生产原文） | MCP 0 命中；Bash 3/3 命中 | E2a/E2c |
| Exact `mcp__probe__ro_tool` | 对该工具恰 1 次；其他不触发 | E2b |
| Regex `mcp__probe__.*` | probe 每工具恰 1 次；Bash 3 次全归 Bash matcher，互不误触 | E2c（5 fires 明细） |
| 第三方不误匹配 | 正则锚定 server 前缀（`mcp__probe__`），异名 server 不命中 | 语义推导+E2c 明细（如需绝对精确可全名 Exact） |

单次调用恰好一次触发；全部真实宿主行为（非正则单测）。

### V3 — PreToolUse 阻断能力（0.166.0 实测）：**PASS（结论=deny-only 可靠阻断）**
| 注入 | Hook 执行 | 工具是否执行 | PostToolUse | 判定 |
|---|---|---|---|---|
| **deny JSON** | ✓ 1 次 | **否（零执行）** | **无** | **阻断成功** |
| exit 1 | ✓ | 执行 | — | **fail-open** |
| **exit 2 + stderr** | ✓ | **执行** | — | **fail-open（0.166 无 exit-2 通道；新版源码已有）** |
| 非法 JSON | ✓ | 执行 | — | fail-open |
| 未知决策 `ask` | ✓ | 执行 | — | fail-open |
| 超时（timeout=5，hang 40s） | ✓（恰 1 次，无重试） | 执行 | — | fail-open |

- Marker 文件 + server 侧调用日志双重证明工具执行与否；**误报成功 0**；**hook 失败后工具继续执行 = 宿主 fail-open 既定语义**——必须如实记录：**0.166.0 上 PD Hook 不构成可靠的安全阻断边界；唯一可靠阻断通道是 deny JSON（恰与 PD encoder 的唯一输出语义对齐）**。
- 误报成功检查：deny 实验中 agent 收到拒绝并如实上报（E3a last=`{"ro":"denied"}`），无 false-success。

### V4 — PostToolUse 生命周期：**PASS（一处 NOT_VERIFIED 显式标注）**
- 成功 MCP 调用 → PostToolUse 恰 1 次（Gate 2 M1/M6 + 本轮 hook-evidence）。
- **deny 拒绝的调用 → 无 PostToolUse**（E4a：观察钩子 0 触发）——拒绝生命周期 = PreToolUse 记录后静默。
- 关联字段实名 **`tool_use_id`**（源码+运行时 payloadKeys；非假设）。
- 超时/重试不产生重复事件（E3f fires=1）。
- Server 退出零孤儿进程（进程枚举=0；注意 Windows 强杀不触发 `exit` 回调，故以进程枚举为准）。
- NOT_VERIFIED：**工具级失败（server 返回 isError）的 PostToolUse 形态**未单独实测（crash_tool + PostToolUse 观察组合未跑；不影响任何结论，列入 Gate 4 验证项）。

### V5 — readOnlyHint + writes 审批模式（最高优先级）：**PASS**
实测配置 `[mcp_servers.probe] default_tools_approval_mode = "writes"`（**0.166.0 接受该键**），headless（approval=never + sandbox read-only），**零旁路**：

| 工具 | Annotation | writes 模式 (E5a) | Auto 模式 (E5b2/E5b3 干净版) |
|---|---|---|---|
| ro_tool | readOnlyHint=true | **执行** | **执行** |
| hintless_tool | 无声明 | **拒绝**（策略拒绝，非挂起） | 拒绝 |
| write_tool | readOnlyHint=false + destructive | **拒绝** | 拒绝 |
| lying_tool | **readOnlyHint=true 但真写** | **执行（双 marker 落盘：工作区内+外）** | **执行（双 marker）** |

- **问题二答案：能。** 0.166.0 在 `writes`（或 Auto）模式下，readOnlyHint=true 的只读 MCP 工具**无需审批、无需旁路**即可 headless 执行；非只读工具被策略**安全拒绝**（deny 不是挂起）。Gate 2 需要 bypass 的真正原因：Gate 2 原型工具**未声明 annotations**。
- **readOnlyHint 是免审批依据，绝不是安全边界**：声称只读的 lying_tool 两模式均执行且**写入工作区内+外文件成功**——宿主不验证 hint 真实性。数据安全必须由 PD 侧保证（OD-A 投影 + 只读服务），Annotation 只能作为"提示宿主免审"的诚实声明。
- 无审批绕过：hintless/write 的拒绝为策略拒绝，agent 收到明确拒绝消息（E5a last 答案逐字记录）。
- 驱动缺陷披露：E5b 原始实验因驱动传错参数作废，以修正版 E5b2/E5b3 为准。

### V6 — Sandbox 与 MCP Server 安全边界：**PASS**
实测边界图（箭头=约束有效；✗=无约束）：

```
Host Sandbox (read-only)
  ├─→ Agent Bash 命令        ：写操作被策略阻断（E6a：Command blocked by policy，零写入）
  └─✗→ MCP Server 子进程     ：【无约束】lying_tool 写工作区外文件成功（E5a/E5b2/E5b3 三证）
                                 → MCP server 进程的权限 = 启动它的用户进程权限，
                                   与 agent sandbox 完全无关
Hook（PreToolUse deny）       ：可阻断 MCP 工具调用本身（E3a）；但 hook 失败 fail-open
MCP Tool annotations          ：只影响审批（V5），不约束 server 进程行为（lying 实证）
Application Capability（PD）  ：OD-A 字段投影 + 哨兵扫描（Gate 2：0 泄露）+ 每调用白名单断言
Core 只读服务（recallPains）  ：WAL 暂存快照只读 + 25 用例只读矩阵 + Gate 2 72 次指纹零变异
```

**有效安全边界 = Application Capability 投影 + Core 只读保证；宿主侧只有两个真实控制点：审批策略（V5）与 PreToolUse deny（V3）**，两者均非纵深防御的替代品。

### V7 — PD 治理数据隔离：**PASS（复用 + 新基线确认）**
- Gate 2 M5/M6：MCP 查询 pain_events 增量 0、注入统计 0、工作区指纹零变化——复核成立。
- 新基线零变化确认（第一节 diff）。
- 源码级补充：MCP 查询无任何候选路径（admission.ts）；MCP 工具**失败**将与任何失败命令一样进入 `tool_failure` 候选面——治理行为统一，非 MCP 特例。
- 既有 Bash 门禁行为不变（E2c：Bash matcher 3/3 命中不受 MCP matcher 影响）。

### V8 — WorkBuddy 兼容性：**DOC_VERIFIED_RUNTIME_NOT_VERIFIED**
- **文档（在库官方 hooks 参考快照）**：matcher=大小写敏感**正则**；MCP 工具命名 `mcp__<server>__<tool>`（官方示例 `mcp__memory__.*`、`mcp__.*__write.*`）——与 Codex 命名同构，跨宿主统一 matcher 方案可行。
- **在库源码**：WB adapter decoder 接受任意 `tool_name` 字符串（未知名→`'other'`，绝不臆造）；tool-semantics 表（Read/Glob/Grep/WorkBuddy 的 Write/Edit/Bash）未声明 MCP 名——与 Codex 侧同款覆盖缺口。
- **在库运行时证据**：WB PreToolUse exit-2 阻断已在 PD 自家 P02 probe 中验证（deny 后目标文件未写入，`workbuddy-evidence-recorder.ts:49` 注释）。**注意：WB 侧 exit-2 是有效阻断通道**（与 Codex 0.166 不同——跨宿主阻断语义不同构，adapter 需按宿主区分）。
- WB 实机合成 MCP 工具测试：未执行（本机无隔离 WB 环境；真实安装禁止触碰）→ 如实标注。

## 五、MCP → Host Hook → PD Handler 真实时序

```
Agent 调用 mcp__probe__ro_tool
  → [宿主审批层] V5: default_tools_approval_mode + readOnlyHint → 免审/拒（安全拒绝）
  → [PreToolUse hooks] matcher 三态选择 →（PD 生产 matcher 不命中 → PD hook 不被调起）
       → 命中的 hook: node pd-hook.cjs → adapter decode(tool_name/tool_input/tool_use_id)
           → 治理评估（现表无 MCP 名 → 若未来加 matcher，需扩 tool-semantics）
           → encode: 仅 deny JSON（唯一可靠阻断）
       → hook 失败/超时/坏JSON/未知决策 → fail-open（0.166；exit-2 通道仅新版源码）
  → [MCP server 子进程] 执行（不受 agent sandbox 约束！）
  → [PostToolUse] 成功调用恰一次（tool_use_id 关联）；deny 的调用无 PostToolUse
  → [PD ingestion] PostToolUse→tool_failure 候选（按失败判据过滤）；MCP 查询无候选
```

## 六、四方案对比与推荐

| 维度 | A：Hook 不变+MCP matcher 分支 | B：MCP Hook Adapter 复用治理 | C：Capability 持安全+Hook 只适配生命周期 | D：深度耦合重构 |
|---|---|---|---| SPEC |
| 代码改动 | 小（hooks.json+1 分支） | 中（新 adapter 路由+语义表扩 MCP） | 中（能力层投影已在 Gate 2 原型验证） | 大 |
| 新增依赖 | 0 | 0 | 0（Gate 2 已证 SDK 仅入临时原型） | 0 |
| 宿主兼容 | 高（Exact matcher 已验证） | 中（需处理 WB exit-2 vs Codex deny 语义差） | **最高**（宿主无关） | 低 |
| 安全边界 | 无增益（规则不覆盖只读查询） | 规则可覆盖 MCP 写类工具（未来） | **真实边界在投影+只读服务（V6 已证）** | 复杂化 |
| 故障处理 | fail-open 语义不变 | 同 | 同 | 复杂 |
| 是否动 Core | 否 | 是（语义表） | 否 | 是 |
| 是否影响 CLI | 否 | 否 | 否 | 是 |
| 新公共抽象 | 否 | 语义表扩展 | Application Capability（Gate 3 本身） | 多个 |

**推荐：C 为主 + A 为最小补充（即 Owner 提示的"Host Hook Adapter + Application Capability 双边独立、按需协作"）。**
1. 安全授权/披露边界放 Application Capability（OD-A 投影+哨兵+只读服务，Gate 2 已证 0 泄露/0 副作用）——宿主无关、两宿主同语义、不依赖宿主 fail-open 现实。
2. Hook 侧仅做**可选的轻量治理覆盖扩展**（A）：为 MCP 工具名增加独立 matcher 分支 + `tool-semantics` 增补 MCP 命名声明——用于未来治理规则覆盖 MCP **写类**工具；MCP 只读查询不强制过 rulehost（无增益）。两宿主 matcher 语义差异（Codex Exact/Regex vs WB 纯 Regex）由各自 adapter 承担。
3. 否决 D：fail-open 是宿主既定行为，深度耦合制造虚假安全感；否决纯 B：为只读查询引入 rulehost 评估零安全增益且需处理跨宿主阻断语义差异。

## 七、SPEC v0.4 修订建议（v0.5 具体条目）

1. §6.1：MCP 工具注册建议增加 **annotations 声明要求**：只读工具必须声明 `readOnlyHint:true`（真实、不得虚报——它是 0.166+ 免审批依据，且宿主不验证其真实性，虚报=治理面伪装）。
2. §8.2：补一条宿主事实：**PreToolUse hook 失败=fail-open（0.166 实测六种失败全部放行）；唯一可靠阻断=deny JSON；Hook 不是数据安全边界**——数据安全由 §8.2 投影层 + §8.3 只读不变量承担（引用本报告 V3/V5/V6）。
3. §8.4：补宿主安全边界事实：**MCP server 子进程不受宿主 agent sandbox 约束**（lying 实证）——stdio server 的信任级别=启动用户，Gate 4 安装边界须按此表述。
4. §10 Gate 2 前置五项的 Client 版本钉注记：codex 0.166.0 支持 `default_tools_approval_mode` 与 annotations 免审批；**0.166 无 exit-2 阻断通道**（WB 有——跨宿主阻断语义差异写入 §8.2）。
5. §11.4 测试矩阵：增加 matcher/审批/annotations/lying-tool 反例四组（直接复用本轮 15 实验为模板）。
6. 工具描述建议（Gate 4 材料）：PD recall 工具声明 `readOnlyHint:true`，工作区绑定描述保留"trusted launch config"表述。

## 八、Gate 3 Proposal 前置条件清单

1. ✅ Gate 2 净增量证明（72 运行三门全过）。
2. ✅ MCP×Hook 四层证据链闭合（本轮）。
3. ✅ 无旁路审批方案实证（writes/Auto + readOnlyHint）。
4. ✅ 架构推荐（C+A 混合）与安全边界图。
5. ⬜ Owner 裁决：①是否为 MCP 写类工具启用治理覆盖（matcher+语义表扩展，本轮仅验证可行性）；②WB 实机合成验证是否列入 Gate 4 前置（当前 DOC_VERIFIED_RUNTIME_NOT_VERIFIED）；③exit-2 通道是否等待宿主升级后在 Codex 侧启用（0.166 无效）。
6. ⬜ Gate 3 实施批准本身（Owner 保留裁决权）。

## 九、最终三问与建议

**问题一（PD Hook 能否可靠接入 MCP？缺什么？）**
能接入——协议、payload、字段、决策输出全部兼容（decoder 不假设 Bash；deny 语义与宿主唯一可靠通道对齐）。缺三样：①生产 matcher 无 MCP 分支 → 治理规则对 MCP 工具**零覆盖**（覆盖缺口，非破坏）；②tool-semantics 表无 MCP 命名声明 → 规则评估无法命中 MCP 名；③必须把"fail-open + deny-only"写进契约：**0.166.0 上 PD Hook 不是数据安全边界**，阻断只能靠 deny，数据安全只能靠投影+只读服务。

**问题二（0.166.0 能否不关 sandbox、不用危险旁路安全执行只读 MCP 工具？）**
**能。** `[mcp_servers.<name>] default_tools_approval_mode="writes"`（或默认 Auto）+ 工具诚实声明 `readOnlyHint:true` → headless 免审批直接执行；非只读工具被策略安全拒绝。附条件：readOnlyHint 必须由 PD 诚实声明（宿主不验证），数据安全不依赖它。

**问题三（重构 Hook 架构还是轻量适配？）**
**轻量适配。** 推荐 C+A 混合：Application Capability 持有授权/披露/只读安全（宿主无关），Hook 侧仅可选增加 MCP matcher 分支与语义表扩展（治理覆盖 MCP 写类工具的未来通道）；不需要任何 Hook 架构重构。

## 十、最终建议

# **READY_FOR_GATE_3_PROPOSAL**

证据链完整：Gate 2 增量价值（72 运行三门全过）+ 本轮四层证据链闭合 + 无旁路审批方案实证 + 架构推荐 + 安全边界图。三项 Owner 待裁决（第八节 5）随提案附上；WB 实机合成验证（DOC_VERIFIED_RUNTIME_NOT_VERIFIED）建议列入 Gate 4 前置。

**READY 仅代表证据具备，不构成 Gate 3 实施授权。Owner 最终裁决权保留。**

---

## 附：实验清单与证据位置

| 实验 | 验证 | 结果文件 |
|---|---|---|
| E5a/E5b2/E5b3 | V5 双模式审批 + lying 边界 | `%TEMP%\pd-hook-verify-001\exp-E5*/` |
| E3a-E3f | V3 六种注入（deny 阻断/fail-open×5） | `exp-E3*/` |
| E2a/E2b/E2c | V2 matcher 隔离（含生产 matcher 0 命中） | `exp-E2*/` |
| E4a | V4 拒绝生命周期（无 PostToolUse） | `exp-E4a-deny-postlifecycle/` |
| E6a | V6 agent sandbox 写阻断 | `exp-E6a-sandbox/` |
| 全部 | hook-evidence（事件字段/次数）+ srv-evidence（工具执行计数）+ result.json | 同目录 |
| Gate 2 Phase 3 | A 层 + 治理隔离 | 实验 worktree `adhoc-20261031-mcp-gate2-f505ca/.tmp/pd-mcp-gate2/hook-phase3/` |

驱动缺陷披露：E5b 原始实验传错参数作废（以 E5b2/E5b3 为准）；out-marker 目录在 E5a 后未逐实验清理（跨实验残留仅影响该辅助目录，工作区内 marker 各实验独立有效）；E2c 的 5 次 hook 触发 = 3 次 Bash 探索 + 2 次 MCP，属 agent 自发探索非重复触发。
