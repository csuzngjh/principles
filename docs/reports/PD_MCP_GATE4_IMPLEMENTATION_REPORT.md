# PD_MCP_GATE4_IMPLEMENTATION_REPORT

# Gate 4 实施报告（SPEC-PD-MCP-GATE4-001 v1.2 → 代码/测试/宿主证据）

| 字段 | 内容 |
|---|---|
| 实施工单 | PRI-1071（In Progress） |
| 授权 | OG-3 AUTHORIZED（2026-11-02，隔离环境 4-A～4-F）；D-06 方案 A OWNER_CONFIRMED（Decision Card §〇 r4） |
| 基线 | origin/main `457bbf0fc` → 分支 `ai/PRI-1071-mcp-gate4`（worktree `D:\Code\_worktrees\principles\PRI-1071-mcp-gate4`） |
| 交付形态 | 本地提交序列（不推送、不建 PR、不合并——授权边界）；PR 创建待 Owner 指示 |
| 状态 | **Gate 4 主体完成；两宿主 RUNTIME_VERIFIED，一宿主 IMPLEMENTED_NOT_RUNTIME_VERIFIED（外部条件阻断，补验路径明确）** |

---

## 1. 提交序列（全部本地，未推送）

| 提交 | 内容 |
|---|---|
| `64385e2e3` | 治理记录 r4（OG-3/D-06）+ SPEC v1.2 入库（头改 ACCEPTED，正文合同未动） |
| `f3f99959f` | Gate 4-A REALITY_CHECK（三宿主核验 + SDK 冻结 + 绑定冻结；含 Codex 真实运行探针） |
| `e8a5f7ba7` | Gate 4-B：`packages/pd-mcp-server`（52 测试：协议契约/预算边界/deadline/绑定/真实进程 stdio/G4-1..G4-7 守卫） |
| `0b690008e` | Gate 4-C：Codex 插件内置 MCP（.mcp.json + launcher + 四包 pin 列车 + pd-setup binding + pd-status 检测） |
| `382b635ff` | Codex 测试卫生（repo 载荷保护 + repair 路径 stub source） |
| `add5476dc` | Gate 4-D：OpenClaw manifest mcpServers |
| `59229d44a` | Gate 4-E：WorkBuddy 插件 .mcp.json（v0.2.2，defaultEnabled:false 保持） |
| `ca05f1fbc` | Gate 4-F：installer 组件打包 + 三宿主 binding 写入 + 卸载语义 + 测试 |

## 2. 架构落点（与 SPEC §3 逐条对应）

```text
宿主进程 ──spawn──> node <插件载荷>/mcp/launcher.cjs   （零依赖 canonical launcher，三宿主字节同源，G4-7 钉住）
                        │ 读 <载荷根>/mcp-binding.json  （PD 自有，机器级；三宿主各有唯一写入者）
                        │   Codex: pd-setup（安装后接线，插件 add 后重跑）
                        │   OpenClaw: 插件启动健康检查（与 hooks 同源运行时 workspace 解析）
                        │   WorkBuddy: installer 物化 marketplace 时（frozen workspace SSoT）
                        └ require(serverEntry=~/.pd/runtime/pd-mcp-server/dist/index.js)（in-process）
                                    │
                          pd-mcp-server（SDK @modelcontextprotocol/server@2.4.0 exact）
                                    │ 唯一 Tool pd_recall_principle_pains（readOnlyHint:true 诚实）
                                    └ @principles/core/runtime-v2/pain-recall-capability（Gate 3 Facade，OD-A v1）
```

- **32 KiB / 10s 归 Adapter**（budget.ts/deadline.ts）；**10 条/OD-A 归 Core**（未复制）；isError 两类映射严格服从 Gate 3 v0.5 §10.1。
- **fail-closed**：binding 缺失/损坏/相对路径/目录不存在 → exit 1 前置；无 cwd/HOME 业务回退。
- **守卫 G4-1..G4-7**（机械）：Core 零 MCP SDK；Capability 子路径唯一业务入口；无 CLI 子进程查询；pd-cli 独立；exact pin；版本一致；launcher 三载荷字节同源。

## 3. 验收结论（细节见 HOST_ACCEPTANCE_MATRIX / LIFECYCLE_ACCEPTANCE）

- 量化门槛：20/20 握手 ×3 形态、20/20 发现 ×3、20/20 真实调用 ×3（门槛 10）、≤1.05s/轮、32768/32769 包级钉住、关停 20×3 + 包级 10 循环、重复安装 ×3 幂等、更新/恢复/卸载/配置保护全过、非回归绿（4 个预存在失败与 main 逐字一致）。
- 宿主判定：**Codex RUNTIME_VERIFIED（集成面；模型级调用被 Owner OpenAI 配额阻断至 11-06）；OpenClaw RUNTIME_VERIFIED（含真实模型级调用——三宿主唯一）；WorkBuddy IMPLEMENTED_NOT_RUNTIME_VERIFIED（Desktop 令牌不可文件移植，需一次交互式登录）**。
- 按 SPEC §13：**尚未宣布"完整交付"**——剩余为两项纯执行验证（无实现工作）。

## 4. 复杂度增量（§13 Constitution gate）

```text
New durable source of truth: NO（binding 是派生接线文件，写入者唯一/宿主各一）
New persisted schema/state:  NO（binding 为 JSON 文件，无新库/迁移）
New subsystem/service/background process: NO（无 daemon；server 为宿主子进程）
New public abstraction/interface: YES — @principles/pd-mcp-server 包 + pd.mcp-binding.v1 契约
New runtime feature flag: NO
New cross-package dependency: YES — pd-mcp-server→core（经既有公共子路径）+ SDK（仅此包）
New host/platform-specific behavior: YES — 三宿主插件内嵌 MCP 配置（SPEC 产品目标本身）
New external/network capability: NO（stdio only，无联网）
```

YES 项论证：public 包是 SPEC G4-01 的直接交付物（零实现替代不存在）；跨包依赖方向被 G4-1/G4-2 机械守卫；宿主行为是产品合同本身。回滚：整分支单 revert；运行态回滚 = 卸载插件/binding 删除即 fail-closed 停服，不影响 PD 其他能力。

## 5. 授权边界遵守声明

- 未修改 Owner 日常宿主配置（全部隔离环境：CODEX_HOME / openclaw --profile / CODEBUDDY_CONFIG_DIR）。
- 未推送远端、未创建/合并 PR、未发布版本、未部署生产。
- 未扩大 Tool 范围（仍唯一只读）、未改 Hook/CLI/RuleHost/RuleCode 合同。
- 一次事故自纠：commit 0b690008e 曾误含 repo 载荷下的机器级 mcp-binding.json（fixture 副作用）——amend 移除 + fixture 清理 + 文件内顺序卫生测试防再犯。

## 6. 遗留（follow-up 候选，未自动实施）

1. `pd health` 聚合 MCP 段（若 Owner 要求 CLI 健康面）。
2. Codex 模型级 10/10 补验（配额恢复后，夹具就绪）。
3. WB 模型级 10/10 补验（需一次交互式登录）。
4. OpenClaw declared-surface consent 文案的产品化润色（现走宿主通用 consent 流）。
