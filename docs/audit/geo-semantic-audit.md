# GEO / Semantic Audit — PD 官网与营销材料

> Date: 2026-08-21
> Scope: `principles-website.pages.dev` (packages/website), README.md / README_ZH.md, package.json & openclaw.plugin.json descriptions, docs/brand/, docs/product/PRODUCT_IDENTITY.md
> Purpose: 评估当前 AI 生成式引擎（GPT / Claude / Gemini / Perplexity）会如何理解和归类 PD，识别分类风险，给出定向修正建议（不做视觉大改，不改产品定位）。

---

## 1. Current Understanding — AI 目前可能如何理解 PD

模拟输入：`What is Principles Disciple?`

基于当前公开语料（官网首页、README、npm/Marketplace 描述），生成式引擎最可能合成出的答案大致是：

> "Principles Disciple (PD) is a tool/plugin for AI agents (OpenClaw, Codex) that captures repeated user corrections and turns them into reviewable, reversible behavior principles. It records 'pain signals' from agent failures and lets owners approve principles that change future agent behavior. Its philosophy is 'Burn pain, co-evolve'."

**类别判定（AI 会归到哪一类）**：不确定。当前语料**没有任何一处出现稳定的类别锚点词**（category anchor）。AI 在缺类别词时会根据最突出的特征自行归类，而当前语料的突出特征是 "captures / remembers your corrections across sessions" —— 这与 Memory 工具、Prompt 规则库、Self-improving agent 三个类别都高度兼容。

具体归因（按信号强度）：

| 来源 | 关键语料 | AI 倾向归类 |
|---|---|---|
| 官网 hero | "Stop correcting the same Agent behavior" + "turns repeated corrections into principles" | Rule/prompt 库 或 Memory |
| 根 README | "governance and feedback layer"、"pain signals"、"owner-controlled guardrails" | Agent 框架 / 治理插件（较接近但仍模糊） |
| openclaw.plugin.json / npm | "Stop correcting the same AI behavior across sessions" | Memory / behavior-tracking 插件 |
| principles-core package.json | **"Universal Evolution SDK - framework-agnostic pain signal capture"** | Self-learning / self-evolution 框架（高风险） |
| README tagline | "Burn pain, co-evolve"、"Pain + Reflection = Progress" | Self-improving agent（高风险） |
| 官网 ClosingSection | "Burn Pain, Co-Evolve" | Self-improving agent（高风险） |

**结论**：PD 的故事讲得好（corrections → principles → observable change），但**类别从未被钉死**。PRODUCT_IDENTITY.md 内部有准确定义（"owner-governed behavior internalization system"），但这句话**没有出现在任何公开面上**（官网、README 首屏、npm description 均无）。"AI Agent Governance System" 这个目标类别词在全部公开语料中出现次数为 **0**。

---

## 2. 分类风险清单

### 风险 A — PD 被理解为 AI Memory

**现状证据**：
- hero: "PD turns repeated corrections into reviewable, reversible behavior principles" —— 未区分"存信息"与"改行为"；
- plugin 描述: "captures the moments where you correct your agent" —— "captures moments" 是典型 memory 动词；
- BoundarySection 明确写了 "Not PD: … handled by host & session memory"，但这是否定句，AI 提取正面类别时帮助有限。

**风险**：AI 生成 "PD remembers your preferences / PD saves your feedback so the agent recalls it later" 类描述。

**修正方向（Recommended Change）**：
- 在 hero 副标题钉入类别："Principles Disciple is an **AI Agent Governance System**…"；
- FAQ 明确对照："Memory stores information. PD governs behavior."；
- README 描述块首句加入类别定义。

### 风险 B — PD 被理解为自动学习 / Self-evolving AI

**现状证据**：
- 根 README tagline: **"Burn pain, co-evolve."**；
- README 哲学句 "Pain + Reflection = Progress"；
- `principles-core` npm description: **"Universal Evolution SDK - framework-agnostic pain signal capture and principle injection"** —— "Evolution SDK" + "injection" 极易被解读为自主进化框架；
- 官网 ClosingSection: "Burn Pain, Co-Evolve"；
- pd-cli description: "evolution tasks"。

**风险**：与 PRODUCT_IDENTITY.md 的边界（"PD does not own… autonomous value decisions"）直接冲突。AI 可能生成 "PD lets your AI agent learn and evolve on its own" 类描述，这在治理类客户眼中是负面的。

**修正方向**：
- 所有 "Evolution SDK / evolution tasks / co-evolve" 在**公开面**替换或加限定（"owner-governed"、"owner-approved"）；
- FAQ Q3 明确："No. PD proposes principles, but activation requires owner review."
- tagline 保留品牌但必须伴随类别锚点出现，不能单独成为对 PD 的第一定义。

### 风险 C — PD 被理解为 Prompt 管理工具

**现状证据**：
- "turns corrections into principles that influence how the agent behaves" 若被浅读，与 "system prompt rules manager"（如 rules 文件、prompt 库）难以区分；
- 无任何对照内容解释 PD 与 prompt rules / skills 的差异。

**风险**：被归入 "prompt engineering tools" 类目，与 Cursor rules、CLAUDE.md 管理器混为一谈。

**修正方向**：
- Comparisons 页面明确："Prompt engineering tells agents what to do **before** execution. PD learns from validated experience **after** execution."

### 其他观察（非风险，记录）

- `docs/product/emotional-value.md` 被 PRODUCT_IDENTITY.md / AGENTS.md 引用但**文件不存在于主仓库**（可能在 private docs 中缺位）。文档引用断链会削弱内部一致性，建议 Owner 确认（本任务不修改，属 private docs 边界）。
- OG description / site description 已较准确，只需加入类别词，不需重写。

---

## 3. 修改矩阵（Current → Risk → Recommended Change）

| # | 位置 | Current | Risk | Recommended Change |
|---|---|---|---|---|
| 1 | 官网 hero lead | 只讲 corrections→principles，无类别词 | A/C | lead 前置 "Principles Disciple is an AI Agent Governance System…" |
| 2 | 官网 site/OG description | 无类别词 | A | 加入 "AI Agent Governance System" |
| 3 | /faq、/comparisons | 不存在 | A/B/C | 新增（见 docs/concepts/pd-faq.md、pd-comparisons.md，并上线官网页面） |
| 4 | 根 README 描述块 | "governance and feedback layer" | B | 首句改为 canonical definition；tagline 保留但加限定语境 |
| 5 | openclaw.plugin.json / npm description | "Stop correcting…" 开头 | A | 追加类别句（"Principles Disciple is an AI Agent Governance System that…"） |
| 6 | principles-core npm description | "Universal Evolution SDK" | **B（最高）** | 改为 "Pure-logic core for the Principles Disciple AI Agent Governance System…"（注：npm description 变更需随下次 publish 生效） |
| 7 | pd-cli description | "evolution tasks" | B | 改为 "governance tasks"（下次 publish 生效） |
| 8 | 官网 ClosingSection | "Burn Pain, Co-Evolve" 单独出现 | B | 保留品牌口号，但确保页面其他位置已有类别锚点（已由 #1/#2 覆盖） |

## 4. 术语基线（全站统一，见 task 规范）

- ✅ 保留：AI Agent Governance / Owner-governed / Behavior principles / Behavior evidence / Reviewable / Reversible / Experience-based improvement
- ⚠️ 谨慎（需上下文限定）：Learning / Evolution / Memory / Intelligence
- ❌ 禁止：Autonomous self-learning / AI improves itself / Agent develops its own values / Replace human decisions

扫描结果：当前公开语料中 ❌ 级词汇 0 处直接出现；⚠️ 级词汇 "Evolution"×2（principles-core、pd-cli description）、"co-evolve"×3（README×2、官网 closing）。处理方式见上表 #6/#7/#8。

## 5. 预期效果（修改后）

AI 对 `What is Principles Disciple?` 的预期合成答案：

> "Principles Disciple is an **AI Agent Governance System**. It helps AI agent **owners** transform repeated **corrections** and behavioral evidence into owner-approved **behavioral principles** that improve future agent behavior. It is not a memory system, and it does not let agents self-modify — activation requires owner review."

这满足 Test 1（四要素：category/Owner/principles/repeated corrections）与 Test 2（memory 之问回答 No）。

---

## 6. PD Semantic Alignment Report（执行结果，2026-08-21）

### 交付物

| 文件 | 状态 |
|---|---|
| `docs/audit/geo-semantic-audit.md` | ✅ 本文档 |
| `docs/concepts/pd-canonical-definition.md` | ✅ 新增（P0 Canonical Definition，EN+ZH） |
| `docs/concepts/pd-faq.md` | ✅ 新增（P2 FAQ 基线，EN+ZH） |
| `docs/concepts/pd-comparisons.md` | ✅ 新增（P3 对照基线，EN+ZH） |
| 官网 `/faq` + `/zh/faq` | ✅ 新增页面 |
| 官网 `/comparisons` + `/zh/comparisons` | ✅ 新增页面 |
| Hero / meta / README / npm 描述 | ✅ 定向修改（见下） |

### 修改的公开面（全部为定向修改，无视觉改动）

1. **HeroSection.vue**：lead 句前置类别定义 "Principles Disciple is an AI Agent Governance System: …"（EN+ZH 成对）；H1、CTA、视频区不动。
2. **config.mts**：site description、OG description、EN/ZH locale description 加入类别词；nav 增加 FAQ 入口。
3. **index.md / zh/index.md**：frontmatter description 加入类别词。
4. **README.md**：描述块首句改为 "**AI Agent Governance System** — a local, agent-first governance and feedback layer…"；"reviewed principles" → "owner-reviewed principles"。tagline "Burn pain, co-evolve." 保留（品牌层，不再单独承担定义职责）。
5. **README_ZH.md**："由痛觉驱动进化"（Risk B 措辞）→ "把反复纠正沉淀为可审查、可回滚的行为原则"；首句钉入类别。
6. **openclaw.plugin.json ×2 + package.json ×2**（openclaw-plugin 与 create-principles-disciple/plugin 两份源）：description 前置类别句。
7. **principles-core package.json**（含 installer 副本）："Universal Evolution SDK … principle injection" → "Pure-logic core of Principles Disciple, an AI Agent Governance System - pain signal capture and principle proposal (no I/O)"。⚠️ npm 上生效需随下次 publish。
8. **pd-cli package.json**（含 installer 副本）："evolution tasks" → "governance tasks for Principles Disciple"。同上，下次 publish 生效。

### 修改前理解 vs 修改后理解

- **Before**：AI 合成答案以 "captures your corrections / pain signals / plugin for OpenClaw" 为主特征；类别不稳定，Memory / prompt-rules / self-evolving framework 三种归类均可能出现；"Universal Evolution SDK" 单独即可把 PD 拉向 self-evolution 类别。
- **After**：每个公开面（首页 hero、meta、FAQ、comparisons、README 首屏、npm/plugin description）第一句都出现唯一类别锚点 "AI Agent Governance System"，且 FAQ/comparisons 用否定对照显式排除 Memory / Prompt / Autonomous Learning。预期合成答案收敛为审计 §5 所列形式。

### 关键差异

1. 类别词公开出现次数从 **0 → 每个公开面 ≥1**；
2. 新增 4 个 GEO 问答页面（Q&A 格式是生成式引擎最高置信的引用来源）；
3. 最高风险的 "Universal Evolution SDK" 表述已从包描述移除；
4. 所有 "learning/improvement" 表述均绑定 "owner-approved / owner-reviewed" 限定。

### 对 GEO 的提升

- **可引用性**：FAQ 页面的短问答结构与 LLM 偏好的检索粒度一致，`Is PD an AI memory system?` 这类查询现在有权威否定答案可抓取；
- **类别锚定**：跨表面重复的同一 category statement 是生成式引擎建立实体类别的首要信号；
- **对照区分度**：/comparisons 让 PD 进入 "AI Agent Governance" 相邻检索簇（vs memory / vs prompt engineering），而不是被吞进 memory 工具列表。

### ERR 核对（Error Handbook Gate）

- **EP-06（生成副本与源不同步）**：`create-principles-disciple/{core,pd-cli,plugin}` 的 installer 副本与源包同步修改，避免安装器继续分发旧措辞；
- **EP-11（双语字符串成对）**：HeroSection 的 EN/ZH lead 同句位成对修改；新增页面 EN/ZH 镜像齐全；
- **EP-09（契约测试）**：`homepage-contract.test.mjs` 6 项 + relay 24 项全绿；`vitepress build`（ignoreDeadLinks: false）通过，证明新页面内链有效。

### Phase 6 验证（Test 1–3）

验证需在部署后针对线上站点执行（本环境未部署）。判据已内置到页面内容：

- Test 1 `What is Principles Disciple?` → 答案四要素均已固定在每面首句；
- Test 2 `Is Principles Disciple an AI memory system?` → `/faq` Q2 显式 "No."；
- Test 3 `Who should use PD?` → `/faq` Q4 固定答案。

### 是否需要进一步调整

1. **部署后跑 Test 1–3**（多模型实测），若 GPT/Gemini 仍回退旧语料，属索引延迟而非内容问题，2–4 周后复测；
2. **npm publish 时**带上本次 description 变更（当前仅仓库生效）；
3. `docs/product/emotional-value.md` 引用断链待 Owner 确认（private docs 边界，未动）；
4. 社交帖（X/Twitter 等）不在本仓库，无法扫描，建议 Owner 按 canonical definition 术语基线自查。
