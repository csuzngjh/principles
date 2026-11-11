# PD 内置技能通用层：设计与规划

- 日期：2026-11-11
- 状态：设计稿（本轮不改代码、不改 skill 文件、不开实现 PR）
- 修订：2026-11-11 第五轮——纳入 Owner 硬约束 H1–H4 与验收判据 AC-1–AC-7（§0.1 / §0.2），补齐契约测试现状（§7.0）、退场原子性（§2.4 / §8）、能力缺失声明规则（§7.4）
- 基线：`origin/main`，工作区 `d:\Code\principles`
- 配套盘点结论：[2026-11-11-pd-builtin-skills-consolidation-review.md](./2026-11-11-pd-builtin-skills-consolidation-review.md)

---

## 0. 目标与判定口径

**目标**：让"接入一个新宿主"不再需要写一套技能。新宿主只声明差异，正文继承。

**判定口径（本轮采用）**：

1. 一个技能的去留，只看**去掉后能力有没有别的承载位置**；"精简"本身不是理由。
2. 承载位置必须是**已实测可用的**。未验证的承载位置不算承载位置。
3. 能由产品代码自描述的能力（CLI help、MCP tool description + schema、hook 回执与拒绝文案），不写进技能。
4. 分叉必须表达为**可声明的差异**（数据），不是每宿主一份独立正文。

### 0.1 硬约束（Owner 2026-11-11，优先级高于本文件任何设计取舍）

| # | 约束 | 含义 |
|---|---|---|
| H1 | **任何宿主都不许是别人的子集** | OpenClaw / Codex / WorkBuddy 必须各自安装**同一套**技能；不允许"A 宿主有一部分、B 宿主是另一部分" |
| H2 | **`pd-cli-operator` 三宿主必装** | 宿主本身不会去猜存在一个命令行工具。这份技能是"PD CLI 存在"的**唯一知情来源**；缺了它，宿主压根不知道有这套命令 |
| H3 | **移除必须三处同时发生** | `pd-pain-signal` / `pd-review` 的退场在**同一个 PR** 内完成全部 4 个交付目录（OpenClaw zh、OpenClaw en、Codex、WorkBuddy）。**OpenClaw 的 zh/en 两语种算两处**。不允许分批、不允许中间态 |
| H4 | **格式可适配，内容不分区** | 同一份正文按宿主渲染出不同的命令与入口；**不允许**"每个宿主只拿到自己那一节"的正文裁剪 |

H1–H4 对设计的直接约束：

1. 技能集合只能有**一个全局定义**。任何按宿主分别维护名单的常量（`WORKBUDDY_REQUIRED_SKILLS`、`EXPECTED_SKILLS` 等）都是 H1 的违规载体，必须收敛为"从单一清单读取"。
2. 语言轴不构成例外：zh/en 是**同一技能**的两个渲染目标，不是两套能力。
3. 退场必须是原子的，因此 §8 的阶段划分必须保证**每个可交付中间态**都满足 H1——不能出现"Codex 已删、WorkBuddy 还在"。
4. "某宿主不支持某动作"**不是**减少技能或删段落的理由（H4），只能表达为显式声明（§7.4）。

### 0.2 验收判据（AC）

| ID | 判据 | 验证方式 | 现状 |
|---|---|---|---|
| AC-1 | 全局清单中每个 `active` 技能在 4 个交付目录**都在**，每个 `retired` 技能**都不在** | 跨宿主平价契约测试（期望值全部来自 `skill-catalog.json`，测试体内无技能字面量） | **GREEN（已实测，见 §7.0 / §7.3）** |
| AC-2 | 清单中 `retirable:false` 的技能必须为 `active` 且四处实装（`pd-cli-operator` 即此类，H2 的机械表达，但不写进测试字面量） | 同一测试：`retirable:false ⇒ status==='active'` | **GREEN** |
| AC-3 | 退场技能的存废是**全局状态**：要么 4 处都在，要么 4 处都不在；3 处命中必须红 | 同一测试：`hits === (status==='active' ? HOSTS.length : 0)` | **GREEN（当前全在；负向已实测，见 §7.3）** |
| AC-4 | 同一技能在 4 处的差异**仅来自** `hosts/<id>.json`；正文段落集合一致 | 渲染 `--check` + 差异封闭断言（§7.1） | 待 P1 |
| AC-5 | 宿主能力缺失处必须输出**显式声明段**（不支持什么 + 该走哪条路），不得出现整段缺失 | 契约测试：`unsupported[]` 非空 ⇒ 产物必须含声明段；渲染器对未声明占位 fail-closed | 待 P2 |
| AC-6 | AC-1/AC-2/AC-3 在**不依赖渲染器**的情况下即可跑（P0 之前就能守） | 测试直接读 4 个目录 + 清单，不 import 生成代码 | **GREEN** |
| AC-7 | 契约测试失败时必须报出"哪个宿主 / 哪个技能 / 哪种偏差" | 断言消息携带三元组 | 待落地 |
| AC-8 | 这条测试**真的被 CI 执行到**：改动任一技能投递路径时 job `test-create-principles-disciple` 必须触发 | 修 `scripts/ci/impact.mjs` 分类 + `scripts/__tests__/impact.test.ts` 用例；见 §7.2.2 | **未实现（现状不会触发，属 P0 必做）** |

> AC-1/AC-2/AC-3/AC-6 是**今天就能绿**的判据，用于防止"下一次又少装一个"；AC-4/AC-5 需要渲染器，属于目标形态的守卫。AC-8 是前四条**真的会跑**的前提，当前未实现（见 §7.2.2）。

---

## 1. 现状（盘点摘要）

仓库内 PD 技能共 **4 套 16 个文件**，两两无字节相同，跨套可对上的整行仅 1–7 行。

| # | 宿主 / 变体 | 路径 | 技能数 | 总字节 |
|---|---|---|---|---|
| 1 | OpenClaw（zh） | `packages/openclaw-plugin/templates/langs/zh/skills/` | 4 | 12,349 |
| 2 | OpenClaw（en） | `packages/openclaw-plugin/templates/langs/en/skills/` | 4 | 13,757 |
| 3 | Codex | `plugins/principles-disciple/skills/` | 4 | 19,974 |
| 4 | WorkBuddy | `packages/workbuddy-adapter/plugin/skills/` | 4 | 15,113 |

没有第五处：`packages/principles-core`、`packages/pd-mcp-server`、`packages/host-runtime` 下均无 `SKILL.md`。

详细清单、哈希、逐条差异见配套 review 报告。

---

## 2. 技能去留判定（终态：2 个）

### 2.1 判定表

| 技能 | 承担任务 | 终态 | 依据 |
|---|---|---|---|
| `pd-cli-operator` | 判断"PD 哪一环坏了"：确定权威工作区、跑只读命令、分阶段报证据；并入 `pd console open` 与"不得代 Owner 审批" | **保留** | 工作区解析（`plugins/principles-disciple/skills/pd-cli-operator/SKILL.md:10`）、分阶段纪律（OpenClaw zh 版 `:51-54`）、`pd pain recall` 判读（OpenClaw zh 版 `:40-47`）。这三类语义全仓仅在技能内存在，产品代码无对应文案 |
| `pd-control` | Owner 明确要求安装 / 停用 / 重启用 / 修复宿主接入 | **保留（瘦身为宿主差异）** | 4 个动作、每宿主命令不同：Codex `pd-locate.cjs --exec scripts/pd-setup.cjs`（`:14-21`）、WorkBuddy 仅停用（`:16-24`）、OpenClaw `openclaw plugins disable\|enable`（`:27`、`:35`） |
| `pd-review` | 进 Console 做治理决定 | **退场**，能力并入 `pd-cli-operator` | 独有内容仅 `pd console open`（`:15`）与"不得代 Owner 审批"（`:30-32`）。前者由 help 可发现，后者是全局治理边界，应上提为通用层总则 |
| `pd-pain-signal` | 引导智能体创建痛苦信号 | **条件退场（暂不执行）** | 见 §2.5：v0.8 重写让它重新承担真实入口，而 MCP 侧存在绑定断裂，此时退场等于拿掉唯一可用入口。闸门未满足前保持 `active` 并继续装机 |

### 2.2 `pd-pain-signal` 退场的准确理由

> 2026-11-11 修订：本节是退场的**设计依据**，不是执行许可。是否允许退场由 §2.5 的闸门决定，闸门写在清单里。

不是"技能写得不好"，而是**它存在的理由随着能力收敛消失了**：

1. **默认关闭态**：`tools/list` 里没有 `pd_submit_pain`，正确行为就是"能力不可用"，不需要一份技能去提醒"别绕过"。护栏的前提（工具默认关闭）本身就否定了护栏的必要性。
2. **开启态**：锚点三型、六项 `reason`、`additionalProperties:false`、授权四步都在 `server.ts:88-140` 的工具描述与 schema 里，智能体调用时直接可见，技能里那份是副本。
3. **原生入口**：Owner 登记痛苦信号的入口是宿主原生命令/前缀，由代码实现（§5），与技能无关。

### 2.3 退场的硬前置（未完成不得删）

| 前置 | 状态 | 说明 |
|---|---|---|
| OpenClaw `tools/list` 实测 | **PASS** | `~/.openclaw/extensions/principles-disciple` → `["pd_recall_principle_pains"]` |
| WorkBuddy `tools/list` 实测 | **PASS** | `~/.workbuddy/plugins/cache/principles-disciple-market/principles-disciple/0.2.2` → 同上 |
| Codex `tools/list` 实测 | **BLOCKED（绑定缺失）** | 已安装启用 0.3.22，但无 `mcp-binding.json`；launcher 返回 `binding_missing` + `nextAction` |
| 开启态真实写入 → 读回 → 回执校验 | **NOT_RUN** | 见 §3：不存在受支持的开启方式 |
| "工具缺失时智能体会不会乱试" | **NOT_VERIFIED** | 宿主侧未知工具报错行为，无证据 |

因此：`pd-pain-signal` 的删除可以在"默认关闭态"下执行，但"开启态工具描述足以替代技能"必须作为 OG-4 放行前的验收项单列，**不得默认通过**。

### 2.4 退场的执行约束（原子性，来自 H3）

| 约束 | 具体做法 |
|---|---|
| 同一 PR | `pd-pain-signal` 与 `pd-review` 的删除、4 处目录清理、4 处集合常量/断言更新，全部在这个 PR 内完成 |
| 四目录同进同退 | OpenClaw zh、OpenClaw en、Codex、WorkBuddy 各算一处；**语言变体不是豁免** |
| 检查点 | PR 合入前跑一次"退场技能命中目录数"，结果必须是 `0`（不是 1/2/3）；任何残留即视为未完成 |
| 禁止 | ❌ 先删 Codex、下个 PR 删 WorkBuddy；❌ 保留一份 old 版"保证兼容"；❌ 只删 zh 或只删 en |
| 回滚 | 单 commit 反向恢复 4 处目录 + 4 处常量；因为原子，回滚也是原子的 |

### 2.5 条件退场闸门（Owner 2026-11-11 决定）

`pd-pain-signal` 的退场从"整份退场"改为**条件退场**，条件写死在清单里，不是口头约定。

**闸门条件**：OpenClaw、Codex、WorkBuddy 三个宿主各自在真实宿主里通过 MCP 完成一次痛苦入账，并能用 recall 读回同一条记录。**任一宿主未通过即不得退场。**

- 机器可读的位置：`packages/create-principles-disciple/skill-catalog.json` 中 `pd-pain-signal` 的 `retirementCondition` 字段（由 `src/skill-catalog.ts` 校验，`tests/skill-catalog.test.ts` 钉住）。
- 本文档解释**为什么**设这道闸门；清单字段是**是否允许退场**的唯一事实源。两者冲突时以清单为准。
- 闸门未满足前：`status` 保持 `active`，四个交付目录继续装机。
- 理由：v0.8 重写让该技能重新承担真实入口；同期 MCP 侧发现 Codex 绑定断裂导致 recall 不可用。在 MCP 真正接管前退场，等于把唯一可用的入口也拿掉。

---

## 3. 前置条件：提交工具的开启通道（设计，不实现）

### 3.1 事实

`enableSubmitTool` 只能是**代码参数**：

- `packages/pd-mcp-server/src/server.ts:197-200`：注释明确 "no env var or feature flag can change it"。
- `packages/pd-mcp-server/src/index.ts:29-32`：进程入口从不开启。
- `packages/pd-mcp-server/src/index.ts:227-231`：`main()` 只传 `workspaceDir / host / logSink`；全文件无 argv 解析。

这是**产品缺口**，不是本轮环境限制。任何宿主无论怎么配都开不了。

### 3.2 最小设计

| 维度 | 设计 |
|---|---|
| 形态 | 宿主清单 `hosts/<id>.json` 的 `mcp.submitTool.enabled` → 渲染为 `.mcp.json` 的启动参数 `--enable-submit-tool`；命令行参数是唯一支持的形态 |
| 环境变量 | 仅允许开发用 `PD_MCP_SUBMIT_DEV=1` **且**同时带参数才生效（双确认），生产不接受 env 单独开启 |
| 谁有权开 | 只有 Owner。开启必须经由一条显式命令写入 OG-4 治理记录（durable），不允许手改配置文件 |
| 与 OG-4 绑定 | launcher 启动时校验 OG-4 记录存在、未撤销、且宿主与清单一致；任一不满足 → fail-closed，返回 `status=failed, reason=<具体原因>, nextAction=<下一步>` |
| 防误开 | 默认 `false`；参数为真但无 OG-4 记录 → 启动失败并给出 nextAction；`enabled: true` 不允许出现在提交进仓库的默认清单里 |
| 验收 | 三宿主各一次 `tools/list` 抓取 + 一次写入读回 + 一次拒绝路径验证 |

> 这一节只定义形态与权限边界，不构成实现计划。

---

## 4. 分层设计

### 4.1 四层

| 层 | 承载物 | 归属 | 分叉 |
|---|---|---|---|
| L0 能力自描述 | CLI `--help`、MCP tool description + JSON Schema、hook 回执/拒绝文案 | 产品代码 | 否 |
| L1 PD 通用正文 | `pd-cli-operator`、`pd-control` 各 zh/en 一份 | 单一源 | 否 |
| L2 宿主差异 | `hosts/<id>.json` | 单一源 | 是（数据） |
| L3 渲染产物 | 各宿主技能目录 | 构建/安装产物 | 否（机器生成） |

**L1 只允许写四类内容**：命令语义与证据纪律；授权边界（谁批准、智能体不得代批）；失败处理与退出条件；什么时候不该用这些命令。
**L1 禁止写**：宿主命令原文、路径、工具名、前缀、语言切换逻辑。

### 4.2 L2 差异清单（逐条，附成因）

| 差异项 | 为什么必须分叉 | 证据 |
|---|---|---|
| 入口命令 | 每个宿主调用 PD 的方式不同：Codex 走插件脚本定位器，WorkBuddy 走 `.cjs`，OpenClaw 走 `openclaw plugins *` | Codex `pd-control:14-21`；WorkBuddy `:16-24`；OpenClaw `:27`,`:35` |
| 工作区解析 | Codex 的治理工作区与"当前项目目录"不是同一个；WorkBuddy 固定工作区 | Codex `pd-cli-operator:10`；WorkBuddy `pd-pain-signal:131` |
| MCP 工具名 / 传输 | 三宿主都用同一 launcher，但绑定文件与载荷路径不同 | `.mcp.json`（三处，args `./mcp/launcher.cjs`） |
| 原生入口 | `PD记录痛苦：`（Codex/WorkBuddy）、`/pd-pain`（OpenClaw） | §5 |
| hook 契约 | Codex/WorkBuddy 有 prompt hook，OpenClaw 走 `registerCommand` | §5 |
| frontmatter | OpenClaw 独有 `disable-model-invocation` 等字段 | `manifest-skills.test.ts` |
| 语言变体 | OpenClaw 跟随 agent 语言；Codex/WorkBuddy 当前只用中文 | `skill-language.ts` |
| 安装路径 | 插件目录 / 宿主技能目录 / marketplace stage 三种载体 | `workbuddy-host-installer.ts:75` 等 |
| **能力缺失** | 某动作在某宿主确实没有实现（WorkBuddy 只有停用、没有启用）；这不是删段落的理由，必须**显式声明** | WorkBuddy `pd-control/SKILL.md:24`（"只实现停用……明确报告不支持"）vs OpenClaw `pd-control/SKILL.md:31-39`（有 enable） |

### 4.3 目录与构建形态（目标形态）

```
packages/pd-skills/                     # 单一源（新增包）
  skills/
    pd-cli-operator/{zh.md,en.md}
    pd-control/{zh.md,en.md}
  hosts/
    openclaw.json
    codex.json
    workbuddy.json
  src/render.ts                         # 占位符 + 条件段渲染
  src/cli.ts                            # render / --check
```

渲染规则：

- 占位符：`{{host.cli.setup}}`、`{{host.workspace.rule}}`、`{{host.nativeEntry.prefix}}`
- 条件段：`{{#if host.nativeEntry}} … {{/if}}`
- 语言：按 `langs` 选择 L1 正文文件，正文内不出现语言判断
- 产物头：每个生成文件固定首行 `<!-- generated by @principles/pd-skills; edit packages/pd-skills/skills/** -->`，`--check` 模式据此与源比对
- **能力缺失声明（H4）**：清单用 `unsupported[]` 声明"本宿主没有这个能力"；渲染器据此渲染**声明段**（"本宿主不支持 X；应改走 Y"），**不得删除正文段落**。若正文引用了某个能力而该宿主既未提供实现、也未在 `unsupported[]` 声明 → 渲染失败（fail-closed），不允许静默留空
- **技能集合不可裁剪**：渲染器的输出技能集合对所有宿主完全相同（H1）；`hosts/<id>.json` 里不存在"跳过某技能"的字段，从结构上排除"某宿主少一个技能"

产物落点（4 处，保持不变以便兼容现有加载链）：

1. `packages/openclaw-plugin/templates/langs/{zh,en}/skills/`
2. `plugins/principles-disciple/skills/`（过渡期；目标形态改为安装期渲染，见 §6.2）
3. `packages/workbuddy-adapter/plugin/skills/`
4. 未来宿主：清单声明落点

### 4.4 新宿主接入模板

**需要提供**：

1. `hosts/<id>.json`，必填 9 字段：`id`、`displayName`、`skillDestination`、`languageModes`、`cli{setup,disable,enable,repair}`、`workspaceRule`、`nativeEntries[]`、`mcp{transport,bindingStyle}`、**`unsupported[]`**

   `unsupported[]` 每项形如 `{ "capability": "control.enable", "reason": "...", "alternative": "..." }`，回答两个问题：**本宿主不支持什么**、**该走哪条路**。空数组是合法值（表示该宿主能力齐全）；字段本身必填，避免"忘了声明"退化成静默缺段。

2. MCP 绑定文件生成方式（复用同一 launcher，不新写入口）
3. 若宿主有原生入口：一行 `nativeEntries` 声明 + 代码侧实现

**不需要提供**：

- 技能正文、frontmatter、命令表、授权边界、翻译
- 任何"本宿主版"的独立 SKILL.md
- 任何"本宿主少装某个技能"的能力（H1：结构上不存在这个开关）
- 新的 MCP 入口实现（launcher 字节级相同，由既有 G4-7 守卫）

验收一步：`pd-skills render --host <id> --check` 全绿，且跨宿主平价测试（§7.2）对全部 4 个交付目录同时为绿。

---

## 5. 三处原生入口的处置

| 宿主 | 入口 | 实现 | 删技能后可用性 | 对技能的依赖 |
|---|---|---|---|---|
| Codex | `PD记录痛苦：` | `packages/codex-adapter/src/ingestion/explicit-owner-statement.ts`（`parseOwnerStatementPrefix` / `recordExplicitOwnerStatement`），UserPromptSubmit hook 驱动 | **完整**：接受、幂等、拒绝均返回 `reason`+`nextAction` | 无。仅"Owner 知道有此前缀"依赖可发现性 |
| WorkBuddy | `PD记录痛苦：` | `packages/workbuddy-adapter/src/explicit-owner-statement.ts:9-52`，`pd-hook.ts:300` 预留前缀 | **完整**：含半角冒号等近似前缀的可执行提示 | 无。同上 |
| OpenClaw | `/pd-pain` | `packages/openclaw-plugin/src/index.ts:1067-1082`，`registerCommand` + `getCommandDescription` | **完整**：命令自带描述，出现在宿主命令列表 | 无 |

**分工**：代码持有实现，宿主清单持有事实（`nativeEntries: [{ kind: "prompt_prefix", value: "PD记录痛苦：" }]`）。技能不持有任何入口事实。

**可发现性替代位置**（删技能后 Owner 如何知道）：宿主命令补全的描述、hook 拒绝文案里的 `nextAction`、`pd --help` 与产品文档。三处都在代码/文档侧，不需要技能正文。

---

## 6. 收敛路径对比与推荐

### 6.1 三条路径

| 维度 | A. 单一源 + 构建期渲染 | B. 单一源 + 共享正文 + 宿主 overlay | C. 保持副本 + 加契约测试 |
|---|---|---|---|
| 新宿主接入成本 | **写 1 个 JSON（约 20 行）** | 写 overlay 文件；一旦需要改写共享段落就退化为副本 | 手写整套正文（当前成本） |
| 改动面 | 新增 1 包 + 3 处构建接入 | 新增 1 包 + 渲染拼接逻辑 + N 个 overlay | 仅测试 |
| 构建链改动 | 3 处（openclaw 构建、安装器、codex 载荷） | 同 A，且更复杂 | 无 |
| Codex 载荷 / 版本递增 | 过渡期仍会触发；目标形态可彻底规避（§6.2） | 同 A | **无法规避**，每次改文案都要 bump |
| 回滚难度 | 中：产物可逐宿主回退到提交态 | 中偏高：overlay 与正文耦合 | 低 |
| 对现有测试影响 | 需改 4 处技能集合断言 | 同 A | 无 |
| 能否达成"新宿主免写技能" | **能** | 部分能（overlay 易膨胀） | **不能** |

### 6.2 Codex 链路的影响与规避

现状：技能文本属于 Codex 插件载荷，`plugin.json` 版本是 Codex 缓存键（`RELEASE_PROCESS.md:209-218`）；而 `scripts/release/sync-codex-runtime-pins.mjs` 只在四个 pin 变化时 bump。结果是：仅改技能文本时，既不会自动 bump，也到不了已安装用户。

规避（目标形态）：**技能不再作为版本化载荷提交**，改为安装期由单一源渲染到宿主技能目录（插件缓存之外），由 `$pd-control setup` / 安装器负责。

- 技能文本变化 → 只走运行时包的常规版本线，**不触发** `plugin.json` 版本递增与 pin 同步。
- 前置验证（实施前必须实跑）：Codex 是否从 `~/.codex/skills/` 发现插件技能 —— **NOT_VERIFIED**。
- 回退：若 Codex 只认插件根目录技能，则保留"构建期写入插件根"，并接受版本递增（回到 A 的过渡形态）。

### 6.3 推荐

**推荐 A（单一源 + 构建期渲染），并把 Codex 侧演进到安装期渲染。**

理由（按目标而非当下改动量）：

1. 只有 A 能让新宿主成本降到"一个声明文件"。
2. B 的 overlay 在有实质差异时必然复制正文，长期会重新长出四份。
3. C 无法改变接入成本，且已被现实证伪：OpenClaw 两份 `pd-pain-signal` 仍是旧口径（`/pd-pain` + `pd pain record --session`），而 Codex/WorkBuddy 已是锚点口径 —— 没有生成器，仅靠测试挡不住语义漂移。
4. 仓库已有同类先例：`mcp/launcher.cjs` 三份字节级相同，由 G4-7 架构守卫强制。技能层可以直接沿用这个已验证的模式。

### 6.4 落地改动清单（文件级）

| 阶段 | 文件 | 动作 |
|---|---|---|
| 源 | `packages/pd-skills/**` | 新增：`skills/pd-cli-operator/{zh,en}.md`、`skills/pd-control/{zh,en}.md`、`hosts/*.json`、`src/render.ts`、`src/cli.ts` |
| 源 | `docs/adr/`（新增一条） | 记录"技能为产物"的架构决定 |
| 清单 | `packages/create-principles-disciple/skill-catalog.json` | **新增**：全局技能清单（`name/status/retirable`），P0 的事实源，P1 迁入 `pd-skills` |
| 测试 | `packages/create-principles-disciple/tests/cross-host-skill-parity.test.ts` | **新增**：AC-1/AC-2/AC-3/AC-6/AC-7 跨宿主平价，期望值全部读清单，测试体内无技能字面量 |
| CI 影响面 | `scripts/ci/impact.mjs` | 新增 `SKILL_DELIVERY_PATHS`：技能投递路径 → `scopes.installer = true` 且不计入 docs（AC-8） |
| CI 测试 | `scripts/__tests__/impact.test.ts` | 新增三个路径族用例，钉住"A 改技能就触发 installer job" |
| 构建 | `packages/openclaw-plugin/scripts/verify-build.mjs` | 技能集合断言改为"渲染结果集合" |
| 构建 | `packages/create-principles-disciple/scripts/bundle-plugin.mjs` | 打包前调用渲染 |
| 构建 | `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts` | `WORKBUDDY_REQUIRED_SKILLS` 改为从清单读取 |
| 构建 | `plugins/principles-disciple/scripts/pd-setup.cjs` | 目标形态：渲染技能到宿主技能目录 |
| 测试 | `packages/openclaw-plugin/tests/manifest-skills.test.ts` | 四技能断言改为两技能 |
| 测试 | `packages/workbuddy-adapter/tests/plugin-skeleton.test.ts` | 同上 |
| 测试 | `packages/pd-cli/tests/commands/cli-skill-contract.test.ts` | 保留命令可解析断言，扩展到渲染产物 |
| 测试 | `packages/codex-adapter/tests/codex-plugin-bundle.test.ts` | 去掉 `pd-pain-signal` 相关断言 |
| 测试 | `packages/pd-skills/tests/render-contract.test.ts` | 新增：同源 `--check` + 差异封闭 + 能力缺失声明（AC-4/AC-5） |
| 删除 | 4 套 `pd-pain-signal`、4 套 `pd-review` | **单 PR 原子删除**（H3）：OpenClaw zh/en、Codex、WorkBuddy 同进同退 |

---

## 7. 防漂移机制

### 7.0 契约测试现状（本轮实测，先于设计）

现有 6 处技能相关断言全部是**单宿主 + 硬编码名单**，没有任何跨宿主比对——这就是漂移的根因。

| 位置 | 守什么 | 覆盖范围 |
|---|---|---|
| `packages/openclaw-plugin/tests/manifest-skills.test.ts:45,134-172` | OpenClaw zh/en 技能集合 = `EXPECTED_SKILLS` | 单宿主（zh+en 两个目录，但仍是同一宿主） |
| `packages/openclaw-plugin/scripts/verify-build.mjs:111-138` | 构建产物技能集合"不多不少" | 单宿主 |
| `packages/create-principles-disciple/src/installers/workbuddy-host-installer.ts:75,105,1205` | WorkBuddy 四技能必须存在 | 单宿主 |
| `packages/codex-adapter/tests/codex-plugin-bundle.test.ts` | Codex 载荷含技能 | 单宿主 |
| `packages/pd-cli/tests/commands/cli-skill-contract.test.ts` | 技能里的 `pd <cmd>` 能解析 | 跨技能，但**不比集合** |
| `packages/create-principles-disciple/tests/delivery-surface-parity.test.ts` | `@principles/*` 包依赖的交付面 | 与技能集无关 |

**等价断言实测（只读脚本，未新建测试文件）**：

```
openclaw-zh  count=4 [pd-cli-operator, pd-control, pd-pain-signal, pd-review] problems=none
openclaw-en  count=4 [同上] problems=none
codex        count=4 [同上] problems=none
workbuddy    count=4 [同上] problems=none
两两 missing=[] extra=[]
```

结论：**GREEN**。AC-1 / AC-2 / AC-3 / AC-6 今天即可落地为守卫，不需要等渲染器。

**必须写进测试注释的局限**：这是**集合平价**（只比名称与数量），抓不住内容漂移。实证：OpenClaw zh/en 的 `pd-pain-signal` 仍是旧 CLI 口径（`/pd-pain` + `pd pain record --session`），Codex/WorkBuddy 已是锚点口径，而名称与数量完全一致。同源替换必须靠 AC-4（渲染 `--check`），不能指望集合断言。

**并且它今天还没被 CI 触发**：技能投递路径在 `scripts/ci/impact.mjs` 里被分到 `plugin` / `workbuddyAdapter` / `docs`，都不激活 installer job。详见 §7.2.2。

### 7.1 断言什么

1. **同源**：对每个宿主重新渲染一次，与落盘产物逐字节比对（`--check` 模式）。
2. **差异封闭**：产物中出现的宿主专有字符串，必须能在该宿主 `hosts/<id>.json` 找到来源；反向断言每个被使用的占位符都在清单里有值。
3. **退场不复活**：产物目录不得出现 `pd-pain-signal` / `pd-review`。
4. **语言完整**：zh/en 的占位符集合一致，不允许单侧漏翻。
5. **命令可解析**：沿用 `cli-skill-contract.test.ts` 的做法，技能里出现的 `pd <cmd>` 必须在 CLI 注册表存在。
6. **跨宿主平价（AC-1/AC-2/AC-3）**：期望值全部来自全局清单——`active` 技能四处都在、`retired` 技能四处都不在、`retirable:false` 必须 `active`；测试体内不出现技能名与"4"。
7. **能力缺失声明（AC-5）**：`unsupported[]` 非空 ⇒ 对应产物必须出现声明段；为空 ⇒ 正文引用的每个 capability 在清单里有可执行值。

### 7.2 放在哪、谁守（分层判断）

判断依据：守卫必须放在**唯一能同时看到 4 个交付目录、且在渲染器存在之前就能成立**的位置。

| 阶段 | 位置 | 谁守 | 理由 |
|---|---|---|---|
| 现在（P0） | `packages/create-principles-disciple/tests/cross-host-skill-parity.test.ts` | `create-principles-disciple` 包测试套件，由 CI job `test-create-principles-disciple` 执行 | 该包是**唯一同时持有三个宿主投递知识**的包（`WORKBUDDY_REQUIRED_SKILLS`、openclaw 打包、codex pin 同步）。测试只读 4 个目录、不 import 渲染器，所以今天即可绿 |
| P1 之后（有条件的 follow-up） | `packages/pd-skills/tests/cross-host-skill-parity.test.ts` | `pd-skills` 源包套件 + CI required check `skill-render-contract` | 源与产物同包后，"集合平价"与"同源 `--check`"放在一起 |

**不要**把这条测试放进任一宿主包（`openclaw-plugin` / `codex-adapter` / `workbuddy-adapter`）：放进哪个宿主包，就等于让那个宿主"看守"其余宿主，与 H1 的心智模型相反，也会让该宿主的 CI 变成全仓阻塞点。

#### 7.2.1 条件一：断言必须由全局技能清单推导

测试里**不得**出现技能名字面量，也不得出现 `4`。期望值只能来自一份全局技能清单：

`packages/create-principles-disciple/skill-catalog.json`（P0 落点；P1 原样迁入 `packages/pd-skills/skills.catalog.json`——**迁移是 move，不是 copy**，不允许两份清单并存）：

```json
{
  "skills": [
    { "name": "pd-cli-operator", "status": "active", "retirable": false },
    { "name": "pd-control",      "status": "active", "retirable": true  },
    { "name": "pd-pain-signal",  "status": "active", "retirable": true  },
    { "name": "pd-review",       "status": "active", "retirable": true  }
  ]
}
```

语义：

- `status: "active"` → 每个宿主都必须有（`hits === HOSTS.length`）；
- `status: "retired"` → 任何宿主都不许有（`hits === 0`）；
- `retirable: false` → 该技能**不允许**被标为 `retired`；这是 H2 的机械保护（`pd-cli-operator` 是"PD CLI 存在"的唯一知情来源，谁把它改退就是产品事故）。测试只断言"`retirable:false ⇒ status==='active'`"，不写具体技能名，因此不违反条件一；
- 磁盘上存在但清单未声明的技能目录 → 失败（防止"只在某个宿主新增"逃过比对）。

P3 只改两条 `status`，**不改测试**；同一条断言自动从"必须 4 处都在"收紧为"必须 0 处"。

清单是唯一事实源，不是第二套约定：它就是 §4 的 L1/L2 定义的雏形，P1 迁入后由渲染器直接消费。

#### 7.2.2 条件二：必须真的被流水线执行到（现状：不会）

**写了不等于会跑。** 放在 `create-principles-disciple/tests/` 下能跑，但今天的 CI **触发不到**它：

| 改动路径 | `scripts/ci/impact.mjs` 分类 | 后果 |
|---|---|---|
| `packages/openclaw-plugin/templates/langs/*/skills/**` | `plugin`（`:39` `SCOPE_BY_DIR`） | installer 不在该包消费闭包内 → `test-create-principles-disciple` **skip** |
| `packages/workbuddy-adapter/plugin/skills/**` | `workbuddyAdapter` | `impact.test.ts:203-209` 已证明 `affectedPackages` 只有 `@principles/workbuddy-adapter` → installer **skip** |
| `plugins/principles-disciple/skills/**` | 不在 `packages/` 下，`.md` 命中 `DOCS_SUFFIX`（`:71`）→ `docs`（`:201`） | 技能-only PR 判为 `docsOnly`（`:222`）→ **零 job** |

因此 P0 必须同时改**影响面分类**（不是改 workflow）：

1. `scripts/ci/impact.mjs` 增加技能投递路径规则，位置在 docs 兜底之前：

```js
const SKILL_DELIVERY_PATHS = [
  /^packages\/openclaw-plugin\/templates\/langs\/[^/]+\/skills\//,
  /^packages\/workbuddy-adapter\/plugin\/skills\//,
  /^plugins\/principles-disciple\/skills\//,
];
```

命中即 `scopes.installer = true`，且**不计入** `docsFiles`（否则 `docsOnly` 会把整个 PR 判成文档变更）。

2. `scripts/__tests__/impact.test.ts` 用已有的临时仓库 fixture 写法（`:79` `commit()`）加三个用例，每个路径族一条，断言 `scopes.installer === true` 且 `docsOnly === false`。

3. 执行入口不变：`.github/workflows/ci.yml` 的 job `test-create-principles-disciple`（`:435`，条件在 `:438`）跑 `npm run build && npm run test:fast`（`:477`）；`test:fast` = `vitest run` 且只排除 4 个 smoke 文件（`packages/create-principles-disciple/package.json:49`），落在 `tests/**/*.test.ts` 的新测试会被自动收集。**不需要新增 workflow 或 job**。

#### 7.2.3 迁移条件（不允许两套守卫并存）

P1 渲染器落地后，在同一次迁移中完成：

1. `git mv` 测试文件到 `packages/pd-skills/tests/`（移动，不是复制）；
2. `git mv` 清单到 `packages/pd-skills/skills.catalog.json`，渲染器改为消费它；
3. `SKILL_DELIVERY_PATHS` 的目标从 `scopes.installer` 改为 `scopes.pdSkills`，installer 侧只保留"投递后实装校验"；
4. 删除旧 job 触发条件与旧文件——两个 job 同时跑同一断言视为迁移未完成。

### 7.3 AC-3 的机械表达：清单驱动

期望集合来自 §7.2.1 的清单，测试体内没有技能字面量与"4"：

```ts
const HOSTS = [/* 交付面：host id -> 根目录，属于基础设施，不是技能清单 */];
const catalog = readJson('skill-catalog.json');

for (const { name, status, retirable } of catalog.skills) {
  const hits = HOSTS.filter((h) => exists(join(h.root, name, 'SKILL.md')));
  const expected = status === 'active' ? HOSTS.length : 0;
  expect(`${name}(${status}): ${hits.length}`).toBe(`${name}(${status}): ${expected}`);
  if (!retirable) expect(status, `${name} is not retirable`).toBe('active');
}
// 反向：磁盘上有、清单里没有 -> 失败
```

**负向实测（2026-11-11，只读脚本，跑完即删）**

| 场景 | 预期 | 实测 |
|---|---|---|
| A 真实仓库 + 当前清单 | 绿 | 4/4 ×4 → PASS |
| B 沙箱内移除 `workbuddy/pd-review`（3 处命中） | 红 | `pd-review 3/4` → FAIL，消息含缺失宿主 |
| C 清单改 `retired` 但 4 处副本仍在 | 红 | `4/0` → FAIL |
| D 清单 `retired` 且 4 处副本已删（P3 终态） | 绿 | 0/0 → PASS |

B 的失败消息：`pd-review (active): expected 4 host(s), found 3 [openclaw-zh, openclaw-en, codex]`。C/D 证明"退场后无需改测试"，只改清单。

**这条断言的局限（必须写进测试注释）**

1. 它只校验**数量与声明**，抓不住"数量对但内容漂了"。真实反例就在仓库里：OpenClaw zh/en 的 `pd-pain-signal` 用旧 CLI 口径（`/pd-pain` + `pd pain record --session`），Codex/WorkBuddy 用锚点口径，四处名称与数量完全一致，本断言照样绿。内容同源只能靠 AC-4（渲染 `--check`）。
2. 它守不住"清单本身被误改"：把 `pd-cli-operator` 整条从清单删掉、同时删掉 4 处目录，本断言不会红。`retirable:false` 只能拦住"标成 retired"，拦不住"删条目"。这一条属于 H2 产品约束，只能靠清单改动走 Owner review；不要声称测试覆盖了它。

两者不得互相冒充：集合平价回答"发了几份"，同源校验回答"几份是否来自同一源"。

### 7.4 能力缺失的渲染规则（H4 / AC-5）

三层分工：

| 层 | 责任 | 失败行为 |
|---|---|---|
| 正文（L1） | 只写"要做什么、证据纪律、授权边界"，写到**动作语义**为止，不写"本宿主有无" | — |
| 清单（L2 `unsupported[]`） | 声明该宿主缺哪个 capability、为什么、该走哪条路 | 字段必填；缺失即渲染失败 |
| 渲染器（L3） | 正文引用的 capability 若在某宿主既未实现也未声明 → fail-closed；声明了就渲染成**显式段落** | 不允许静默删段 |

**具体例子：WorkBuddy 的停用（唯一实现，无启用）**

仓库里已经有一份可直接作为渲染目标范式的写法：

- `packages/workbuddy-adapter/plugin/skills/pd-control/SKILL.md:12-20`：`## 停用` 给出可执行命令 `node "<plugin-root>/scripts/pd-control.cjs" disable`，并规定只有 `ok=true` 且 `enabled=false` 才算成功。
- 同文件 `:24`：`## 安装、启用与修复` 明确写"当前插件内的 `pd-control.cjs` 只实现停用……若该流程没有提供可验证的启用操作，**明确报告不支持**；不得猜测命令、手工修改配置或调用私有安装器函数。"

对照 OpenClaw 版（`packages/openclaw-plugin/templates/langs/zh/skills/pd-control/SKILL.md:31-39`）有真正的 `openclaw plugins enable principles-disciple` 一节。

目标形态下的清单声明：

```json
{
  "id": "workbuddy",
  "unsupported": [
    {
      "capability": "control.enable",
      "reason": "随插件交付的 pd-control.cjs 只实现 disable，没有可验证的启用入口",
      "alternative": "使用正式 WorkBuddy 插件安装器/宿主管理流程；若该流程未提供可验证的启用操作，明确报告不支持"
    }
  ]
}
```

`hosts/openclaw.json` 的对应值应为 `"unsupported": []`（它有 enable）。

渲染产物（WorkBuddy）必须是**完整保留该节**，只是把可执行命令换成声明：

```markdown
## 启用或恢复

本宿主不支持：随插件交付的控制脚本只实现停用，没有可验证的启用入口。
应改走：正式 WorkBuddy 插件安装器/宿主管理流程。若该流程未提供可验证的启用操作，
明确报告不支持；不得猜测命令、手工修改配置或调用私有安装器函数。
```

**反面写法（禁止）**：把 `## 启用或恢复` 整节删掉。后果是智能体会自行编造 `pd-control.cjs enable` 这类不存在的命令——这比"知道不支持"更糟。

契约测试对应断言：

1. `unsupported[]` 非空 ⇒ 该宿主产物必须包含"本宿主不支持"，且覆盖清单里列出的每个 `capability`；
2. `unsupported[]` 为空 ⇒ 正文引用的每个 capability 必须在清单里有可执行值；
3. 两个方向都不允许"段落消失但清单未声明"。

> 注意：这条规则**不减少技能数量**（H1），只影响单技能内部的段落渲染。`unsupported` 不是"跳过技能"的开关。

---

## 8. 实施顺序与回滚点

| 阶段 | 内容 | 回滚点 |
|---|---|---|
| P0 | ①落 `skill-catalog.json`；②落跨宿主平价测试（AC-1/AC-2/AC-3/AC-6，今天即可绿）；③改 `scripts/ci/impact.mjs` + `impact.test.ts` 让技能改动真正触发 `test-create-principles-disciple`（AC-8）；④建 `packages/pd-skills` 源包 + 渲染器 + `--check`。不改任何宿主产物与技能内容 | 删测试/删清单/回退 impact 规则即可，产物未动 |
| P1 | 用渲染器生成现有 4 套产物，**与现有手写内容并存**，跑 `--check` 验证等价 | 产物未替换，纯新增 |
| P2 | 逐宿主切换为渲染产物（OpenClaw zh/en → WorkBuddy → Codex），每宿主一个 PR | 单宿主回退到上一提交的产物目录 |
| P3 | **单 PR 原子退场** `pd-pain-signal` / `pd-review`：删 4 处目录 + 清单两条 `status` 改 `retired` + 更新 4 处既有集合断言（平价测试本身不改） | 单 commit 反向恢复 4 处目录、清单与断言 |
| P4 | Codex 侧改为安装期渲染（需先验证技能发现路径） | 回退到 P2 形态 |

**三条硬约束**：

1. P2 与 P3 不得同 PR。
2. P4 未完成 `~/.codex/skills` 发现验证前不得启动。
3. **任何阶段的"可交付中间态"都必须满足 H1**：P2 逐宿主切换时，每个 PR 合入后 4 个交付目录的技能集仍完全相同；P3 必须是单个 PR 内的原子删除，禁止拆成"先删 OpenClaw、再删 Codex"。这条由 §7.3 的不变量机械保证。

---

## 9. 风险清单

| 风险 | 性质 | 处置 |
|---|---|---|
| 入口命令、原生前缀、启停命令、工作区解析、frontmatter、语言模式 | **故意差异，不能合并** | 全部下沉到 L2 清单，不作为"重复"处理 |
| 删 `pd-pain-signal` 后开启态无人知道锚点契约 | **可能回退** | 前置：OG-4 放行前必须完成"开启态工具描述足够"验收；未完成不得开启 |
| 删 `pd-review` 后 Owner 找不到 Console | 轻微回退 | `pd-cli-operator` 内保留 `pd console open` 段 + 治理边界总则 |
| 迁移期两套并存导致再次漂移 | 高 | 产物首行 `generated` 标记 + `--check` 契约 + 禁止手改生成文件；切换以宿主为单位，一次一个 |
| Codex 技能发现路径未验证 | 阻塞 P4 | 标 NOT_VERIFIED，先实测再动 |
| 渲染器把 `--help` 内容抄进正文 | 反向退化 | L1 评审门槛：只收"产品代码没有的语义"，可抄项一律拒绝 |
| **分批删除导致中间态**（H3 违反） | 高：某宿主少了技能、另一宿主还有，用户看到的能力随宿主不同 | 由 §7.3 清单驱动的 `hits === expected` 断言机械阻断；P3 强制单 PR |
| **某宿主是别人的子集**（H1 违反） | 高：缺 `pd-cli-operator` 的宿主根本不知道 PD CLI 存在，会表现为"PD 功能消失"而非报错 | AC-1/AC-2 断言 + 单一全局技能清单；禁止按宿主维护名单常量 |
| **能力缺失被写成"删段落"**（H4 违反） | 中高：智能体会自行编造不存在的命令（如 `pd-control.cjs enable`） | `unsupported[]` 必填 + AC-5 断言；WorkBuddy 现有写法作为范式（§7.4） |
| 集合平价测试给人"已经同源"的错觉 | 中：只比名称，挡不住内容漂移（OpenClaw 旧口径即实例） | 测试注释写明局限；同源仍必须由 AC-4 `--check` 承担 |
| **测试写了但 CI 不跑** | 高：这正是漂移能长期存在的原因；技能-only PR 今天判 `docsOnly` → 零 job | AC-8：`SKILL_DELIVERY_PATHS` → `scopes.installer`，并在 `impact.test.ts` 钉住三个路径族 |
| 清单成为第二套事实源，与渲染器各存一份 | 高：两个"技能列表"必然再次漂移 | P1 迁移用 `git mv`；迁移 PR 内删除旧路径；评审时"存在两份技能清单"即视为阻塞 |
| 迁到 `pd-skills` 后旧守卫残留并行 | 中：两套断言都绿时无人发现重复维护 | §7.2.3 明确迁移即删旧；两个 job 跑同一断言视为迁移未完成 |

---

## 10. 未决与 NOT_VERIFIED

| 项 | 状态 |
|---|---|
| Codex `tools/list` 实测 | BLOCKED（`binding_missing`，需 `$pd-control setup`） |
| 开启态真实写入 / 读回 / 回执 | NOT_RUN（无受支持开启方式，属产品缺口） |
| 工具缺失时智能体是否"乱试" | NOT_VERIFIED |
| Codex 是否从 `~/.codex/skills/` 发现插件技能 | NOT_VERIFIED（P4 前置） |
| 渲染后 Codex 载荷是否仍触发版本递增 | 取决于 P4 形态；过渡期仍会触发 |
| 跨宿主平价断言尚未落成测试文件 | 语义已实测 GREEN（§7.0），但仓库内仍无该测试；属 P0 首项待办 |
| 技能投递路径的 CI 触发规则（AC-8） | 未实现；现状三个路径族都不激活 `test-create-principles-disciple`，属 P0 必做 |
| `skill-catalog.json` | 尚不存在；§7.2.1 的形态是设计，落地前无人消费 |
| AC-4 / AC-5（同源与能力缺失声明） | 未实现，依赖 §7.1 的渲染器；当前无守门 |
