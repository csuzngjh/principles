# PD 内置技能多宿主重复度盘点与收敛评估

- 日期：2026-11-11
- 状态：盘点 + 评估（只读，未改任何代码或技能文件）
- 基线：`origin/main`，工作区 `d:\Code\principles`

> **结论已修订（2026-11-11 第二轮）**：Owner 定方向为"直接做 PD 通用技能层"，并进一步判断 `pd-pain-signal` 的创建能力已收敛到 MCP 工具、技能应整份退场。本文件保留原始盘点证据；终态判定、分层设计与落地规划以
> [`2026-11-11-pd-builtin-skills-unified-layer-plan.md`](../plans/2026-11-11-pd-builtin-skills-unified-layer-plan.md) 为准。
> 修订要点：①终态技能数为 **2 个**（`pd-cli-operator`、`pd-control`），`pd-pain-signal` 与 `pd-review` 退场；②Codex 侧已确认**已安装启用 0.3.22**，此前"未安装"的判断作废，真实状态是"MCP 未绑定"。

> **硬约束补充（2026-11-11 第五轮，Owner）**：本文件记录的"多套副本"事实，必须按以下四条约束做终态判断；验收判据见 plan 文档 §0.2：
>
> | # | 约束 |
> |---|---|
> | H1 | 三个宿主必须各自安装**同一套**技能；任何宿主不得是别人的子集 |
> | H2 | `pd-cli-operator` 必须三宿主都装——它是"PD CLI 存在"的唯一知情来源 |
> | H3 | 移除必须三处同时发生（OpenClaw zh/en 计两处，共 4 个交付目录），同一 PR 内完成，不允许分批与中间态 |
> | H4 | 格式可适配、内容不分区：同一份正文按宿主渲染命令与入口，不允许"每宿主只拿自己那一节" |
>
> 另：**能力缺失必须显式声明**（"本宿主不支持什么、该走哪条路"），不得整段删除——否则智能体会编造不存在的命令。详见 plan 文档 §7.4 与 WorkBuddy `pd-control` 的现成范式。
>
> 本文件 §1 的"4 个交付目录"清单是这四条约束的**观测面**：平价断言必须同时读这 4 个目录。

---

## 1. 分发位置清单

| # | 宿主 / 变体 | 路径 | 技能数 |
|---|---|---|---|
| 1 | OpenClaw（zh） | `packages/openclaw-plugin/templates/langs/zh/skills/` | 4 |
| 2 | OpenClaw（en） | `packages/openclaw-plugin/templates/langs/en/skills/` | 4 |
| 3 | Codex | `plugins/principles-disciple/skills/` | 4 |
| 4 | WorkBuddy | `packages/workbuddy-adapter/plugin/skills/` | 4 |

全仓扫描（排除 `node_modules` / `.tmp` / `dist`）确认**无第五处**：`packages/principles-core`、`packages/pd-mcp-server`、`packages/host-runtime` 下均无 `SKILL.md`。

### 1.1 逐文件尺寸与哈希（前 12 位）

| 技能 | OpenClaw-zh | OpenClaw-en | Codex | WorkBuddy |
|---|---|---|---|---|
| `pd-cli-operator` | 5,120 B / `D0389E8A3EB7` | 5,653 B / `73DA79132D0B` | 4,987 B / `F5DD358DAF8A` | 3,783 B / `9CD24F9F36BA` |
| `pd-control` | 2,602 B / `3E44B622E5DB` | 2,880 B / `A97540B8D26E` | 3,915 B / `35C63D966569` | 1,537 B / `DA7BFA41B568` |
| `pd-pain-signal` | 3,024 B / `68C44D78D071` | 3,369 B / `98F8F67BB42B` | 9,094 B / `1D46587E3324` | 8,427 B / `62879BA43463` |
| `pd-review` | 1,603 B / `5F2CEF567E85` | 1,855 B / `151592B77452` | 1,978 B / `1FA09BA4E40A` | 1,366 B / `829A9B25E5AB` |
| **合计** | **12,349 B** | **13,757 B** | **19,974 B** | **15,113 B** |

全量 **16 个文件 / 61,193 B**。

## 2. 重复度结论

- **0 个文件字节级相同**：16 份 SHA256 两两不同。
- OpenClaw zh 与 en 是翻译关系，但同一技能的正文结构也不完全对齐。
- Codex / WorkBuddy / OpenClaw 之间是**各自独立撰写**：同一技能跨套的非空重复行仅 1–7 行，且几乎都是命令字面量（如 `pd pain explicit`）。
- 结论：当前不是"一份正文 + 少量差异"，而是 **4 份独立文档**。

## 3. 实质性差异明细

### 3.1 `pd-pain-signal`（分裂最严重）

| 变体 | 入口口径 | 是否跟上锚点主线 |
|---|---|---|
| Codex（9,094 B） | 原生前缀 `PD记录痛苦：` + `pd_submit_pain`（MCP）+ 命令兜底 | 是 |
| WorkBuddy（8,427 B） | `pd_submit_pain` + `PD记录痛苦：` 前缀 + 固定工作区 | 基本是，缺锚点契约细节 |
| OpenClaw zh（3,024 B） | `/pd-pain` + `pd pain record --session` | **否，仍是旧 CLI 口径** |
| OpenClaw en（3,369 B） | 同上（英文） | **否** |

这不是措辞差异，是**入口契约不同**，也是"四份独立维护"已经发生漂移的直接实证。

### 3.2 `pd-control`

动作集合相同（setup / disable / enable / repair），但每个动作的命令完全按宿主不同：

- Codex：`pd-locate.cjs --exec scripts/pd-setup.cjs`（`pd-control:14-21`）
- WorkBuddy：只有停用路径（`:16-24`）
- OpenClaw：`openclaw plugins disable` / `enable`（`:27`、`:35`）

### 3.3 `pd-cli-operator`

Codex 与 OpenClaw 都强调"定权威工作区"，但 Codex 的治理工作区与项目目录分离、OpenClaw 靠命令上下文解析，WorkBuddy 侧写明固定工作区。命令表大体一致。

### 3.4 `pd-review`

四份都只有一条命令 + 一条治理边界。OpenClaw 版最长（1,855 B），因为它额外说明了"打开不等于批准"的措辞差异。内容高度重合。

## 4. 现有测试钉住了什么

| 测试 | 覆盖范围 | 钉住的约束 | 局限 |
|---|---|---|---|
| `packages/openclaw-plugin/tests/templates/pd-pain-skill-contract.test.ts` | 仅 OpenClaw zh/en | `/pd-pain` 存在、失败动作不得留空 | 不覆盖 Codex / WorkBuddy |
| `packages/pd-cli/tests/commands/cli-skill-contract.test.ts` | 全部 4 处 | 技能里出现的 `pd <cmd>` 必须在 CLI 注册表存在 | 只验命令可解析，不比对内容 |
| `packages/codex-adapter/tests/codex-plugin-bundle.test.ts` | 仅 Codex | 含 `PD记录痛苦：`、`pd pain explicit` | 单侧 |
| `packages/workbuddy-adapter/tests/plugin-skeleton.test.ts` | 仅 WorkBuddy | frontmatter、含 `.workbuddy/pd-workspace` | 单侧 |
| `packages/openclaw-plugin/tests/manifest-skills.test.ts` | 仅 OpenClaw | 四技能集合、frontmatter、`disable-model-invocation` | 单侧；且记录了"同时声明 zh/en 导致静默锁 en"的历史事故 |
| `packages/create-principles-disciple/tests/workbuddy-skill-delivery.test.ts` | WorkBuddy | 安装缓存 == adapter 源 | 是投递完整性，不是跨宿主一致性 |

**关键缺口：没有任何测试做跨宿主内容比对。** 这是副本能长期各自漂移的直接原因。

### 4.1 跨宿主平价断言实测（2026-11-11 第五轮补测）

按 H1/H2/H3 要求应当存在的"跨宿主技能集完全相同"断言，仓库里**不存在**（上表 6 处全是单宿主或仅命令可解析）。以只读脚本等价执行后结果如下：

```
openclaw-zh  count=4 [pd-cli-operator, pd-control, pd-pain-signal, pd-review] problems=none
openclaw-en  count=4 [同上] problems=none
codex        count=4 [同上] problems=none
workbuddy    count=4 [同上] problems=none
两两 missing=[] extra=[]
```

- 结论：**GREEN**。三宿主不是彼此的子集，`pd-cli-operator` 四处都在。
- 已安装侧同样一致：`~/.pd/workbuddy-marketplace`、`~/.codex/plugins/cache/principles/principles-disciple/0.3.22/skills`、`~/.workbuddy/.../0.2.2/skills` 各 4 项；`~/.openclaw/extensions/principles-disciple` 的 4 项在 `templates/langs/{zh,en}/skills` 下（扩展根目录没有 `skills/`）。
- **关键局限**：该断言只比名称与数量，**抓不住内容漂移**。本文件 §3.1 记录的 OpenClaw zh/en `pd-pain-signal` 旧 CLI 口径，正是在"名称完全一致"的情况下发生的。真正的同源守卫必须靠渲染 `--check`（plan 文档 AC-4）。

另外，删除的原子性（H3）也**没有**任何机械保证：4 处目录、4 处集合常量（`manifest-skills.test.ts`、`verify-build.mjs`、`WORKBUDDY_REQUIRED_SKILLS`、Codex bundle 测试）分别独立，分批删除不会被任何现有测试拦住。

### 4.2 即便新增平价测试，今天的 CI 也不会执行它

`scripts/ci/impact.mjs` 对三个技能投递路径族的分类（`SCOPE_BY_DIR` 见 `:39`，docs 兜底见 `:71` / `:201`，`docsOnly` 见 `:222`）：

| 路径族 | 分类 | 结果 |
|---|---|---|
| `packages/openclaw-plugin/templates/langs/*/skills/**` | `plugin` | installer 不在消费闭包 → `test-create-principles-disciple` skip |
| `packages/workbuddy-adapter/plugin/skills/**` | `workbuddyAdapter` | 同上（`impact.test.ts:203-209` 证明 `affectedPackages` 只有该包） |
| `plugins/principles-disciple/skills/**` | `docs`（`.md` 命中后缀规则） | 技能-only PR 判 `docsOnly` → 零 job |

所以"加测试"与"测试生效"是两件事：还需把这三个路径族映射到 `scopes.installer`（AC-8，plan §7.2.2）。这是漂移能长期存在的第二层原因。

## 5. 构建与投递链（已核实）

| 环节 | 事实 |
|---|---|
| OpenClaw | `openclaw.plugin.json` 只声明 `templates/langs/zh/skills`；安装期按语言重写清单到 en。`packages/openclaw-plugin/scripts/verify-build.mjs` 对每种语言强制"技能集合不多不少" |
| Codex | `codex plugin list` → `principles-disciple@principles installed, enabled 0.3.22`，源为仓库本地 marketplace；插件缓存 `~/.codex/plugins/cache/principles/principles-disciple/0.3.22/` 含 `mcp/launcher.cjs` 与 4 个 skills |
| WorkBuddy | `packages/workbuddy-adapter/plugin/` 作为骨架随 adapter 包发布，安装器 stage 到 `~/.pd/workbuddy-marketplace/`；`WORKBUDDY_REQUIRED_SKILLS` 硬编码在 `workbuddy-host-installer.ts:75` |
| 运行时绑定 | 三宿主都用字节级相同的 `mcp/launcher.cjs`，由 G4-7 架构守卫强制；绑定文件为 `mcp-binding.json` |

## 6. 三宿主 MCP 实测结果

方法：用各宿主已安装载荷自带的 `mcp/launcher.cjs` 启动，真实 MCP 握手后取 `tools/list`。只读，未修改任何宿主配置。

| 宿主 | 载荷路径 | 结果 |
|---|---|---|
| OpenClaw | `~/.openclaw/extensions/principles-disciple` | `["pd_recall_principle_pains"]`，**PASS** |
| WorkBuddy | `~/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.2` | 同上，**PASS** |
| Codex（仓库 marketplace 根） | `D:\Code\principles\plugins\principles-disciple` | `{"status":"failed","reason":"binding_missing","nextAction":"Re-run the PD host setup (Codex: $pd-control setup) ..."}` |
| Codex（插件缓存） | `~/.codex/plugins/cache/principles/principles-disciple/0.3.22` | 同上，`binding_missing` |

**开关事实**：不存在 `--enable-submit-tool`。`enableSubmitTool` 只能是代码参数：

- `packages/pd-mcp-server/src/server.ts:197-200`：注释明确 "no env var or feature flag can change it"。
- `packages/pd-mcp-server/src/index.ts:29-32`：进程入口从不开启。
- `packages/pd-mcp-server/src/index.ts:227-231`：`main()` 只传 `workspaceDir / host / logSink`，无 argv 解析。

→ 三宿主真实写入验收（写入 → 读回 → 回执校验）记 **NOT_RUN**，原因是**缺少受支持的开启方式（产品缺口）**，不是环境限制。

## 7. 两个前缀入口的查证

| 入口 | 实现 | 结论 |
|---|---|---|
| Codex `PD记录痛苦：` | `packages/codex-adapter/src/ingestion/explicit-owner-statement.ts`（`parseOwnerStatementPrefix` / `recordExplicitOwnerStatement`），UserPromptSubmit hook 驱动 | **真实代码路径**，非提示词约定 |
| WorkBuddy `PD记录痛苦：` | `packages/workbuddy-adapter/src/explicit-owner-statement.ts:9-52`，`pd-hook.ts:300` 预留前缀 | **真实代码路径** |
| OpenClaw `/pd-pain` | `packages/openclaw-plugin/src/index.ts:1067-1082`，`registerCommand` | **真实代码路径** |

三者在技能删除后仍完整可用，且自带回执/拒绝文案。

## 8. 原始评估（已被第二轮修订取代，保留备查）

原评估建议"单一源 + 构建期按宿主渲染"，并把技能集合收敛为 4→3。第二轮 Owner 裁定终态为 **2 个技能**，且 `pd-pain-signal` 整份退场；分层方案、新宿主接入模板、契约测试与阶段计划见 plan 文档。此处不再重复。

## 9. 未验证项

| 项 | 状态 |
|---|---|
| Codex `tools/list` 实测 | BLOCKED — 缺 `mcp-binding.json`，需先跑 `$pd-control setup` |
| 开启态真实写入 / 回执语义 | NOT_RUN — 无受支持开启方式 |
| 无技能时智能体是否"乱试" | NOT_VERIFIED — 需宿主侧实测 |
| 删除技能后各宿主对新增/消失技能目录的反应 | NOT_VERIFIED |
