---
"@principles/pd-mcp-server": patch
"@principles/host-runtime": patch
"@principles/workbuddy-adapter": patch
"create-principles-disciple": patch
---

OG-4：为**全部 WorkBuddy 部署**在生产 MCP 入口注册 `pd_submit_pain`（Owner 2026-11-13 授权，记录见 `docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md` §〇 r5）。Codex / OpenClaw 继续 recall-only。

- **接线**：`pd-mcp-server/src/index.ts` 在装配层按 `PD_MCP_HOST === 'workbuddy'` 显式传入 `enableSubmitTool: true` 与 `callSubmitCapability`。`server.ts` 的默认 gate 保持 `false`，不引入 env var / feature flag，OG-4 安全边界未降级。
- **config 绑定**：新增 `src/submit-assembly.ts`，复用 `host-runtime/pd-config` 的 `loadPdConfigForPlugin` 把 Core `submitPainCapability` 绑定到有效 `.pd/config.yaml`；config 校验失败时该宿主降级为 recall-only 并记日志，**绝不回落** `.state/workflows.yaml`（PRI-393）。`host-runtime` 新增 `./pd-config` 公共子路径导出，`pd-mcp-server` 新增 `@principles/host-runtime` 依赖。
- **治理**：`workbuddy-adapter/src/tool-semantics.ts` 登记 `pd_submit_pain → write`；宿主带前缀的 MCP 工具名不猜测，仍按 `other` 保守处理。
- **文档**：决策卡 r5 授权记录、SPEC §7.7 / TD §5.1.1 状态同步、`pd-mcp-server/README.md`、`2026-11-11-pain-submit-limited-rollout.md` 标记 SUPERSEDED。
- **回归**：真实 stdio 进程用例断言 WorkBuddy `tools/list` = 2 工具（`readOnlyHint:false`）、Codex/OpenClaw 仍 1 工具；pd-mcp-server 全套 161 passed；tool-semantics 5 passed；G4-1～G4-7 架构守卫全绿；eslint / tsc 0 错误。
- **发布**：改动涉及 installer 分发的 runtime，installer 必须随版本列车发版，否则已安装机器拿不到新 MCP Server。生效还需重启 WorkBuddy 会话（或 `/reload-plugins`）。
