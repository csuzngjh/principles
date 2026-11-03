# PD_MCP_GATE4_LIFECYCLE_ACCEPTANCE

# Gate 4 生命周期验收（SPEC-PD-MCP-GATE4-001 §7/§11.3）

| 字段 | 内容 |
|---|---|
| 实施工单 | PRI-1071 |
| 日期 | 2026-11-02 ～ 2026-11-03 |
| 基线 | origin/main `9ef8d607d`；上一轮整改 head `2fa6c54ed`；第三轮整改提交见 PR #2304 时间线（不预判最终 head）；分支 `ai/PRI-1071-mcp-gate4`（OPEN 未合并） |
| 方法 | 每场景在隔离环境以真实宿主命令/真实安装器产物执行；失败注入为真实文件/状态操作（非 mock） |

## 1. 场景结果表（SPEC §11.3 对照）

| 场景 | 预期 | 结果 | 证据 |
|---|---|---|---|
| 首次安装 | 仅一个 PD MCP 注册 | ✅ | Codex：`codex mcp list` 恰一行 pd-recall；OC：manifest 单 server；WB：.mcp.json 单 server |
| 重复安装 | 不重复、不破坏 | ✅ | Codex `plugin add` ×3 幂等（同一 cache 目录复用）；WB/OC installer 幂等（WB installer 58/58 含 manifest set-union 断言） |
| 用户已有其他 MCP | 完整保留 | ✅ | Codex：`codex mcp add e2e-other` 后共存，卸载 PD 后仍存；OC：operator `mcp.servers.e2e-other` 保留 |
| 同名冲突 | 明确报告不覆盖 | ✅（第三轮整改，2026-11-03；历史状态见 §5） | 三宿主统一分类器（`installers/mcp-registration-conflict.ts`）：同名 PD launcher → 幂等；同名他方 server → 安装前停止且配置 sha256/mtime 不变；不同名共存；损坏/归属不明 → fail-closed。OpenClaw/WorkBuddy installer、Codex `$pd-control setup`、`pd health` 均接入；真实临时目录测试 14/14。证据见 §2.1 |
| 配置损坏 | 备份并停止 | ✅ | binding 损坏 → launcher fail-closed（结构化 stderr + exit 1，零协议输出）；installer 侧既有 backup+atomic-replace 纪律复用（`writeHostJsonFileProtected` 测试仍在 58/58 内） |
| 更新成功 | 新版本生效 | ✅ | Codex 0.3.0→0.3.1（marketplace bump → plugin add → 新 cache 目录 0.3.1 → pd-status 4-pin 全对齐） |
| 更新失败 | 恢复上一版本 | ✅（第三轮整改，2026-11-03，见 §2.2；历史状态见 §5） | 真实临时 WorkBuddy 环境 + 真实安装器：同版本变更 payload → 旧 cache 备份 → 新 cache 替换 → `installed_plugins.json` 只读导致注册提交失败 → 安装器回滚；旧 cache 逐文件 sha256 一致、旧 binding 保留、settings/registry sha256 不变、staging 清理；随后真实 launcher 完成 initialize/tools/list/tools/call 并返回旧工作区数据 |
| Repair | 只修 PD 资产 | ✅ | pd-setup 只写 PD 自有 binding/runtime；pd-status 只读宿主状态；安装器 repair-update-chain 未触碰 |
| Uninstall | 不影响其他 PD 能力 | ✅ | Codex：plugin remove 后 hooks/CLI/runtime 数据全保留（plugin-data runtime 仍在）；OC：extensions 目录移除但 operator 配置与治理工作区不动；WB：engine uninstall 仅清 cache，settings.json 其余字段保留 |
| 多宿主 | 各自独立 | ✅ | 三宿主各自进程/各自 binding/各自配置；隔离环境互不引用；共享的只有 ~/.pd/runtime 组件（既有单槽+备份机制） |
| 并发更新 | 不损坏 | ✅（继承） | 插件内嵌方案下 MCP 配置无独立更新通道（随插件 payload 走宿主安装器）；runtime 组件沿用既有 git-12 mutex + 事务机制；无新增并发写者 |

## 2. 失败注入实测（真实文件/状态操作）

1. **binding JSON 损坏**（`echo 'not json' > mcp-binding.json`）→ 连接被拒、launcher stderr 一行 `{"launcher":"pd-mcp","status":"failed","reason":"binding_unreadable","nextAction":...}`、exit 1、零 stdout。
2. **binding 丢失**（插件重装后 cache 重建）→ pd-status `mcpBinding=degraded (CONFIG_MISSING 语义)` + `pd-setup` 重跑恢复 → 探针复绿。
3. **server 组件缺席**（旧 runtime）→ OC 插件不写 binding 并输出结构化 warning（reason=mcp_server_component_missing；整改轮起该 reason 也进入 `[PD:health] mcp-binding update skipped` 日志），宿主功能零影响；launcher 侧如被调用将 fail-closed 报 server_entry_missing。
4. **宿主更新清 payload**（Codex 0.3.1 更新实测）→ binding 随 cache 重建丢失 → 被检出即可手动一次恢复（上条：`$pd-control setup`，非自动回退旧版本）。

### 2.1 三宿主同名注册冲突（第三轮，2026-11-03）

- 注入：在真实临时宿主配置中写入 `pd-recall` 指向第三方 server（Codex `config.toml` `[mcp_servers.pd-recall]`、OpenClaw `openclaw.json` `mcp.servers["pd-recall"]`、WorkBuddy `mcp.json` `mcpServers["pd-recall"]`）。
- 实测：`create-principles-disciple` 安装器与 `$pd-control setup` 在任何写入前 `success:false / exit 1`；原文件 sha256 与 mtime 不变；marketplace / settings / cache / plugin-data 均未创建。
- 不同名 MCP（`comfyui` / `lighthouse`）共存且安装继续；损坏 JSON / 不可归属条目（`{}`、inline `mcp_servers = {...}`）→ `unverifiable`，不覆盖不清理。
- 证据：`packages/create-principles-disciple/tests/mcp-registration-conflict.test.ts` 14/14；`packages/pd-cli/tests/commands/health-mcp.test.ts` 19/19（含 `mcp_same_name_conflict` / `mcp_registration_unverifiable`）。

### 2.2 WorkBuddy 更新失败回滚（第三轮，2026-11-03）

- 场景：真实临时 HOME → 安装 v0.3.0（engine 不可达的 direct-write 路径）→ 创建旧 cache + 有效 `mcp-binding.json` + settings/registry → 修改同版本 payload → **真实故障注入**：`installed_plugins.json` 置只读，使注册提交在「旧 cache 已备份、新 cache 已替换」之后失败。
- 实测：安装器返回 `workbuddy_registration_commit_failed` 并声明 `Previous cache and registration state restored`；旧 cache 逐文件 sha256 与注入前一致（含 binding），settings/registry sha256 不变；staging 与 cache backup 无残留。
- 恢复后真实 launcher（cache 内 `mcp/launcher.cjs`，cwd=cache 根）完成 initialize → tools/list（唯一 Tool + readOnlyHint）→ tools/call：旧工作区 principle 返回 `unavailable/source_missing`（ledger 已解析），非本工作区 principle 返回 `not_found`；startup 日志 workspace fingerprint 与旧工作区一致。
- 证据：`packages/create-principles-disciple/tests/workbuddy-update-rollback-fault-injection.test.ts`（真实注入 + 真实进程）。

## 3. 责任边界遵守（SPEC §7.2）

- PD Installer：只写 PD 自有资产（runtime 组件 / binding / 自有 marketplace）；不写宿主用户级 MCP 配置；不覆盖 Marketplace 插件记录。
- 宿主插件管理器：负责插件安装/更新/启用/禁用/MCP 子进程生命周期——本分支未新增任何平行管理体系（无新 daemon、无新数据库、无第二套安装链）。

## 4. 遗留与观察

> 第三轮整改（2026-11-03）后，本节的“同名冲突未实现 / 更新失败无自动恢复 / 多 agent 单 binding”三项已由 §2.1、§2.2 与 §4.1 取代；以下保留为整改前的历史观察，不删除。

- ~~**同名冲突检测未实现**~~（历史，已由 §2.1 修复）：宿主自身优先级语义已验证，但 PD 侧无"明确报告并停止安装"（SPEC §7.5/§11.3）。
- ~~**更新失败无自动恢复**~~（历史；本条指 Codex 宿主更新清 payload 后的 binding 手动恢复，仍保留；WorkBuddy 安装器级更新失败回滚已由 §2.2 验证）：binding 随宿主 cache 重建丢失后只能手动 `$pd-control setup` 恢复。
- ~~**多 agent 单 binding 限制**~~（历史，已由 §4.1 修复）：OpenClaw 健康检查曾以 `{ agentId: 'main' }` 解析 workspace 并写入唯一 `mcp-binding.json`。
- `pd health` 已新增 MCP 诊断段（Gate 4 整改 P2：安装/入口、版本 pin、binding schema/host/workspace、宿主 MCP 配置、RESTART_REQUIRED、nextAction；**只读静态诊断，不启动 server、不执行业务 Tool，`probe.performed=false`**，见 `packages/pd-cli/src/commands/health-mcp.ts`）。
- 并发更新验收以"继承既有机制 + 无新增写者"论证，未新增专项故障注入（复用 release-manager 既有测试面）。

### 4.1 OpenClaw 多工作区 Binding 隔离（第三轮，2026-11-03）

- 修复：MCP binding 只允许由**显式声明的 PD 工作区**（`PD_WORKSPACE_DIR` / `OPENCLAW_WORKSPACE` / `~/.openclaw/principles-disciple.json`）写入；无显式声明时健康检查删除旧 binding，launcher 以 `binding_missing` fail-closed。禁止从 `main` agent、`ctx.workspaceDir`、`cwd`、`HOME` 或宿主默认路径推断。
- 隔离：不同 agent 的 hooks 仍按各自 `ctx.workspaceDir` 工作；共享 MCP Server 在无显式全局工作区时不可用（诚实失败，而非串用）。
- 运行证据（真实进程，非 JSON 内容断言）：Agent X / Agent Y 各自 payload + binding，launcher cwd 指向第三目录；server startup stderr 的 `workspaceFingerprint` 分别等于 X / Y 的工作区指纹；X 调 X 的 principle → `unavailable/source_missing`（ledger 已解析），X 调 Y 的 principle → `not_found`，反向亦然。
- 证据：`packages/openclaw-plugin/tests/core/mcp-binding-isolation.test.ts` 6/6；`packages/openclaw-plugin/tests/integration/mcp-launcher-workspace-isolation.test.ts` 3/3（含 binding 缺失 fail-closed）。

## 5. 历史快照

整改前（head `db33190b8`）的 §1 行状态（同名冲突 ❌ PARTIAL、更新失败 ❌ 未验证）与 §2 第 1–4 条、§4 前三条保留在上述历史记录中；本节之前的正文已按当前实现更新，不以历史失败改写为 PASS。
