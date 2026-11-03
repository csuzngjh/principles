# PD_MCP_GATE4_HOST_ACCEPTANCE_MATRIX

# Gate 4 三宿主验收矩阵（SPEC-PD-MCP-GATE4-001 v1.2 §6.5/§11）

| 字段 | 内容 |
|---|---|
| 实施工单 | PRI-1071（In Progress） |
| 基线 | origin/main `457bbf0fc`；分支 `ai/PRI-1071-mcp-gate4` |
| 验收日期 | 2026-11-02 ～ 2026-11-03 |
| 证据环境 | 全部隔离环境（隔离 CODEX_HOME / `--profile gate4` / 隔离 CODEBUDDY_CONFIG_DIR）；零 Owner 日常宿主配置写入 |
| 支持判定 | 见 §4 判定表——两宿主 RUNTIME_VERIFIED，一宿主 IMPLEMENTED_NOT_RUNTIME_VERIFIED（诚实边界，见 §3.3） |

---

## 1. 量化门槛结果（SPEC §11.4）

| 验收项 | 门槛 | 结果 | 证据 |
|---|---|---|---|
| Server 启动和握手 | 每宿主 20/20 | **Codex 形态 20/20；OpenClaw 形态 20/20；WorkBuddy 形态 20/20** | `.tmp/acceptance/quant-probe.mjs`，真实 spawn+initialize，2026-11-03，max 单轮 1045ms（Codex）/395ms（OC）/343ms（WB），0 失败 |
| 工具发现 | 每宿主 20/20 | **20/20 × 3** | 同上（tools/list 每轮断言唯一 Tool + 名称） |
| 真实 Tool 调用 | 每宿主 10/10 | **20/20 × 3**（超出门槛） | 同上（每轮 tools/call 断言 pd.capability.v1 envelope） |
| 单次调用时延 | ≤10s | **≤1.05s**（P95 远低于门槛） | 同上 maxDurationMs |
| 响应边界 32768/32769 | 均通过 | **包级契约测试钉住**（32768 逐字节通过/32769 → response_budget_exceeded 非静默截断） | `packages/pd-mcp-server/src/__tests__/budget-boundary.test.ts`（52/52 套件内） |
| 正常关闭 | ≥10 次 | **每宿主形态 20 次干净关停** | quant-probe shutdownOk 20/20 ×3 + 包级真实进程 10 次循环测试 |
| 重复安装幂等 | ≥3 次 | **Codex：plugin add ×3（0.3.0→重装→0.3.1）幂等**；WB/OC 安装器幂等由 installer 测试覆盖 | Phase C 隔离记录 + workbuddy-host-installer 56/56 |
| 更新失败回滚 | 故障注入 | **包级（binding 损坏 fail-closed + 恢复闭环已验证）；installer 事务机制复用既有单槽+备份（未重复造轮子）** | corrupt-binding 探针 + pd-setup 恢复闭环 |
| 配置保护 | 无关配置零变化 | **Codex：用户级 e2e-other MCP 保留；OC：operator mcp.servers 保留；WB：settings 其余字段保留** | Phase C/D/E 各卸载段记录 |
| 非回归 | 全绿 | **pd-mcp-server 52/52；core pain-recall 93/93；codex-adapter 全套 exit 0；installer WB 56/56；openclaw-plugin 2308 绿（4 预存在失败与 main 完全一致）** | 2026-11-03 各套件运行日志 |

---

## 2. Codex 0.166.0 — RUNTIME_VERIFIED（集成面）

| 验收项 | 结果 | 证据（全部隔离 CODEX_HOME） |
|---|---|---|
| marketplace add → plugin add | ✅ | `codex plugin add principles-disciple@principles`（隔离探针与 E2E 两次全流程） |
| manifest mcpServers Path 形态 → .mcp.json | ✅ | `codex mcp list` 显示 pd-recall（node ./mcp/launcher.cjs，cwd=已安装 cache 根） |
| pd-setup 真实安装 pinned runtime（含 pd-mcp-server@0.1.0 file: source）+ 写 binding | ✅ | pd-setup JSON 报告 `"ok": true` + mcp 字段；binding 文件内容核验 |
| 真实会话 spawn server | ✅ | `codex exec`（RUST_LOG=rmcp_client=info）捕获 `MCP server stderr (node): {"event":"startup","server":"pd-mcp-server","version":"0.1.0","host":"codex"}` |
| launcher 级协议 E2E | ✅ | initialize/tools_list/tools_call/extra-params-rejection/clean-shutdown/sanitized-stderr 6/6 |
| 模型驱动 tools/call（会话内） | ⏸ BLOCKED_BY_OWNER_QUOTA | Owner OpenAI 用量耗尽（重置 2026-11-06）；readOnlyHint 免审路径已由源码（mcp_tool_call.rs:2595-2612）+ 0.166 实验佐证；配额恢复后按本矩阵 §5 清单补一轮 |
| 生命周期：重装幂等/更新 0.3.1/CONFIG_MISSING 检测/setup 恢复/损坏 fail-closed/卸载保留用户 MCP | ✅ 全部 | Phase C 隔离序列逐项记录（commit 0b690008e 信息含全程） |
| 非回归 | ✅ | codex-adapter 全套 exit 0（含 first-run 真实 npm install 流程 59/59） |

## 3. OpenClaw 2026.10.5 — RUNTIME_VERIFIED

| 验收项 | 结果 | 证据（隔离 `--profile gate4`） |
|---|---|---|
| plugins install（本地路径 + capability consent） | ✅ | `plugins install … --force --accept-capabilities`；mcpServers=declared surface 加宽按宿主机制 consent（§A 核验预期一致） |
| manifest mcpServers → 工具进入 agent 目录 | ✅ | 真实 turn `tool-search: cataloged 60 tools`（含 pd-recall__pd_recall_principle_pains） |
| **真实模型驱动的 tools/call** | ✅ | zai/glm-5.3-flash 真实 turn：模型调用 `pd-recall__pd_recall_principle_pains`，逐字返回 `status: unavailable / error.code: source_missing`（空工作区真实 Capability 行为）——**三宿主中唯一在真实会话内完成的模型级调用** |
| binding 由插件写入（运行时解析 workspace） | ✅ 设计+单测 | mcp-binding.ts（5 单测：写入/幂等/组件缺失跳过/写失败结构化）；隔离环境观察：组件缺席时诚实跳过且不阻断（G4-07） |
| 生命周期：卸载保留 operator mcp.servers / 插件 hooks 全程健康 | ✅ | uninstall 后 `mcp list` 仅剩 e2e-other；PD surface-guard 日志全程无错误 |
| 非回归 | ✅ | openclaw-plugin 2308 绿（4 预存在失败与 main 一致，已逐字对照） |

## 4. WorkBuddy Desktop 5.9.2 — IMPLEMENTED_NOT_RUNTIME_VERIFIED（模型级）

| 验收项 | 结果 | 证据（隔离 CODEBUDDY_CONFIG_DIR/WORKBUDDY_CONFIG_DIR） |
|---|---|---|
| marketplace add → plugin install → 缓存载入（含 binding+launcher） | ✅ | 引擎命令真实执行；cache 0.2.1 目录含 .mcp.json/mcp/launcher.cjs/mcp-binding.json |
| defaultEnabled:false（install ≠ enable） | ✅ | 安装后 enabledPlugins=false；显式 enable 后 true（SPEC §6.4 保持） |
| WB 形态 launcher 协议 E2E（20/20 量化 + 单轮） | ✅ | quant-probe workbuddy 形态 20/20；占位符展开后 spawn 形态与宿主一致 |
| 生命周期：engine uninstall（cache 移除、settings 保留） | ✅ | 引擎 uninstall + settings.json 核验 |
| **真实会话内模型驱动 tools/call** | ⏸ BLOCKED_BY_HOST_AUTH | Desktop 会话令牌为 DPAPI 绑定、不可文件移植；`/login` 需交互式浏览器签到——隔离环境无法无头完成。**不以此降低判定；后续补验路径见 §5** |
| 非回归 | ✅ | workbuddy-adapter 构建绿 + installer WB 面 56/56 |

## 5. 判定表与补验路径

| 宿主 | 状态 | 依据 |
|---|---|---|
| Codex | **RUNTIME_VERIFIED（集成面）**；模型级调用待配额恢复补验 | 集成链路每一环均有真实运行证据；唯一缺口是模型会话内调用（外部配额阻断，非实现缺陷） |
| OpenClaw | **RUNTIME_VERIFIED（含真实模型级调用）** | 全链路含模型 turn 内真实 tools/call |
| WorkBuddy | **IMPLEMENTED_NOT_RUNTIME_VERIFIED** | 引擎级生命周期全绿 + launcher 协议 20/20；模型级调用被宿主认证阻断（外部条件，非实现缺陷） |

**SPEC §13 完成标准对照**：三宿主未全部达到模型级 RUNTIME_VERIFIED——按 SPEC §13/§14.1 诚实声明：**Gate 4 整体尚未达到"完整交付"判定**；两宿主 RUNTIME_VERIFIED + 一宿主 IMPLEMENTED_NOT_RUNTIME_VERIFIED 是本分支的真实状态。剩余两项补验（Codex 模型级 × 配额恢复；WB 模型级 × 一次交互式登录）均无实现工作，仅执行验证。

### §5.1 补验清单（Owner 协助项）
1. **Codex 模型级 10/10**：Owner OpenAI 配额恢复（2026-11-06）后，在隔离 CODEX_HOME 重跑一次 `codex exec` 调用会话即可（全部夹具已就绪于 `.tmp/codex-e2e/`）。
2. **WB 模型级 10/10**：需要一次 WorkBuddy Desktop 交互式 `/login`（或 Owner 在日常环境接受 pd-recall server 信任提示）。隔离环境无法替代此宿主认证。

---

## 6. 版本兼容矩阵（SPEC §9.3 发布清单锚点）

| 项 | 值 |
|---|---|
| PD release | 2.8.0（本分支基线） |
| @principles/core | 1.298.2（workspace）/ pin 列车 1.298.1 |
| @principles/pd-mcp-server | 0.1.0 |
| MCP SDK | `@modelcontextprotocol/server@2.4.0`（exact）+ `@modelcontextprotocol/core@2.4.0`（传递）+ `zod@4.6.7`（exact） |
| Node 运行时 | v26.7.0（engines ≥20） |
| Capability 协议 | pd.capability.v1 |
| 披露 profile | od-a-v1 |
| Codex 插件 | 0.3.0（payload 版本，pins 含 mcpServer 0.1.0） |
| OpenClaw 插件 | 2.2.12（manifest mcpServers + mcp/ 随包） |
| WorkBuddy 插件 | 0.2.2（payload，defaultEnabled:false） |
| 已验收宿主版本 | Codex CLI 0.166.0；OpenClaw 2026.10.5 (1b58cb9)；WorkBuddy Desktop 5.9.2（Electron 37.10.3-43） |
