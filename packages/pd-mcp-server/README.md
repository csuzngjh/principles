# @principles/pd-mcp-server

Principles Disciple 的正式 MCP Server —— 三个宿主（Codex、OpenClaw、WorkBuddy）共享的**同一份** Server 实现（SPEC-PD-MCP-GATE4-001）。每个宿主以插件内置 MCP 配置启动自己的 Server 子进程，业务数据**只**经 Gate 3 Capability（`@principles/core/runtime/pain-recall-capability`，OD-A v1 披露）读取。

## Tools

| Tool | 宿主 | 注解 |
|---|---|---|
| `pd_recall_principle_pains` | Codex / OpenClaw / WorkBuddy | 只读，`readOnlyHint: true` |
| `pd_submit_pain` | **仅 WorkBuddy**（OG-4，Owner 2026-11-13 授权） | 写工具，`readOnlyHint: false`；`server.ts` 的 `enableSubmitTool` 默认仍为 `false`，由 `index.ts` 在 `PD_MCP_HOST === 'workbuddy'` 时显式开启并注入绑定到有效 `.pd/config.yaml` 的 capability |

授权记录：`docs/implementation-reports/PD-MCP-GATE3-OWNER-DECISION-CARD.md` §〇 r5。不引入 env var / feature flag；config 校验失败时该宿主降级为 recall-only，绝不回落到 `.state/workflows.yaml`。

### `pd_recall_principle_pains` 契约（只读）

| 契约 | 值 |
|---|---|
| 输入 | `principleId`（1..200，必填）、`limit`（1..10，默认 3）；其余属性一律拒绝（协议层校验 + Capability 层复验） |
| 输出 | 单个 text content block，携带 `pd.capability.v1` JSON；不使用 structuredContent |
| 响应预算 | ≤ 32768 UTF-8 bytes（32768 通过 / 32769 拒绝 → `unavailable` + `response_budget_exceeded`，`isError:true`，绝不静默截断） |
| 调用截止 | 10 秒（handler 起算，含校验/Capability/投影/序列化；超时 = `tool_execution_failed`，迟到结果抑制；不宣称底层可取消） |
| isError=true | 仅两类：披露断言失败；Adapter 执行失败（预算超限/超时/异常/关闭中）——普通业务状态一律非错误 |
| 进程边界 | stdout 仅 MCP 协议消息；日志走 stderr（结构化脱敏 JSON）；无常驻 daemon |

## 工作区绑定（fail-closed）

业务 `workspaceDir` 是**启动配置**，绝不出现在 Tool 参数中。它由宿主插件的 PD 自有 `mcp-binding.json`（经 `launcher.cjs`）注入为环境变量 `PD_MCP_WORKSPACE_DIR`（可选 `PD_MCP_HOST` ∈ codex|openclaw|workbuddy）。绑定缺失/相对/不存在 → 启动即失败（stderr 一行结构化原因 + exit 1），**没有任何** `process.cwd()`/`HOME` 回退。

## 架构守卫

`src/__tests__/architecture-guards.test.ts` 机械保证：Core 零 MCP SDK 依赖；本包仅经 Capability 公共子路径访问业务；无 CLI 子进程查询；pd-cli 与本包互不依赖；SDK 精确锁版（`@modelcontextprotocol/server@2.4.0`）。

## 构建 / 测试

```bash
npm run build   # tsc → dist/
npm test        # build + vitest（协议契约 / 预算边界 / deadline / 绑定 / 真实进程 stdio / 架构守卫）
```

发布随 PD release 列车（changesets）；SDK 与 zod 均为精确锁版。
