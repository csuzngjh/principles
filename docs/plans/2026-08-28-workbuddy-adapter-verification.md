# PRI-560 复核：PD 适配 WorkBuddy 实证验证报告

> **2026-10-12 第二轮整改**：本文保留历史调研和取证，不是当前宿主运行验收。实现基线见 [SPEC v0.3.0](../specs/workbuddy-host-adapter-spec.md)，重点阅读 §4 契约、§5 改动面、§7 探针及 §8 验收。第一轮评审清单须逐项复核；“已改文字”不等于“已验证能力”。
> **开发状态**：可进入隔离探针开发；生产适配器按探针结论与 Owner 决策冻结后实施。历史引擎字符串命中仅证明存在性，不能证明实际触发、完整实现或用户效果。


> **日期**：2026-08-28
> **复核对象**：PRI-560 结论「可行，推荐混合方案（MVP-Quiet）」及配套文档 `docs/plans/2026-08-workbuddy-plugin-feasibility.md`
> **方法**：本机实证（非文献复述）——配置目录勘查 + 引擎二进制取证 + 运行时 HTTP 探测 + PD 源码核对
> **环境**：WorkBuddy 桌面版 5.3.14（build `825709d`），PD 仓库 `D:\Code\principles`

---

## 1. 一句话结论

**可行，但工单推荐的落地形态需要修正。**

已发现可继续验证的协议与共享实现路径，但端到端技术阻塞尚未全部消除，且 PD 侧已有比"新建混合方案"更好的现成路径。但工单方案所依赖的 `http` hook 类型存在 **fail-OPEN 语义**，与 PD 的治理闭环根本冲突（详见 §3.1，P0）。

---

## 2. 实证证据

### 2.1 WorkBuddy 宿主侧

取证位置：`D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy.js`（22MB，Agent 引擎本体）

> 取证要点：`app.asar`（283MB）是 Electron 主进程壳子，**不含 hook 实现**。在其中 grep 事件名会得到假阴性（`PostToolUse` = 0、`permissionDecision` = 0）。首次勘查曾据此误判，已在 `cli/dist/` 复核纠正。后续复核者请勿只在 `app.asar` 里搜。

| 验证项 | 结果 | 证据 |
|---|---|---|
| `plugin.json` 的 `hooks` 字段 | 支持 | `tencent-docx/0.3.0/.codebuddy-plugin/plugin.json` 实际声明 `"hooks": "./hooks/hooks.json"` |
| hook 类型 | `command`(64) / `http`(62) / `agent`(40) / `prompt`(34) | `codebuddy.js` 字面量计数 |
| 事件名（**27 个**。2026-08-28 更正：初版记 20 个系枚举遗漏，已按官方事件表逐一复核，27 个全部存在） | PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, Notification, PermissionRequest, PermissionDenied, Elicitation, ElicitationResult, PreCompact, PostCompact, InstructionsLoaded, ConfigChange, TaskCreated, TaskCompleted, TeammateIdle, FileChanged, CwdChanged, WorktreeCreate, WorktreeRemove, Setup | 同上；逐事件计数见 `docs/plans/2026-08-28-workbuddy-capability-map-for-pd.md` §1.1 |
| payload 字段 | `hook_event_name`(49) `tool_name`(88) `tool_input`(48) `tool_response`(17) `session_id`(85) `transcript_path`(35) | 同上 |
| 阻断语义 | `permissionDecision: "allow" \| "deny" \| "ask"`（52 处）；`continue` / `decision: "block"` | 同上 |
| 桌面版真实在用 | sheetagent(`SubagentStop`)、tencent-docx(`SessionStart`)、tencent-pptx(`PreToolUse` + `matcher: "Skill"`)（tencent-pptx 条 2026-10-12 复核存疑，见 §7 补记 6） | 已安装插件 `hooks/hooks.json` |
| 环境变量 | `${CODEBUDDY_PLUGIN_ROOT}` | tencent-pptx hooks.json |

**静态证据边界**：内置插件声明了 hooks，支持继续做真实探针；本次历史调研未运行这些 hooks，不能据配置存在证明桌面版实际触发。tencent-pptx 条本身另有存疑补记。

### 2.2 PD 侧

| 验证项 | 结果 |
|---|---|
| pd-console 存活 | `127.0.0.1:3100` LISTENING（PID 22916） |
| 现有 GET 端点 | `/api/v1/config/summary`、`/api/workspaces`、`/api/v1/activations`、`/api/v1/evidence-chain` 均 200 |
| **hook 事件接收端点** | **不存在**。`POST /api/v1/hooks/pre-tool-use` → 404（对照：上述端点 200，排除统一拦截） |
| 宿主适配先例 | **已有**。`packages/codex-adapter/` + `docs/adr/0020-codex-cli-host-adapter.md`（Status: Accepted） |
| 抽象层 | `packages/principles-core/src/host/`：`host-adapter.ts`、`host-installer.ts`、`index.ts` |

---

## 3. 工单需要修正的三处

### 3.1 【P0】`http` hook 是 fail-OPEN，与治理闭环冲突

从 `codebuddy.js` 提取的 HTTP hook 实现：

```js
// 非 2xx 响应
if (eu < 200 || eu >= 300)
  return { allowed: true, exitCode: eu, stdout: ec,
           systemMessage: `HTTP hook ${eA.url} returned ${eu}` };

// 网络异常 / 超时
catch (ec) { ...
  return { allowed: true, exitCode: -1, stderr: ec.message, error: ec, ... }; }

// 响应非法 JSON
catch { return { allowed: true, exitCode: 0, stdout: ec, message: ec.trim() || void 0 }; }

// 唯一拦截路径
let el = { allowed: false !== eA.continue && "block" !== eA.decision, ... };
```

**三条失败路径全部 `allowed: true`。** 即 pd-console 未启动、崩溃、超时、返回非 2xx、响应非 JSON —— 工具调用一律放行，且用户无感。

这与 PD 的核心承诺直接冲突：

- 价值主张"注入系统提示**强制遵守**"在 fail-open 下不成立；
- 情绪价值中的"降低失控感（是否生效不可知）"反而被放大——静默失效比不生效更糟；
- ADR-0020 §1 已记录同类陷阱（Codex E3：invalid output is fail-OPEN not fail-closed），本次是它的 HTTP 版本。

### 3.2 "引擎零重写"低估了工作量

混合方案要求 pd-console 提供 hook 事件接收端点，但**当前不存在**（§2.2 已证 404）。需要新增：路由 + 模型 + 事件适配层（WorkBuddy snake_case → `HostEvent`）。这不是零重写。

另需注意：`channel` 目前是三值语义 `prompt | code_tool_hook | defer_archive`，多处 SQL 硬编码 `WHERE channel = 'code_tool_hook'`（如 `sqlite-activation-safety-store.ts:137,188,189`）。接入新宿主需审查这些查询是否要纳入新 channel。

### 3.3 路径选型：应走 ADR-0020 已立的抽象，而非另起"混合方案"

ADR-0020 标题即 **"Multi-Platform Host Abstraction Layer"**，§1 明确写 "Future hosts (Claude Code, OpenCode, Pi) are anticipated"，且 §10（2026-08-13 Owner 批准）已定型：

> Both host packages become thin protocol adapters: `openclaw-plugin/` translates OpenClaw hook payloads and calls `@principles/host-runtime`; `codex-adapter/` validates/encodes Codex hook JSON and calls the same runtime.

三条 MVP-Core 路径：prompt injection / before-tool RuleHost enforcement / after-tool evidence capture。

**WorkBuddy 应作为第三个薄适配器，而不是旁路方案。** 走混合方案会让 WorkBuddy 成为唯一绕过 `HostAdapter` 抽象的宿主，重演 ADR-0020 §1 警告的 "each new host would fork the hook registration" 问题。

---

## 4. 推荐方案

新增 `packages/workbuddy-adapter/`，复用 `codex-adapter` 的 subprocess 模式：

```
packages/workbuddy-adapter/
├── src/
│   ├── host-adapter.ts          # WorkBuddyHooksHostAdapter implements HostAdapter
│   ├── pd-hook.ts               # 复用 codex-adapter 入口脚本模式
│   └── codec/
│       ├── input-decoder.ts     # stdin snake_case → HostEvent
│       └── output-encoder.ts    # HostEventResult → stdout JSON
├── plugin.json                  # "hooks": "./hooks/hooks.json"
└── hooks/hooks.json             # PreToolUse / PostToolUse，type: "command"
```

**为什么是 `command` 而非 `http`**：

| 维度 | http 类型 | command 类型 |
|---|---|---|
| 宿主形态 | 需 pd-console 常驻 | 子进程，`hostKind='subprocess'` |
| 失败语义 | **fail-OPEN（静默放行）** | 退出码 2 = blocking error，可 fail-closed |
| 复用成本 | 需新增 POST 端点 + 适配层 | 复用 `codex-adapter/src/pd-hook.ts` 模式 |
| 阻断字段 | `continue` / `decision:"block"` | `permissionDecision: allow\|deny\|ask` |
| 符合 ADR-0020 §10 | 否（绕过抽象） | 是（第三个薄适配器） |

`hostKind` 取值：OpenClaw = `inprocess`，Codex = `subprocess`，**WorkBuddy = `subprocess`** —— 与 Codex 同构，codec 可直接借鉴。

事件订阅建议：`PreToolUse`（RuleHost 闸门）、`PostToolUse`（痛点证据）、`SessionStart`（原则注入）。此历史建议漏列 UserPromptSubmit，不能声称四种事件一一对应。当前四事件及失败事件条件项以 SPEC v0.3 §4.2 为准。

Feature flag：沿用 `host.<id>.enabled = false`（默认关）约定，对齐 MVP-Quiet。

---

## 5. 遗留风险与未验证项

1. **未做端到端实测**：本次未修改用户全局配置挂探针（避免打断会话）。触发行为与 payload 字段齐全性为静态取证结论，置信度高但非运行时验证。
2. **Hooks 仍处 Beta**：桌面版 5.3.14 与工单引用的 CodeBuddy Code v1.16.0 文档非同一产品线，API 可能演进。
3. **`~/.codebuddy/settings.json` 在本机不存在**：工单"命名两套"的提醒成立，但实际配置落在 `~/.workbuddy/settings.json`（含 `enabledPlugins`）。写入路径需按目标版本确认。
4. **Plugin Agent 不能挂 hook**：与工单一致，拦截逻辑必须放插件级 `hooks.json`。
5. **与 WorkBuddy 记忆系统重叠**：PD 差异点必须是"可观测 + Owner 审批 + 可逆 + 带证据链"的治理闭环，否则价值不成立。

---

## 6. 当前下一步（取代原“唯一未闭环”结论）
1. 执行 SPEC §7.1 P01–P06：插件发现/启用/缓存、逐事件故障表现、真实成功/失败载荷、注入与恢复、运行依赖、工作区身份。
2. 明确 Owner 决策、支持范围和后台推进路径后冻结实现；历史 static grep 和 HTTP GET 200 不能替代上述验证。
3. Phase 1 检验真实安装包、生产并发写入、审批/撤回及后台闭环，回归 Codex/OpenClaw。不能预先称这些验证完成。
4. 首版不读 transcript，不启用 modifiedInput/updatedToolOutput；不用实现已排除能力作为开工门槛。

## 7. 补记（2026-10-12）

官方两份参考文档已完整存档：`docs/plans/2026-10-12-workbuddy-official-plugins-reference.md`、`docs/plans/2026-10-12-workbuddy-official-hooks-reference.md`（来源 `workbuddy.ai/docs/cli`，文档 lastUpdated 2026-09-17，文档站构建 commit `4a4c8c2c72d`）。以快照复核本报告：

1. **§5 遗留风险 2 的「非同一产品线」表述不准确，澄清如下**：桌面版引擎本体即 `cli/dist/codebuddy.js`，官方文档 canonical 指向 codebuddy.ai（CodeBuddy CLI 文档）——两者**同引擎同源**，差异只在发布列车与版本基线（桌面版 5.3.14 vs 文档基线 CodeBuddy Code v1.16.0+）。27 事件集两处一致，能力下限已确认；Beta 演进风险仍然存在，「按目标版本复核」的纪律不变。
2. **事件数三方口径不一，以取证为准**：官方 plugins-reference 事件表列 **26** 个（不含 `Setup`）；hooks 文档称「**27+** events」；本机二进制含 `Setup` 共 **27** 个（§2.1 表）。官方文档自身两处不一致，能力面以本机取证为准。
3. **官方文档不写 `http` 类型的失败语义**：四种类型仅在类型列表与一个 frontmatter 示例（`url` + `method: POST`）中出现，非 2xx / 超时 / 非法 JSON 的处理只字未提——§3.1 的 fail-OPEN P0 发现无任何文档依据，再次证明二进制取证不可省。
4. **安全门获官方确认**：`allowUntrustedFrontmatterHooks` 仅拦截 Agent/Skill frontmatter hooks（插件市场分发的 Agent/Skill 默认拒绝），plugin `hooks/hooks.json` **不受该门禁**——与 `2026-08-28-workbuddy-capability-map-for-pd.md` §5-2 取证一致，是走插件级 hook 的又一理由。
5. **中文站文档已作废**：`workbuddy.cn/docs/ide/Features/Hooks` 为旧版（7 事件、仅 command 类型），勿作信源；可行性文档 §8 的该条引用已标注作废。
6. **§2.1 tencent-pptx 条存疑**：2026-10-12 晚复核本机 `~/.workbuddy/plugins/cache/workbuddy-builtin/`——sheetagent（SubagentStop）与 tencent-docx（SessionStart）相符，但 tencent-pptx 三个缓存版本（5.6.2/5.7.6/5.7.7）均无 hooks 字段/目录。§2.1 该条 8-28 当时状态无法确证（疑被后续插件更新移除），标注存疑。
7. **本机已升级 5.8.1，本报告全部 5.3.14 计数类取证降级为「历史取证」**：2026-10-11 本机 WorkBuddy 从 5.3.14 升级至 5.8.1（install-manifest.json），引擎文件 `cli/dist/codebuddy.js` 已被替换为 `cli/dist/codebuddy-lite-wb.mjs`——§2.1 事件命中数、payload 字段计数、§3.1 http fail-OPEN 代码摘录及 capability-map §4.1「updatedToolOutput 0 命中」在当前机器均不可复现（现行引擎 27 事件全命中、updatedToolOutput 12 处命中）。复核纪律更新：先查 install-manifest 确认版本 → `ls` 引擎目录 → 在现行引擎上复核。「同引擎同源」实质仍成立（现行引擎 27 事件全命中佐证），本条为字面路径的更新依据。
