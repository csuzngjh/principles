# 技术攻坚报告：Agent Hook 系统环境兼容性问题

**日期**：2026-01-22
**状态**：阻塞 (Blocked)
**优先级**：P0

## 1. 问题背景
在开发 "Evolvable Programming Agent" 的 Hook 系统（特别是 `pre_write_gate.sh`）时，我们在 Windows 宿主机的 WSL (Ubuntu) 环境下遇到了持续的测试失败。核心功能是拦截针对 `risk_paths`（如 `src/server/`）的写入操作，但在单元测试中该拦截逻辑始终未能生效。

## 2. 核心挑战

### 2.1 路径格式错配
- **输入端**：测试脚本或 Agent 工具调用可能传入 Windows 格式路径（如 `d:\Code\principles\src\server\test.ts`）。
- **运行端**：脚本在 WSL 中运行，`pwd` 获取的是 Linux 格式路径（`/mnt/d/Code/principles`）。
- **现象**：尽管添加了路径规范化逻辑，`$FILE_PATH` 与 `$PROJECT_DIR` 的相对路径计算（`${FILE_PATH#$PROJECT_DIR/}`）依然失效，导致无法匹配 `PROFILE.json` 中的风险路径前缀。

### 2.2 环境变量污染
- 为了解决 `jq` 找不到的问题，曾尝试修改 `PATH`，导致 `.bashrc` 和 `.bash_profile` 被错误配置覆盖，造成 WSL 基础命令（`ls`, `sudo`）暂时不可用（已修复）。
- **教训**：Hook 脚本不应修改系统级环境变量。

### 2.3 Shell 脚本调试困难
- Bash 的 `set -e` 导致脚本在中间步骤（如 `jq` 调用）失败时直接退出，且错误信息被测试脚本吞噬（虽已修复测试脚本的 stderr 重定向，但调试依然困难）。
- 并行执行的测试脚本导致输出混乱。

## 3. 已尝试方案

| 方案 | 结果 | 分析 |
|------|------|------|
| **各种 PATH 注入** | 失败 | 导致环境不稳定，且不仅没解决 jq 问题，还破坏了系统命令。 |
| **安装 WSL 原生 jq** | **成功** | 解决了工具依赖问题，现在 jq 可正常运行。 |
| **Bash 路径规范化** | 失败 | 尝试用正则转换 `D:\` 到 `/mnt/d/`，但在测试脚本构建路径时（本就是 WSL 路径）逻辑未按预期工作。 |
| **调试输出** |部分成功| 确认了 `FILE_PATH` 和 `PROJECT_DIR` 的值，但在 `while` 循环内的匹配逻辑依然表现异常。 |

## 4. 建议解决方案（请求专家评审）

我们建议放弃当前的纯 Bash 实现，转向更稳健的方案：

### 方案 A：Python 重构（推荐）
将所有 Hook 脚本的核心逻辑重写为 Python 脚本。
- **优势**：
  - `pathlib` 库原生处理路径跨平台问题（`PureWindowsPath`, `Path`）。
  - `json` 库原生处理输入输出，无需依赖外部 `jq`。
  - 异常处理更清晰。
- **实施**：创建 `.claude/hooks/gate.py`，Hook 脚本仅作为 wrapper 调用它。

### 方案 B：严格的 WSL 路径强制
- 在脚本入口处强制调用 `wslpath`（如果可用）将所有输入路径转换为 Linux 格式。
- 放弃对 Windows Git Bash 的原生支持，明确声明 Runtime 为 WSL。

### 方案 C：简化逻辑（临时）
- 使用 `grep` 进行模糊匹配，而不是精确的字符串前缀匹配。
- 风险：可能导致误判（False Positive/Negative）。

## 5. 当前待解决问题
- 为什么在 Bash 中 `rel="src/server/test.ts"` 且 `p="src/server/"` 时，`[[ "$rel" == "$p"* ]]` 判断依然为 False？
- 如何建立一套跨平台的、不受宿主机环境干扰的测试套件？
