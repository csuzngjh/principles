---
"@principles/pd-mcp-server": patch
"@principles/host-runtime": patch
"@principles/workbuddy-adapter": patch
"@principles/codex-adapter": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

OG-4：为 **Codex / OpenClaw / WorkBuddy 三宿主全部部署**在生产 MCP 入口注册 `pd_submit_pain`（Owner 2026-11-13 授权，记录见 `docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md` §〇 r5 + r6；r6 把 r5 的 WorkBuddy 单宿主范围扩展为三宿主）。

- **接线**：`pd-mcp-server/src/index.ts` 在装配层对任一**已知** `PD_MCP_HOST`（codex / openclaw / workbuddy）显式传入 `enableSubmitTool: true` 与 `callSubmitCapability`；host 标记**缺失**时保持 recall-only，**存在但未知**时启动失败（`host_invalid`，exit 1）。`server.ts` 的默认 gate 保持 `false`，不引入 env var / feature flag，OG-4 安全边界未降级。
- **config 绑定**：新增 `src/submit-assembly.ts`，复用 `host-runtime/pd-config` 的 `loadPdConfigForPlugin` 把 Core `submitPainCapability` 绑定到有效 `.pd/config.yaml`，并按启动绑定传入 `hostKind` 使各宿主记录可归因；config 校验失败时该宿主降级为 recall-only，日志只记固定原因码（`errors[].reason` 可能含绝对路径或 YAML 片段，禁止入日志），**绝不回落** `.state/workflows.yaml`（PRI-393）。`host-runtime` 新增 `./pd-config` 公共子路径导出，`pd-mcp-server` 新增 `@principles/host-runtime` 依赖；`bundle-plugin.mjs` 的 MCP staged 清单同步把该依赖改写为 `file:../host-runtime`，否则自包含发布构建会回退到 registry 解析。
- **治理**：Codex PreToolUse matcher 扩展为 `Bash|apply_patch|pd_submit_pain`（事件可被观察到）；**tool-semantics 分类有意不登记**，三宿主均解析为 `other`。理由：`CanonicalKind` 是文件变更轴，`write` 会进入 `computeBehaviorFacts.writeCount` 并关闭 `other ⇒ facts incomplete` 的保守闸门，而该工具写账本、payload 无目标路径；OpenClaw `hooks/gate.ts:363-366` 只路由 write/bash/agent 三族，登记会造出 `hasHostTool` 为真却永不触发的假声明（PRI-741）。解析为 `other` 时 rule-context provider 挂起而非断言事实。待 `CanonicalKind` 支持非文件变更或实机取证后补登记。
- **文档**：决策卡 r5 + r6 授权记录、SPEC §7.7 / TD §5.1.1 状态同步、`pd-mcp-server/README.md`、`2026-11-11-pain-submit-limited-rollout.md` 标记 SUPERSEDED。
- **回归**：真实 stdio 进程用例断言三宿主 `tools/list` 均为 2 工具（`readOnlyHint:false`）、host 缺失时仍 1 工具；pd-mcp-server 全套、3 份 tool-semantics 契约、Codex hook matcher 契约、G4-1～G4-7 架构守卫全绿；eslint / tsc 0 错误。
- **发布**：改动涉及 installer 分发的 runtime，installer 必须随版本列车发版，否则已安装机器拿不到新 MCP Server。生效还需重启各宿主会话（或 `/reload-plugins`）。
- **已知既有红灯**：`mcp-binding-contract-parity.test.ts` 在 origin/main 上因 `758dd2f51 (#2614)` 新增 5 个 `experiment_*` launcher reason code 未同步契约声明而失败；该失败在主树旧基线复跑 40/40 通过，非本变更引入。
