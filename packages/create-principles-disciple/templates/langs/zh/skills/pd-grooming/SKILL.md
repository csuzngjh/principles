---
name: pd-grooming
description: 执行工作区“大扫除” (Workspace Grooming)，将散落的临时文件归档或清理，维持项目的数字洁癖。
---

# 🧹 技能：工作区大扫除 (Workspace Grooming)

> **触发时机**：当用户输入 `/workspace-grooming`，或在 `HEARTBEAT` 巡检中发现根目录存在临时文件时主动调用。

## 🎯 核心目标
贯彻“熵减法则”，清理工作区根目录下的“数字垃圾”，但**绝对保证核心业务代码和配置文件的安全**。

## 🛡️ 安全红线 (The Red Lines)

在执行清理操作时，必须严格遵守以下白名单与黑名单：

### 🚫 绝对禁区 (DO NOT TOUCH)
**即使这些文件/目录看起来很乱，也绝对不允许删除或移动它们：**
- **业务源码**：`src/`, `lib/`, `tests/`, `app/`, `pages/`, `components/` 以及任何以 `.ts`, `.js`, `.py`, `.go`, `.rs`, `.java` 结尾的文件。
- **项目配置**：`package.json`, `Cargo.toml`, `requirements.txt`, `tsconfig.json`, `vite.config.ts`, `.env*` 等。
- **版本控制**：`.git/`, `.gitignore`。
- **构建输出**：`dist/`, `build/`, `node_modules/`, `target/`。

### 🌟 核心资产区 (Core Assets)
**这些文件必须留在根目录，不可触碰：**
- `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`
- `README.md`, `PLAN.md`
- `.principles/`, `.state/`

### 🎯 可处理区 (Targets for Grooming)
**你可以对以下文件采取行动：**
1. **测试残骸**：根目录下散落的 `test.txt`, `temp.md`, `debug.log`, `foo.js` 等明显是随手创建的临时文件。
2. **草稿笔记**：未分类的散乱 `.md` 笔记或 `_scratchpad.md`。
3. **命名违规**：使用了空格或大写的文档（如 `My New Feature.md`）。

## 🪜 执行步骤

1. **扫描环境**：执行 `ls -la` 查看根目录。
2. **识别目标**：根据上面的“安全红线”，列出所有属于“可处理区”的嫌疑文件。
3. **制定计划**：
   - 对于临时垃圾（如空文件、测试脚本）：提议**直接删除 (`rm`)**。
   - 对于有价值的笔记或日志：提议**归档 (`mv`)** 至 `memory/archive/`。
   - 对于命名不规范的文件：提议**重命名 (`mv`)** 为 `kebab-case` 格式。
4. **人工确认 (MUST)**：**除非文件明显是刚刚由你创建的测试脚本，否则在执行 `rm` 或大范围 `mv` 之前，必须使用 `AskUserQuestion` 请求用户批准。**
   - 示例提问：“我发现根目录下有 `test1.txt` 和 `old_notes.md`。我计划删除前者，并将后者归档到 `memory/archive/`。是否同意？”
5. **执行并复命**：获得批准后执行文件操作，并回复一条简短的“大扫除完成”确认信息。