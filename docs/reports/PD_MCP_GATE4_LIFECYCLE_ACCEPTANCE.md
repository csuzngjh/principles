# PD_MCP_GATE4_LIFECYCLE_ACCEPTANCE

# Gate 4 生命周期验收（SPEC-PD-MCP-GATE4-001 §7/§11.3）

| 字段 | 内容 |
|---|---|
| 实施工单 | PRI-1071 |
| 日期 | 2026-11-02 ～ 2026-11-03 |
| 基线 | origin/main `9ef8d607d`；整改最终 head `db33190b8`；分支 `ai/PRI-1071-mcp-gate4`（PR #2304，OPEN 未合并） |
| 方法 | 每场景在隔离环境以真实宿主命令/真实安装器产物执行；失败注入为真实文件/状态操作（非 mock） |

## 1. 场景结果表（SPEC §11.3 对照）

| 场景 | 预期 | 结果 | 证据 |
|---|---|---|---|
| 首次安装 | 仅一个 PD MCP 注册 | ✅ | Codex：`codex mcp list` 恰一行 pd-recall；OC：manifest 单 server；WB：.mcp.json 单 server |
| 重复安装 | 不重复、不破坏 | ✅ | Codex `plugin add` ×3 幂等（同一 cache 目录复用）；WB/OC installer 幂等（WB installer 58/58 含 manifest set-union 断言） |
| 用户已有其他 MCP | 完整保留 | ✅ | Codex：`codex mcp add e2e-other` 后共存，卸载 PD 后仍存；OC：operator `mcp.servers.e2e-other` 保留 |
| 同名冲突 | 明确报告不覆盖 | ❌ 未通过（PARTIAL：仅宿主优先级行为，PD 无冲突检测与报告） | 实测 Codex catalog tier：用户 config 层覆盖插件同名（源码 `catalog.rs:118-137`，验证于 4-A）；OC：operator mcp.servers 同名覆盖插件（源码 `bundle-mcp.ts` ownership 规则）。**但 SPEC §7.5/§11.3 要求 PD 明确报告冲突并停止安装；PD 安装器、`pd-setup.cjs`、`pd-status.cjs`、`mcp-binding.ts` 均不检测同名注册**——该门槛未满足 |
| 配置损坏 | 备份并停止 | ✅ | binding 损坏 → launcher fail-closed（结构化 stderr + exit 1，零协议输出）；installer 侧既有 backup+atomic-replace 纪律复用（`writeHostJsonFileProtected` 测试仍在 58/58 内） |
| 更新成功 | 新版本生效 | ✅ | Codex 0.3.0→0.3.1（marketplace bump → plugin add → 新 cache 目录 0.3.1 → pd-status 4-pin 全对齐） |
| 更新失败 | 恢复上一版本 | ❌ 未验证（PARTIAL） | 宿主更新清 cache 后 `mcp-binding.json` 丢失，launcher 以 `binding_missing` fail-closed，**不回退到旧版本**；pd-status 只报告 degraded，恢复需手动执行一次 `$pd-control setup`（实测）；installer 级更新沿用单槽+备份+事务（本分支未改动其语义），**本 PR 未做 MCP 更新失败注入，回滚证据为继承而非新验证** |
| Repair | 只修 PD 资产 | ✅ | pd-setup 只写 PD 自有 binding/runtime；pd-status 只读宿主状态；安装器 repair-update-chain 未触碰 |
| Uninstall | 不影响其他 PD 能力 | ✅ | Codex：plugin remove 后 hooks/CLI/runtime 数据全保留（plugin-data runtime 仍在）；OC：extensions 目录移除但 operator 配置与治理工作区不动；WB：engine uninstall 仅清 cache，settings.json 其余字段保留 |
| 多宿主 | 各自独立 | ✅ | 三宿主各自进程/各自 binding/各自配置；隔离环境互不引用；共享的只有 ~/.pd/runtime 组件（既有单槽+备份机制） |
| 并发更新 | 不损坏 | ✅（继承） | 插件内嵌方案下 MCP 配置无独立更新通道（随插件 payload 走宿主安装器）；runtime 组件沿用既有 git-12 mutex + 事务机制；无新增并发写者 |

## 2. 失败注入实测（真实文件/状态操作）

1. **binding JSON 损坏**（`echo 'not json' > mcp-binding.json`）→ 连接被拒、launcher stderr 一行 `{"launcher":"pd-mcp","status":"failed","reason":"binding_unreadable","nextAction":...}`、exit 1、零 stdout。
2. **binding 丢失**（插件重装后 cache 重建）→ pd-status `mcpBinding=degraded (CONFIG_MISSING 语义)` + `pd-setup` 重跑恢复 → 探针复绿。
3. **server 组件缺席**（旧 runtime）→ OC 插件不写 binding 并输出结构化 warning（reason=mcp_server_component_missing；整改轮起该 reason 也进入 `[PD:health] mcp-binding update skipped` 日志），宿主功能零影响；launcher 侧如被调用将 fail-closed 报 server_entry_missing。
4. **宿主更新清 payload**（Codex 0.3.1 更新实测）→ binding 随 cache 重建丢失 → 被检出即可手动一次恢复（上条：`$pd-control setup`，非自动回退旧版本）。

## 3. 责任边界遵守（SPEC §7.2）

- PD Installer：只写 PD 自有资产（runtime 组件 / binding / 自有 marketplace）；不写宿主用户级 MCP 配置；不覆盖 Marketplace 插件记录。
- 宿主插件管理器：负责插件安装/更新/启用/禁用/MCP 子进程生命周期——本分支未新增任何平行管理体系（无新 daemon、无新数据库、无第二套安装链）。

## 4. 遗留与观察

- **同名冲突检测未实现**：宿主自身优先级语义已验证，但 PD 侧无"明确报告并停止安装"（SPEC §7.5/§11.3）。当前状态标记为未通过，需后续补齐或由 Owner 裁定接受宿主语义。
- **更新失败无自动恢复**：binding 随宿主 cache 重建丢失后只能手动 `$pd-control setup` 恢复；未实现自动保留/恢复 binding（本 PR 不扩大实现面）。
- **多 agent 单 binding 限制**：OpenClaw 健康检查以 `{ agentId: 'main' }` 解析 workspace 并写入唯一的 `mcp-binding.json`；未配置 PD 显式工作区时，其他 agent 的 hook 使用各自 `ctx.workspaceDir`，但 MCP server 仍绑定 `main` 的工作区。属既有单绑定架构限制，重新设计三宿主插件架构不在本轮范围（follow-up）。
- `pd health` 已新增 MCP 诊断段（Gate 4 整改 P2：安装/入口、版本 pin、binding schema/host/workspace、宿主 MCP 配置、RESTART_REQUIRED、nextAction；**只读静态诊断，不启动 server、不执行业务 Tool，`probe.performed=false`**，见 `packages/pd-cli/src/commands/health-mcp.ts`）。
- 并发更新验收以"继承既有机制 + 无新增写者"论证，未新增专项故障注入（复用 release-manager 既有测试面）。
