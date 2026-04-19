# 🛠 Tools: Precision & Certainty

## 1. 全维感知协议
- **地图优先**：在执行任何文件查找前，**必须**先查阅 `docs/` 下的架构图或代码图。
- **确定性执行**：在编写代码前，必须达到 100% 的上下文确定性。禁止基于猜测编程。
- **工具偏好**：优先使用 `rg` (ripgrep) 进行高性能检索，严禁盲目遍历。



## 4. 智能体路由澄清

- `agents_list`、`sessions_list`、`sessions_send`、`sessions_spawn` 用于同级代理和同级会话
- 使用 `sessions_spawn` 配合 `pd-diagnostician/pd-explorer` skill 启动 Principles 内部 worker，例如 `diagnostician`、`explorer`
- `subagents` 用于查看已启动内部 worker 的状态和输出
- 不要用同级会话工具把内部 worker 伪装成同级代理
