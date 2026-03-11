---
name: bootstrap-tools
description: Scans project tech stack and searches the web for the latest, most effective CLI tools to augment agent capabilities. Suggests and installs tools upon user approval.
disable-model-invocation: true
---

# /bootstrap-tools: 装备升级官

你的目标是让智能体团队拥有最先进的武器。通过分析当前项目栈，并**实时联网搜索**，寻找能提升开发、重构、测试效率的最佳 CLI 工具。

## 执行流程

### 1. 侦察 (Recon)
- **分析技术栈**: 读取 `package.json`, `Cargo.toml`, `requirements.txt` 等。确定核心框架（如 Next.js, FastAPI）。
- **盘点现状**: 运行 `npm list -g --depth=0` 和 `command -v` 检查已安装的工具。

### 2. 寻宝 (Hunt)
- **联网搜索**: 针对当前栈，搜索最新的 CLI 神器。
  - *Query 示例*: "best CLI tools for Next.js 15 development 2025", "fastest rust-based grep alternative", "modern linter for python".
- **筛选标准**:
  - **Headless**: 必须是 CLI 工具。
  - **Performance**: 优先推荐 Rust/Go 编写的高性能工具 (e.g., `ripgrep`, `ast-grep`, `oxc`).
  - **Relevance**: 能解决实际痛点（如 `knip` 查死代码，`depcheck` 查依赖）。

### 3. 提案 (Pitch)
- 使用 `AskUserQuestion` 向用户展示推荐清单。
- **格式**:
  - **工具名**: [Name]
  - **推荐理由**: [Why it helps the agent/project]
  - **安装命令**: `npm i -g ...` 或 `apt-get ...`
  - **Demo**: 给出一个简单的用法示例。

### 4. 部署与登记 (Deploy & Register)
- 获得批准后，执行安装命令。
    - **验证 (Verification - 强制)**:
      - 安装完成后，**必须**运行 `<tool> --version` 或 `command -v <tool>` 来验证是否真的安装成功。
      - **若失败**: 告知用户（可能是权限问题），请求用户手动安装，**不要**更新能力文件。
      - **若成功**: 
        - 更新 `.state/SYSTEM_CAPABILITIES.json`。记录新工具的路径。
        - **全员广播**: 
          - 扫描 `.claude/agents/*.md`。
          - 检查每个文件是否包含 `@.state/SYSTEM_CAPABILITIES.json`。
          - 若未包含，在文件末尾追加：
            ```markdown
            
            ## Environment Capabilities
            Check @.state/SYSTEM_CAPABILITIES.json for high-performance tools (e.g., ripgrep, ast-grep) available in this environment. Use them!
            ```
          - 提示用户运行 `/manage-okr` 或 `/admin diagnose` 以让 Agent 感知新能力。
## 核心原则
- **喜新厌旧**: 敢于推荐新工具替代旧工具（如推荐 `pnpm` 替 `npm`，推荐 `vitest` 替 `jest`），但要说明理由。
- **安全第一**: 在安装前必须获得用户明确授权。
