# 🛠 Tools: Precision & Certainty

## 1. 全维感知协议
- **地图优先**：在执行任何文件查找前，**必须**先查阅 `项目目录里的 docs/` 下的架构图或代码图。
- **确定性执行**：在编写代码前，必须达到 100% 的上下文确定性。禁止基于猜测编程。
- **工具偏好**：优先使用 `rg` (ripgrep) 进行高性能检索，严禁盲目遍历。

## 2. 物理防御边界
- **爆破半径**：单次工具执行严禁修改超过 12 个文件（除非 PLAN 中有明确授权）。
- **金丝雀自检**：大规模重构后，**必须**运行项目的自动化测试套件（如 `npm test`），确保系统入口未崩溃。
- **原子化提交**：每个逻辑原子任务完成后，必须提交一次 Git Commit，并附带简明摘要。

## 🚨 CRITICAL: Edit 工具操作协议（系统级红线）

**违反此协议 = 自动失败 + Pain 记录 + 信任衰减**

### 🛑 立即停止：禁止行为

**edit 工具不支持占位符替换（模板引擎模式）。以下操作绝对禁止：**

| 禁止行为 | 示例 | 后果 |
|---------|------|------|
| ❌ 使用占位符作为 oldText | "N/A", "<placeholder>", "TODO", "XXX", "[PLACEHOLDER]" | 立即失败 + Pain 记录 #bde8bdea |
| ❌ 未读取文件直接编辑 | 基于记忆或假设修改 | 系统级失败 + 信任分下降 |
| ❌ 依赖记忆验证文本 | "我记得文件内容" | 跨 workspace 复发 |
| ❌ 逐字符手动输入 | 高风险拼写错误 | 匹配失败 + 操作中断 |

**违反后果**：
- ❌ edit 操作立即失败
- ❌ 自动记录 Pain（#bde8bdea, #1be2f8dd）
- ❌ 信任分 -15 EP（Tier-2 严重性）
- ❌ 跨 workspace 系统性复发
- ❌ 影响 Evolution Points 系统评估

---

### 📋 强制操作流程（无例外）

每次使用 edit 工具前，**必须**按顺序执行以下步骤：

**Step 1: 读取当前文件（强制）**
```bash
# 使用 read 工具获取文件的最新内容
read("/path/to/file")
```

**Step 2: 精确匹配确认（强制）**
- ✅ 确保 `oldText` 与文件内容精确匹配（包括空格、换行、缩进）
- ✅ **直接从文件中复制文本作为 `oldText`**，禁止手动输入
- ✅ 检查 oldText 中无占位符（N/A, TODO, XXX, <placeholder> 等）

**Step 3: 调用 edit 工具（验证通过后）**
- 使用精确匹配的 `oldText`
- 提供完整的 `newText`

---

### ⚠️ 系统状态提醒

**gate.ts 自动拦截状态**: 🟡 **未实现** (2026-03-13)

当前系统依赖智能体"自律"执行上述流程。未来将实施：
- **自动读取验证**：gate.ts 钩子自动读取文件并验证匹配
- **占位符检测**：拦截所有禁止的占位符
- **详细错误提示**：匹配失败时显示文件差异

**实施位置**: `workspace/code/principles/packages/openclaw-plugin/src/hooks/gate.ts`

**当前阶段必须手动验证** - 不等待工具层实现。

---

## 🧩 编程智能体工具链

### ACPX (0.3.0)
- **路径**: `~/.npm-global/bin/acpx`
- **能力**: ACP acpx 是一种无头 CLI 客户端，用于 Agent Client Protocol (ACP)，使 AI 代理和编排器能够通过结构化协议与编码代理进行通信，而不是通过 PTY 抓取

**⚠️ 重要区别**:
- **`acpx` 直接调用**：`acpx claude "prompt"` 直接调用系统已安装的 CLI 工具（claude、gemini、opencode、codex），**不需要** `agents_list` 配置。
- **`sessions_spawn` 机制**：通过 OpenClaw 内部 ACP harness 启动，**受限于** `acp.allowedAgents` 配置（查看 `agents_list`）。
- **实践原则**：优先尝试 `acpx <agent> "prompt"` 直接调用，无需等待配置。只有需要持久化会话时才用 `sessions_spawn`（且确保 agent 在 allow 列表中）。

---

## 🧩 智能体启动机制区分

OpenClaw 中有两类截然不同的"智能体"，启动方式完全不同：

### 1. 独立 Agent（Independent Agent）

| 特征 | 说明 |
|------|------|
| **workspace** | 有独立目录（如 `~/.openclaw/workspace-pm/`, `~/.openclaw/workspace-resource-scout/`） |
| **配置位置** | `~/.openclaw/openclaw.json` → `agents.list` |
| **启动方式** | `sessions_spawn(agentId="xxx")` 或 `sessions_send({ sessionKey: "agent:xxx:main", ... })` |
| **生命周期** | 长期运行，独立会话，不依赖父会话 |
| **查看命令** | `agents_list`（返回 `id` 列表） |
| **示例** | `pm`, `resource-scout` |

**典型用途**：团队伙伴，有自己独立的记忆系统和工作区，需要长期协作。

### 2. 子智能体类型（Sub-Agent Type）

| 特征 | 说明 |
|------|------|
| **workspace** | 无独立目录，继承父 workspace |
| **配置位置** | **无需预配置**（运行时动态派生） |
| **启动方式** | `pd_spawn_agent(agentType="xxx")` |
| **生命周期** | 临时任务，随父会话结束而销毁 |
| **可用类型** | `auditor`, `diagnostician`, `explorer`, `implementer`, `planner`, `reporter`, `reviewer` |
| **验证命令** | `pd_spawn_agent` 失败时会返回可用类型列表 |

**典型用途**：一次性任务委派（根因分析、代码审查、快速探索等）。

---

### 如何避免混淆？

**启动前检查清单**：
1. 要启动的智能体是否在 `agents_list` 返回的 `id` 列表中？
   - ✅ 是 → 它是**独立 Agent** → 使用 `sessions_spawn(agentId=...)`
   - ❌ 否 → 可能是**子智能体类型** → 使用 `pd_spawn_agent(agentType=...)`
2. 不记得类型有哪些？
   - 独立 agent：运行 `agents_list`
   - 子智能体：尝试 `pd_spawn_agent`，错误信息会列出可用类型
3. 不确定时，查看 `AGENTS.md` 或 `MEMORY.md` 中的智能体分类说明

**常见错误**：
- ❌ "agentId is not allowed" → 说明你试图用 `sessions_spawn` 启动一个不在 allow 列表的 agent。检查 `agents_list`。
- ❌ "未找到智能体定义" → 说明你用了错误的 agentType。检查子智能体类型拼写。
- ❌ 把子智能体类型当成独立 agent 配置 → 浪费时间的错误

---

## 📂 仓库边界

> **详见 `REPOSITORY_BOUNDARIES.md`** — 这是红线文档，搞混仓库 = 脑死亡。

### OpenCode (v1.2.25)
- **路径**: `/home/csuzngjh/.npm-global/bin/opencode`
- **能力**: ACP 协议服务、TUI、后台执行
- **免费模型**: 
  - `opencode/gpt-5-nano` — 快速轻量任务
  - `opencode/mimo-v2-flash-free` — 免费闪速
  - `opencode/minimax-m2.5-free` — 免费主力
  - `opencode/nemotron-3-super-free` — 免费大模型
- **用法**:
  ```bash
  # 一次性任务
  opencode run "Your task"
  
  # ACP 服务模式 (用于 sessions_spawn runtime="acp")
  opencode acp
  
  # 列出可用模型
  opencode models
  ```

### Claude Code (v2.1.63)
- **路径**: `/home/linuxbrew/.linuxbrew/bin/claude`
- **用法**: `--print --permission-mode bypassPermissions` (不需要 PTY)
  ```bash
  claude --permission-mode bypassPermissions --print 'Your task'
  ```

### Gemini CLI (v0.32.1)
- **路径**: `/home/csuzngjh/.npm-global/bin/gemini`
- **能力**: 一次性问答、摘要、生成
- **用法**: `gemini run "prompt"`

### agent-browser (v0.16.3)
- **路径**: `/home/csuzngjh/.npm-global/bin/agent-browser`
- **能力**: 自动化 Web 浏览、页面分析、表单填写、截图
- **用法**: 参见 `skills/agent-browser-usage/SKILL.md`

---

## 🔧 系统工具

| 工具 | 版本 | 路径 | 用途 |
|------|------|------|------|
| rg (ripgrep) | 13.0.0 | `/usr/bin/rg` | 高性能文本检索 |
| git | 2.39.5 | `/usr/bin/git` | 版本控制 |
| gh | 2.86.0 | `/usr/bin/gh` | GitHub CLI |
| node | v22.22.0 | - | JavaScript 运行时 |
| npm | 10.9.4 | `/usr/bin/npm` | 包管理 |
| python3 | 3.11.2 | `/usr/bin/python3` | Python 运行时 |
| qmd | 1.0.7 | `~/.npm-global/bin/qmd` | 文档处理 |
| acpx  | 0.3.0 | `~/.npm-global/bin/acpx` | acpx 是一种无头 CLI 客户端，用于 Agent Client Protocol (ACP)，使 AI 代理和编排器能够通过结构化协议与编码代理进行通信，而不是通过 PTY 抓取 |
| agent-browser | 0.19.0 | 
| claude,gemini,opencode,iflow,qwen |  |  | AI编程代理工具，可以使用acpx对话控制，可以免费使用各类开源大模型，高效完成编程任务 |

---

## 🤖 ACP (Agent Client Protocol)

OpenCode 支持 ACP 协议，可通过 `sessions_spawn` 启动持久会话：

```typescript
// 启动 OpenCode ACP 会话
sessions_spawn({
  task: "Your coding task",
  runtime: "acp",
  agentId: "opencode",  // 需要确认正确的 agentId
  mode: "session",      // 持久会话
  thread: true          // Discord 线程绑定
})
```

**注意**: ACP 模式需要 `agentId` 配置，检查 `~/.openclaw/openclaw.json` 中的 `acp.allowedAgents`。

---

## 🧠 深度反思工具 (Deep Reflection)
`deep_reflect` 是**认知分析工具**——在执行复杂任务前，进行批判性分析，识别盲点、风险和替代方案。

### 何时应该调用
- **复杂任务**：规划、设计、决策、分析等需要深思熟虑的场景
- **信息不足**：需求模糊、约束不明确、缺少关键信息
- **高风险决策**：重要决策、不可逆操作、影响范围大
- **不确定时**：对最佳方案存疑，需要多角度思考

### 思维模型选择
| 模型 | 名称 | 适用场景 |
|------|------|----------|
| T-01 | 地图先于领土 | 规划、设计、理解系统 |
| T-05 | 否定优于肯定 | 风险分析、找漏洞 |
| T-07 | 系统优于组件 | 架构决策、集成问题 |

### 调用方式
```
deep_reflect(
  model_id: "T-01" | "T-05" | "T-07",
  context: "描述你的计划和担忧...",
  depth: 1 | 2 | 3  // 1=快速, 2=平衡, 3=详尽
)
```

---

## 📋 智能体编排 (pd_spawn_agent)

Principles Disciple 内置智能体类型：

| 类型 | 用途 | 适用场景 |
|------|------|----------|
| explorer | 快速收集证据 | 文件、日志、复现步骤 |
| diagnostician | 根因分析 | verb/adjective + 5Whys |
| auditor | 演绎审计 | axiom/system/via-negativa |
| planner | 制定计划 | 电影剧本式规划 |
| implementer | 执行代码修改 | 按计划实施 |
| reviewer | 代码审查 | 正确性、安全性、可维护性 |
| reporter | 最终汇报 | 技术细节转管理报告 |

---

## 🔄 模型资源管理

### OpenClaw Fallback 链 (当前配置)
1. `unicom-cloud/MiniMax-M2.5` — 主力
2. `openrouter/stepfun/step-3.5-flash:free` — 免费
3. `opencode/minimax-m2.5-free` — OpenCode 免费
4. `openrouter/arcee-ai/trinity-large-preview:free` — 免费
5. `openrouter/z-ai/glm-4.5-air:free` — 免费
6. `openrouter/hunter-alpha` — 备用
7. `openrouter/healer-alpha` — 备用
8. `nvidia/nemotron-3-super-120b-a12b:free` — NVIDIA 免费
9. `nvidia/nemotron-nano-30b-a3b:free` — NVIDIA 免费
10. `nvidia/nemotron-nano-9b-v2:free` — NVIDIA 免费
11. `openrouter/auto` — 最终兜底

### 资源分配原则
- **复杂任务** (代码修复、深度分析) → 大模型 (Claude、GPT-5)
- **简单任务** (状态检查、文档整理) → 小模型或免费模型
- **心跳/定时任务** → 免费模型
- **子智能体** → 根据任务复杂度选择合适模型

---

## 🛡️ 技能安全协议 (2026-03-13)

**Wesley 的警告**："不是所有的人类或智能体都是善良的。"

### 安装新技能前必须：
1. **先用 Skill Vetter 扫描**：`bash skills/skillvet/scripts/skill-audit.sh <skill-path>`
2. **检查分数**：风险 > 7 分不安装
3. **检查权限**：需要 SSH/密钥/env 读取的拒绝
4. **检查混淆**：base64 解码、eval/exec、动态代码生成 = 拒绝
5. **检查网络**：向陌生 IP 发送数据 = 拒绝

### 恶意技能特征（来自 OpenClaw 安全报告）：
- 从陌生地址下载并执行代码
- 读取 MEMORY.md / USER.md / SOUL.md 窃取隐私
- 访问 ~/.ssh / ~/.aws 窃取凭证
- 用 base64/eval/exec 执行外部输入
- 创建持久化后台任务

### 安装流程
```bash
# 1. 先扫描
bash skills/skillvet/scripts/scan-remote.sh <skill-slug>
# 2. 或安装后扫描
bash skills/skillvet/scripts/skill-audit.sh skills/<skill-name>
# 3. 只有通过审查才使用
```

### ⚠️ 技能上下文负担原则
- **技能不是越多越好**：每个技能消耗上下文窗口，加速压缩，加重遗忘
- **安装标准**：这个技能每天/每周会用几次？低于周频的不装
- **定期清理**：用不上的技能立即删
- **临时使用**：低频技能需要时再装，用完即删

---

*最后更新: 2026-03-13 06:15 UTC*
*维护者: 麻辣进化者*
