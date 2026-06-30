# 参与贡献 (Contributing)

[English](CONTRIBUTING.md) | [中文](CONTRIBUTING_ZH.md)

感谢你对 **Principles Disciple** 框架感兴趣！这是一个致力于通过“元认知”与“痛觉反射”来引导 AI 智能体进化的开源项目。

我们非常欢迎来自社区的贡献。你可以通过提交 Bug 报告、完善代码，或者**最重要的是——提交新的思维模型 (Thinking OS Models)** 来参与进来。

## 🧠 核心贡献：提议新的思维模型

本项目最具有价值的共创部分在于 `THINKING_OS.md` 中的思维模型库。如果你在实际重度使用 OpenClaw 时，总结出了一些极其有效的“人机协作心法”或能有效避免 AI 盲目犯错的“元反馈机制”，请向我们提议。

### 提议原则 (Proposal Criteria)

所有进入 `THINKING_OS_CANDIDATES.md` 甚至最终晋升到 `THINKING_OS.md` 的思维模型，必须满足以下严苛条件：

1. **普适性 (Generality)**: 它不能是针对某个特定语言（如“不要用 Python 2”）或特定项目库的规则，它应当是一种底层的思考方式（如“否定优于肯定”、“最小必要干预”）。
2. **可观测信号 (Observable Signals)**: 它能在对话中产生可被检测的痕迹，无论是用户输入的 prompt，还是 AI 回复的文本规律（Regex 可被匹配）。
3. **极简表达 (Minimal Token Cost)**: 一句话说明理念，一句话说明要避免的灾难。整个描述必须高度压缩。

### 如何提交新模型

1. 在你的项目里通过 `/thinking-os propose "模型名称：核心理念和防灾底线"` 试运行你的模型。
2. 收集它成功防范 AI 犯错的截图或日志。
3. Fork 本仓库。
4. 将你的提议添加到 `docs/THINKING_OS_CANDIDATES.md` 文件中。
5. 提交 Pull Request，并在 PR 描述中详细说明：
   * 这个模型解决的核心痛点是什么？
   * 它的可观测 Regex 信号是什么？
   * 它是否与现有的 9 个基础模型重叠？

## 💻 代码与架构贡献

如果你想为本框架（Hooks、门禁逻辑、记忆扫描器等）贡献代码：

1. **环境准备**:
   * 如果修改 OpenClaw 插件：进入 `packages/openclaw-plugin` 目录，运行 `npm install`。
2. **规范化**:
   * 运行 `npm run build` 和 `npm run test` 确保无构建错误和回归。
3. **提交规范**:
   * 我们的 commit message 遵循 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) 规范（例如 `feat:`, `fix:`, `docs:`）。
   * Pull Request 请尽可能说明修改的背景与前因后果。

## 🐛 报告问题 (Bug Reports)

在提 Issue 前，请：
1. 先检查仓库中是否已有类似 Issue。
2. 请附上 `docs/SYSTEM.log` （如果有相关报错）。
3. 说明当前的运行环境详情（OpenClaw 版本、插件版本等）。

每一次提交与反馈，都是这个系统“进化”的一次循环。感谢你的同行！
