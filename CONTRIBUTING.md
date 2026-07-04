# Contributing to Principles

## 开发流程

### 🔴 核心规则：禁止直接推送

**严禁** 直接推送代码到 `main` 或 `master` 分支。

所有代码变更必须通过 Pull Request 流程：

```bash
# 1. 创建分支
git checkout -b feature/your-feature

# 2. 开发并提交
git add .
git commit -m "feat: your feature"

# 3. 推送分支
git push -u origin feature/your-feature

# 4. 创建 PR
gh pr create --title "feat: your feature" --body "Description"
```

### 分支命名规范

| 类型 | 格式 | 示例 |
|------|------|------|
| 功能 | `feature/<name>` | `feature/evolution-points` |
| 修复 | `fix/<issue-id>-<name>` | `fix/18-trust-engine` |
| | `fix/<name>` | `fix/edit-verification` |
| 文档 | `docs/<name>` | `docs/readme-update` |

### 提交信息格式

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**类型**:
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档
- `refactor`: 重构
- `test`: 测试
- `chore`: 维护

### PR 审核要求

- 所有 PR 必须有至少 1 个 reviewer
- CI 测试必须通过
- 代码风格检查必须通过

## 决策矩阵

| 操作 | 决策者 |
|------|--------|
| 代码实现 | 硅基（我） |
| 测试验证 | 硅基（我） |
| 合并 PR | 碳基（Wesley） |
| 战略方向 | 碳基（Wesley） |

## 代码风格

本项目使用 ESLint 和 TypeScript 进行代码风格检查：

- **工具**: ESLint + @typescript-eslint
- **配置文件**: `packages/openclaw-plugin/eslint.config.js`
- **运行检查**: `npm run lint`（在 `packages/openclaw-plugin` 目录下）
- **主要规则**:
  - `no-empty`: error
  - `no-console`: warn
  - `complexity`: max 10
  - `@typescript-eslint/no-explicit-any`: warn
  - `@typescript-eslint/no-unused-vars`: warn（以下划线开头的参数除外）

提交前请确保 `npm run lint` 无错误。

## 问题反馈

### PD Console 反馈通道（推荐）

除了在 GitHub 提交 issue 外，你也可以：

1. **PD Console → Report Problem 页面**：打开 PD Console，点击侧边栏的 "Report Problem" 工具，填写问题描述、复现步骤、期望/实际行为。Console 会自动收集 PD 版本、平台信息、feature flags、最近事件等诊断数据，生成结构化的反馈草稿。
   - 草稿生成后，你可以选择：
     - **Open Email**：通过 `mailto:` 链接直接发送到维护者邮箱（`csuzngjh@hotmail.com`）
     - **Open GitHub Issue**：通过预填的 GitHub issue URL 在仓库创建 issue
     - **Copy Markdown**：复制 markdown 报告内容，自行粘贴到任意渠道

2. **Failed Tasks 页面 → 一键创建反馈**：当 PD 管道中有失败任务时（diagnostician / internalizer 等 peer runner 永久失败），Failed Tasks 页面会列出所有失败任务。每行都有 "Create Feedback Draft" 按钮，点击后会自动跳转到 Report Problem 页面，并预填 taskId 和 painId。提交后，系统会自动合并 peer runner 捕获的失败上下文（agent draft）到反馈报告中，包括：
   - 失败摘要（error category + 时间戳）
   - 观察到的错误（已脱敏的 error message + stack 头部）
   - 命令摘要（最后一次 run 的 tool calls 摘要）

3. **CLI 命令**：使用 `pd errors list` 命令可以在终端查看所有失败任务和 worker errors，便于快速排查。
   - `pd errors list` — 列出所有失败任务和 worker 错误
   - `pd errors list --json` — JSON 输出（可被 jq 处理）
   - `pd errors list --kind diagnostician` — 按类型过滤
   - `pd errors list --since 24` — 只看最近 24 小时

### 报告 Bug

请通过 GitHub Issues 反馈问题，包含以下信息：

- **问题描述**: 简明描述问题现象
- **复现步骤**: 1、2、3...
- **预期行为**: 应该如何工作
- **实际行为**: 实际发生了什么
- **环境信息**: Node.js 版本、操作系统等

### 功能请求

欢迎提交功能请求，请说明：

- **使用场景**: 这个功能解决什么问题
- **建议方案**: 你期望的解决方案
- **替代方案**: 你考虑过的其他方案

Issue 链接: https://github.com/csuzngjh/principles/issues

## 信任系统

本项目使用 Evolution Points (EP) 成长系统：

- 5 个等级：Seed → Sapling → Tree → Forest → Garden
- 通过正向行为（完成 PR、代码审查、测试）获取 EP
- 违规行为（直接推送、跳过测试）会阻止等级提升

---

*最后更新: 2026-03-13*
