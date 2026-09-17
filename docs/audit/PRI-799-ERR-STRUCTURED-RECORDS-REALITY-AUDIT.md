# PRI-799 Phase 0 Reality Audit — ERR Structured Records 重构

**状态**: Complete（只读调查，未改任何生产代码）
**日期**: 2026-09-16
**工单**: [PRI-799](https://linear.app/principlesdisciple/issue/PRI-799)（已置 In Progress）
**SPEC**: Owner 提供的《PD ERR Structured Records 重构 SPEC + 执行指令》（2026-09-16）
**调查范围**: 主 checkout 只读调查（git-3 合规），基线 `ef6e7ed5`（main）

---

## 0. 核心结论（TL;DR）

1. **SPEC 的问题定义全部被仓库证据证实**：300KB 零和门在 checker 里真实存在（>300KB 报错、>250KB 警告）；手册当前 293.4KB（300,437 字节），余量约 6.5KB；登记流程是 8 步手工编辑共享大文件。
2. **ERR 编号分配比 SPEC 预担的更糟（P0 证实）**：不是"扫描最大值+1"，而是**读一个手工维护的 Statistics 计数器 total+1**（record-error 技能 Step 3）。历史撞号至少两次（git 两次 renumber 提交为证）。
3. **v2 结构化层已存在但被锁死在共享散文文件里**：`recurrence-meta` JSON 块（17 个）+ `error-pattern-routing` EP 卡（13 张）+ 双实现 parser + 奇偶校验测试——**结构化模式的正确形态仓库里已经有了，缺的正是 SPEC 说的"独立可合并存储单元"**（Connection Before Creation 成立）。
4. **三个审计新发现**（SPEC 未预见，不推翻假设但细化方案）：
   - **F1 双命名空间**：EP-NN（index pattern 卡）与 ERR-NNN（手册条目）已经并存，且 `recurrence-meta.pattern` 已用 EP-NN 聚合热点——目标模型的 "Pattern" 应映射到 EP 卡，不应发明第三套概念；
   - **F2 写入指令漂移**：用户级 `~/.agents/skills/record-error/SKILL.md`（zcode 会话实际加载的版本）指向旧路径 `docs/ERROR_EXPERIENCE_HANDBOOK.md` 且工作流是旧版——多 Agent 写入行为受一份**过时指令**支配；
   - **F3 归档是 checker 盲区且有活体缺陷**：checker 从不读 `ERROR_ARCHIVE.md`；**ERR-083 同时存在于手册和归档**（双栖，归档时复制未删/复活时未清）。
5. **格式建议**：Markdown 记录文件 + 文首 `<!-- pd-error-record {...} -->` JSON 元数据块——直接复用现有双 parser 的 HTML-comment JSON 提取与标记协议，零新依赖（js-yaml 5 是纯 ESM，CJS checker 无法 require，YAML 方案反而制造新问题）。

---

## 1. 文件清单与体量（2026-09-16 主 checkout 实测）

| 文件 | 字节 | 角色 | 受门限制 |
|---|---|---|---|
| `docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md` | 300,437 (293.4KB) | 活跃条目权威（当前 canonical） | 是：>300KB error，>250KB warn |
| `docs/process/error-management/ERROR_ARCHIVE.md` | 125,944 (123KB) | 归档（**checker 不读它**） | 否 |
| `docs/process/error-management/ERROR_PATTERN_INDEX.md` | 54,774 (53.5KB) | 检索入口 + EP 卡路由元数据 | 无容量门（仅结构性校验） |

条目计数：手册 91 条活跃详细条目；归档 41 条；EP 卡 13 张；`recurrence-meta` 块 17 个；最大编号 ERR-131。手工统计区自称 "Total lessons 123 / Recurring 65"——**123 无法从任何机器可数集合复算**（91+41−1=132），手工聚合已漂移（见 F4）。

---

## 2. Writer Matrix（谁写 ERR 数据）

| Producer | Path | 写什么 | 写到哪 | Authority |
|---|---|---|---|---|
| record-error 技能（仓库版） | `.claude/skills/record-error/SKILL.md` | 新 ERR 条目 / 复发 / recurrence-meta | 手册类别表 + 详细条目 + 统计区 + INDEX | 当前 canonical 写入流程（8 步） |
| record-error 技能（用户级） | `~/.agents/skills/record-error/SKILL.md` | 同上但**旧版**：旧路径 `docs/ERROR_EXPERIENCE_HANDBOOK.md`、无 recurrence-meta 强制、无 similarity gate | 同上（按旧指令） | **F2：zcode 会话实际加载的是这份** |
| AGENTS.md §14 | `AGENTS.md` | 登记义务、两遍路由、hotspot 升级裁决流程 | 指向上述文件与命令 | 政策层 |
| Agent（人肉执行技能） | 各 AI 会话 | 条目正文、 recurrence-meta、统计数字 | 手册 + INDEX | 实际写入执行者 |
| PR #1700 类压缩/归档操作 | 手工 | 搬正文进归档、压 recurrence 字段 | 手册 + 归档 | 手工手术（G3 要消灭的对象） |

**没有脚本化 writer**：不存在任何创建/追加 ERR 记录的 CLI——所有写入都是 Agent 徒手编辑 Markdown。

## 3. Reader Matrix（谁读 ERR 数据）

| Consumer | Path | 读什么 | 依赖数据 | 依赖 Markdown 排版 |
|---|---|---|---|---|
| check-error-handbook.cjs | `scripts/check-error-handbook.cjs`（247 行） | 手册 + INDEX（**不读归档**） | ID、recurrence-meta、routing 元数据 | **重度**：`^\*\*\[ERR-\d{3}\]\*\*`、类别表行 `\| ERR-NNN \|`、Recurrence 字段边界、`### EP-NN` 标题、300KB 全文体量 |
| error-handbook-meta.cjs | `scripts/error-handbook-meta.cjs`（241 行） | 手册 + INDEX 文本 | HTML-comment JSON（routing/recurrence-meta） | 轻：只依赖注释块协议 |
| error-context.mjs | `scripts/error-context.mjs`（699 行） | **只读 INDEX** | EP 卡 routing 元数据 | 轻：`### EP-NN ` 标题前缀 |
| quality-report.mjs | `scripts/quality-report.mjs` | 手册 | 条目计数 | **是**：`/\*\*\[ERR-\d+\]\*\*/g` 与 `\*\*Recurrence\*\*: Yes` 正则直排 |
| check-docs-structure.cjs | `scripts/check-docs-structure.cjs` | 文件存在性 | 路径 | 仅路径（INDEX+手册为关键文件，**归档不在名单**） |
| error-context.test.ts | `scripts/__tests__/error-context.test.ts` | 上述双 parser | 奇偶校验（CJS vs ESM 对照 fixture） | 测试夹具 |
| Agent 检索行为 | AGENTS.md §14、PR 模板 | INDEX → 手册详情 | 语义 | 阅读入口约定 |
| docs/README.md | 导航 | 链接三件套 | 路径 | 仅路径 |

## 4. Link / Anchor 拓扑

- `docs/README.md`：`error-management/` 三件套导航（路径级依赖）。
- PR 模板（`.github/PULL_REQUEST_TEMPLATE.md`）：Error Experience 两遍路由段落，要求填 "EP-XX 或 ERR-XXX"（**ID 词汇依赖**，非链接）。
- 手册内部自引用锚点：`[ERR-066]: docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md#ERR-066`、ERR-067 两处 markdown link-reference 定义（遗留物，仅内部）。
- INDEX 的 Representative ERRs：纯文本 ID（`ERR-001, archived-054, ...`）——**非链接**，13 张卡引用活跃 ERR + `archived-NNN`（7 处 archived 标记、12+ 个 archived-NNN 引用）。
- `.github/workflows` 与 `lefthook.yml`：**均不直接调用** `check:error-handbook`；它经 `verify:merge`（ci.yml 引用）成为合并门。
- 外部（私有 docs/Linear 评论）按既有约定引用文件路径——路径稳定性要求：三件套路径不可消失。

## 5. 当前 Schema 提取（从真实文件，非 SPEC 示例）

### 5.1 ERR 详细条目（手册权威格式）

```text
**[ERR-NNN]** | <一行摘要>                    ← detailPattern 锚点（checker 正则 \d{3}）
- **What happened**: ...
- **Why it's wrong**: ...
- **Correct approach**: / **Generalized failure mode**: ...
- **How to prevent**: ...
- **Regression guard**: / **Related ERRs**: （可选）
- **Source**: <Linear ID / PR #>
- **Date**: YYYY-MM-DD
- **Recurrence**: None | Yes | First occurrence
  - <日期 PR #>: 叙事
  <!-- recurrence-meta {...} -->            ← v2 起新复发强制
```

### 5.2 `recurrence-meta`（已验证的 v2 结构化层）

```json
{ "date": "YYYY-MM-DD（严格日历校验）", "pattern": "EP-NN", "invariant": "kebab-case",
  "severity": "P0..P3", "escaped": "非空（gate 名或 none）",
  "caughtBy": "self-review|pr-review|ci|runtime|owner", "guard": "非空（none 或 guard id）" }
```

### 5.3 `error-pattern-routing`（INDEX EP 卡）

```json
{ "id": "EP-NN", "risk": "high|medium|low", "pathSignals": [...], "diffSignals": [...],
  "requiredEvidence": [...], "enforcement": "blocking|advisory|semantic|mixed" }
```

### 5.4 类别表行：`| ERR-NNN | <摘要> | <来源> |`（六大类）

### 5.5 统计区（手工）：`| Total lessons | 123 |` 等表格（已漂移，见 F4）

### 5.6 归档条目：与手册详细条目同格式，平铺在 `## Archived Entries` 下

## 6. ERR ID 分配审计（SPEC P0）

**回答 SPEC §4.6 的四个问题**：

1. **谁分配**：Agent 按 record-error 技能 Step 3 自行分配——"Read handbook Statistics section. Next = `ERR-{total+1}`"。
2. **是否扫描最大值+1**：**更糟**——读的是**手工维护的统计计数器**（当前写 123，机器可数 132，已经对不上）。不是扫描，也没有脚本。
3. **是否有脚本**：无。
4. **历史撞号**：**发生过，至少两次**，git 证据：
   - `443b9b502` "docs: add ERR-123 to error experience handbook **(renumbered from ERR-122)**"（PRI-633）
   - `afc395ff8` "docs(handbook): renumber the route-matcher lesson to ERR-119 — **ERR-118 was taken** by the PRI-683 timeout entry on main"

撞号后只能事后 renumber（语义冲突，正是 SPEC §10 要转成 checker fail-loud 的场景）。

**附带发现（F5）**：checker 全部 ID 正则硬编码 `\d{3}`（`\bERR-\d{3}\b` 等）；技能说 999 以上扩到 4 位，但 4 位 ID 会让 checker 的 index↔handbook 双向一致性检查**全部失明**（ERR-1000 不匹配任何正则）。当前 131/999，余量约 868——非近期风险，但迁移时应由 record_id 方案一并消解。

## 7. 现有能力复用矩阵

| Capability | Existing | 处置 | 证据 |
|---|---|---|---|
| HTML-comment JSON 提取 | ✅ | **复用**（record 文件用同一协议） | `extractHtmlComments` + marker 协议，双实现 + 测试奇偶校验 |
| recurrence-meta parser/validator | ✅ | **复用/搬迁**（occurrence 记录继承字段契约） | `parseRecurrenceMeta`（严格日历校验，ERR 教训在案） |
| routing 元数据 parser | ✅ | **保留**（INDEX EP 卡不动） | `parsePatternRouting` |
| hotspot 聚合 | ✅ | **复用**（数据源从"扫描手册"换成"读 occurrence 记录"） | `aggregateHotspots`（90 天窗、enforcement 裁决） |
| checker 命令面 | ✅ | **保留命令兼容，内部换权威源** | `check:error-handbook` / `--audit` / `--hotspots`，verify:merge 接线 |
| 90 天审计 | ✅ | **语义转换**：从"腾空间"变成生命周期建议 | `--audit`（2026-08-16 裁决后已不强制归档） |
| 双 parser 奇偶校验测试 | ✅ | **复用模式**（新 reader 同样上对照测试） | `error-context.test.ts` |
| frontmatter parser | ❌ 无 | 不引入 | 无 gray-matter 等 |
| YAML parser | ✅ js-yaml 5.4.1 | **不用**（纯 ESM 无 default，CJS checker 无法 require——ERR-131 刚记录过此坑） | package.json:74 |
| JSON schema validator | ➖ typebox 在依赖树内但属产品代码 | 不引入，手写 guard 沿用 rc-1..9 | ERR-131 |
| 原子写 | ➖ 散落 `mkdtemp`+rename 模式（scripts/dev 三处） | **复用模式**（tmp+rename），不建公共新抽象 | rg 证据 |
| 确定性 ID 生成 | ➖ 无现成 | 新增最小实现（UTC 时间戳+随机后缀，SPEC §9） | — |

## 8. 审计新发现（SPEC 未预见事实）

### F1 — EP/ERR 双命名空间已存在，Pattern 应映射 EP 卡

v2 已把"模式"建模为 INDEX 的 EP 卡（13 张，带 routing 元数据），`recurrence-meta.pattern` 已用 EP-NN 聚合热点。ERR 条目实际是"模式 + 首次实例"的混合体。**目标模型的 Pattern record 应= EP 卡的结构化扩展（或其伴生记录），Occurrence= 独立复发文件**；不要发明第三套模式概念。INDEX（53KB）本就是小型、无容量压力的检索层——天然承担"pattern 索引视图"。

### F2 — 写入指令权威已漂移（多 Agent 并发质量问题的一个来源）

zcode 会话加载的用户级技能是旧版（旧路径 + 旧工作流 + 无 recurrence-meta 强制 + 无 similarity gate）。仓库版 `.claude/skills/record-error/SKILL.md` 才是新版。**迁移必须同步修复用户级拷贝**（用户级 agent 基础设施，仓库外），否则"Agent instructions 已切换"（SPEC DoD #12）不成立。

### F3 — 归档是 checker 盲区，且有活体缺陷

checker 从不读 `ERROR_ARCHIVE.md`；`check-docs-structure.cjs` 的关键文件名单也不含归档。后果已显现：**ERR-083 双栖**（手册与归档各有一份）。旧归档文件头描述的"50 条门槛 / Step 10 Archive Gate"与技能（8 步无归档）和 checker（150 条警告 / 2026-08-16"归档未获批准"裁决）三处互相矛盾——归档语义本身就是三套口径。迁移后 archive 校验（重复 ID、双栖、生命周期一致性）**必须新增**，这不是弱化而是加强（SPEC G4）。

### F4 — 手工统计区已经漂移

统计区 "Total lessons 123" 无法从任何机器可数集合复算（91 活跃 + 41 归档 − 1 双栖 = 132）。这正是 SPEC §11"派生状态禁止人工维护"的活证据；quality-report.mjs 的机器计数（`**Recurrence**: Yes` 正则）与统计区数字也是两套口径。

### F5 — `\d{3}` 正则天花板（见 §6 附带发现）

### F6 — 路由/热点工具链是净受益方

`error-context.mjs` 只读 INDEX、`--hotspots` 只扫手册文本。记录结构化后，热点聚合从"正则扫散文"变为"读 occurrence 记录"，路由不受影响——**两个工具都不需要语义改动，只需换数据源适配层**。

## 9. 格式建议（SPEC §35 决策）

**推荐：Markdown 记录文件 + 文首 `<!-- pd-error-record {...} -->` JSON 元数据块 + Markdown 散文正文。**

理由：

1. **复用最大化**：HTML-comment JSON 标记协议是仓库唯一有双实现+奇偶测试保障的结构化元数据形态；`extractHtmlComments`/`parseMarkerComment` 几乎原样复用（P7：一个真实已验证的 seam）；
2. **零新依赖**：JSON.parse 内置；js-yaml 5 纯 ESM 会把 CJS checker 逼进迁移死角（ERR-131 活教训）；
3. **Git 友好**：散文正文按行 diff， occurrence 独立文件互不干扰（G2 的物理基础）；
4. **人可读**：Agent 与 Owner 都能直接阅读记录，符合"ERR 是结构化记录、视图是人看的"精神。

备选（纯 JSON 记录文件）可作 fallback：写入/校验最简单，但长散文单行字符串 diff 噪声大。最终在 Phase B 以 schema + reader 原型对比后定稿，不阻塞开工。

**记录落点建议**：`docs/process/error-management/records/<record_id>/pattern.md` + `occurrences/<occ-id>.md`（同目录树内，路径迁移影响面最小，docs-structure 关键文件名单同步扩充）。

## 10. 目标模型映射（Pattern:Occurrence = 1:N）

| 目标概念 | 现有对应物 | 迁移动作 |
|---|---|---|
| Pattern record | EP 卡（INDEX）+ ERR 首条目的模式面 | EP 卡保留为路由面；每张卡（或未入卡的单发 ERR）对应一个 pattern 记录 |
| Occurrence record | ERR 条目的 Date+叙事 + 每个 recurrence-meta + 复发子弹 | 每个带日期的实例 → 一个 occurrence 文件（17 个 meta 块 + 无 meta 的历史实例） |
| 类别表 / 统计区 / hotspot / 手册 / 归档 | 手册+归档排版 | 全部降为派生视图（checker 校验派生物与记录的一致性） |
| archived-NNN 引用 | INDEX 内标记 | pattern `status: archived` 字段 + 派生视图生成对应标记 |

## 11. 迁移风险清单

1. **零信息丢失是硬门**：91 活跃条目含大量长散文与嵌套压缩复发（"compressed; full text → ERROR_ARCHIVE.md"交叉引用），migration manifest 必须逐块映射，未解析块 `preserved_raw`（SPEC §21/22）。
2. **双 parser 同步义务**：CJS/ESM 两套 parser 靠测试钉住；新增 record reader 必须决定权威实现并让旧路径委托，避免第三套实现。
3. **verify:merge 全局门**：cutover PR 必须一次性切换 checker 权威并保持门语义（BLOCKER-7）；工具链（error:context/hotspots）与 CI 的接线顺序要保证 cutover 后仍绿。
4. **交叉引用网**：条目间 `Related ERRs`、`archived-NNN`、归档内 "full text in git history" 说明——manifest 需保留引用完整性。
5. **F2 指令切换半径**：AGENTS.md §14、仓库技能、**用户级技能**、PR 模板四处文字都要在 cutover 内切换（用户级在仓库外，作为伴随动作执行并留证据）。

## 12. SPEC 假设核对结论

| SPEC 假设 | 核对结果 |
|---|---|
| 手册是共享可变热点、300KB 零和门真实存在 | ✅ 证实（checker L109-114；293.4KB 在门下 6.5KB） |
| ID 分配依赖共享写点、有撞号风险 | ✅ 证实且更糟（手工计数器 +1；两次撞号史） |
| recurrence/archive 是手工搬运 | ✅ 证实（8 步手工流程；ERR-083 双栖缺陷） |
| 仓库已有可复用结构化机制 | ✅ 证实（v2 meta 层 + 双 parser + hotspot 聚合） |
| 需要结构化记录 + 派生视图 | ✅ 成立（Connection Before Creation：把已有 meta 层从共享文件里解放为独立记录） |

**无假设被推翻 → 按 SPEC §44 继续 Phase B。**

## 13. Phase B 计划（最小工具层，权威不切换）

1. worktree `PRI-799-err-structured-records`（git-1/9/10/11/13）；
2. record schema（pattern + occurrence）+ reader/validator（复用 meta 协议，单一权威实现 + 奇偶测试）；
3. 最小 writer CLI：`create pattern` / `add occurrence` / `validate` / `archive`（collision-resistant ID、原子写、防重复）;
4. migration dry-run + manifest（对真实手册/归档跑通，`unmapped=0` 目标预演）;
5. handbook 派生投影原型 + parity 校验器（语义等价，不追字节一致）;
6. 并发验收测试（Test A/B/C 用真实双分支模拟，SPEC §24）;
7. 此阶段**不提交迁移快照、不切权威、不动 300KB 门**（Phase C cutover 单独成 PR）。
