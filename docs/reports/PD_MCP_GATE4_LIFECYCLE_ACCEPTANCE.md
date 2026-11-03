# PD_MCP_GATE4_LIFECYCLE_ACCEPTANCE

# Gate 4 生命周期验收（SPEC-PD-MCP-GATE4-001 §7/§11.3）

| 字段 | 内容 |
|---|---|
| 实施工单 | PRI-1071 |
| 日期 | 2026-11-02 ～ 2026-11-03 |
| 方法 | 每场景在隔离环境以真实宿主命令/真实安装器产物执行；失败注入为真实文件/状态操作（非 mock） |

## 1. 场景结果表（SPEC §11.3 对照）

| 场景 | 预期 | 结果 | 证据 |
|---|---|---|---|
| 首次安装 | 仅一个 PD MCP 注册 | ✅ | Codex：`codex mcp list` 恰一行 pd-recall；OC：manifest 单 server；WB：.mcp.json 单 server |
| 重复安装 | 不重复、不破坏 | ✅ | Codex `plugin add` ×3 幂等（同一 cache 目录复用）；WB/OC installer 幂等（WB installer 56/56 含 manifest set-union 断言） |
| 用户已有其他 MCP | 完整保留 | ✅ | Codex：`codex mcp add e2e-other` 后共存，卸载 PD 后仍存；OC：operator `mcp.servers.e2e-other` 保留 |
| 同名冲突 | 明确报告不覆盖 | ✅（宿主机制承载） | Codex catalog tier：用户 config 层覆盖插件同名（源码 `catalog.rs:118-137`，验证于 4-A）；OC：operator mcp.servers 同名覆盖插件（源码 `bundle-mcp.ts` ownership 规则）；PD 不写宿主用户级配置，冲突由宿主自身语义仲裁 |
| 配置损坏 | 备份并停止 | ✅ | binding 损坏 → launcher fail-closed（结构化 stderr + exit 1，零协议输出）；installer 侧既有 backup+atomic-replace 纪律复用（`writeHostJsonFileProtected` 测试仍在 56/56 内） |
| 更新成功 | 新版本生效 | ✅ | Codex 0.3.0→0.3.1（marketplace bump → plugin add → 新 cache 目录 0.3.1 → pd-status 4-pin 全对齐） |
| 更新失败 | 恢复上一版本 | ✅ | Codex 更新即 add（旧版本目录保留至新目录就绪，宿主原子语义）；binding 缺失由 pd-status CONFIG_MISSING 检出 + pd-setup 一次恢复闭环（实测）；installer 级更新沿用单槽+备份+事务（本分支未改动其语义，rollback 策略继承既有 release-manager 故障注入测试） |
| Repair | 只修 PD 资产 | ✅ | pd-setup 只写 PD 自有 binding/runtime；pd-status 只读宿主状态；安装器 repair-update-chain 未触碰 |
| Uninstall | 不影响其他 PD 能力 | ✅ | Codex：plugin remove 后 hooks/CLI/runtime 数据全保留（plugin-data runtime 仍在）；OC：extensions 目录移除但 operator 配置与治理工作区不动；WB：engine uninstall 仅清 cache，settings.json 其余字段保留 |
| 多宿主 | 各自独立 | ✅ | 三宿主各自进程/各自 binding/各自配置；隔离环境互不引用；共享的只有 ~/.pd/runtime 组件（既有单槽+备份机制） |
| 并发更新 | 不损坏 | ✅（继承） | 插件内嵌方案下 MCP 配置无独立更新通道（随插件 payload 走宿主安装器）；runtime 组件沿用既有 git-12 mutex + 事务机制；无新增并发写者 |

## 2. 失败注入实测（真实文件/状态操作）

1. **binding JSON 损坏**（`echo 'not json' > mcp-binding.json`）→ 连接被拒、launcher stderr 一行 `{"launcher":"pd-mcp","status":"failed","reason":"binding_unreadable","nextAction":...}`、exit 1、零 stdout。
2. **binding 丢失**（插件重装后 cache 重建）→ pd-status `mcpBinding=degraded (CONFIG_MISSING 语义)` + `pd-setup` 重跑恢复 → 探针复绿。
3. **server 组件缺席**（旧 runtime）→ OC 插件诚实跳过 binding 写入（reason=mcp_server_component_missing），宿主功能零影响；launcher 侧如被调用将 fail-closed 报 server_entry_missing。
4. **宿主更新清 payload**（Codex 0.3.1 更新实测）→ binding 随 cache 重建丢失 → 被检出并可一次恢复（上条）。

## 3. 责任边界遵守（SPEC §7.2）

- PD Installer：只写 PD 自有资产（runtime 组件 / binding / 自有 marketplace）；不写宿主用户级 MCP 配置；不覆盖 Marketplace 插件记录。
- 宿主插件管理器：负责插件安装/更新/启用/禁用/MCP 子进程生命周期——本分支未新增任何平行管理体系（无新 daemon、无新数据库、无第二套安装链）。

## 4. 遗留与观察

- `pd health` 未新增 MCP 段（P3 最小面：宿主侧诊断由 pd-status mcpBinding + launcher stderr 结构化原因承担；若 Owner 要求 CLI 健康面聚合，列为 follow-up）。
- 并发更新验收以"继承既有机制 + 无新增写者"论证，未新增专项故障注入（复用 release-manager 既有测试面）。
