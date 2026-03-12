# 🛠️ Principles Disciple 高阶参数调优指南 (Geek Mode)

> 💡 **给 99% 用户的建议**：您完全不需要阅读本文档。插件在默认配置下已经能在“保护代码安全”和“高效执行”之间取得最佳平衡。请直接享受 AI 编程吧！

---

如果您是那 1% 想要精细控制 AI 行为的极客，或者您发现 AI 最近太“怂”了总是拒绝干活，又或者觉得 AI 胆子太大经常改坏代码，那么欢迎来到**引擎核心区**。

当您在一个目录下初始化了本插件后，系统会在该项目下生成一个隐藏配置文件：
📂 `.state/pain_settings.json`

修改这个文件，您可以直接改写 AI 的“性格”和“忍耐度”。

## 📖 核心参数字典（说人话版）

### 1. 痛点阈值 (`thresholds`)
决定了 AI 遇到多大的挫折才会开始“反思”和“求助”。

*   `pain_trigger` (默认: 30): **疼痛忍耐度**。当 AI 连续报错积攒的分数超过这个值，就会触发强制反思。调高它（比如 50），AI 就会变得更头铁，拼命尝试修复；调低它（比如 20），AI 一遇到困难就会停下来思考。
*   `stuck_loops_trigger` (默认: 3): **死循环探测器**。如果 AI 连续修改同一个文件 3 次依然报错，系统判定它“卡死了”，会强制干预。

### 2. 挫折评分 (`scores`)
这些参数决定了 AI 犯错时“挨打”的力度。分数扣得越狠，AI 越容易进入“只读/保护模式”。

*   `exit_code_penalty` (默认: 70): **报错惩罚**。只要跑代码报错了，瞬间增加这么多疼痛值。
*   `tool_failure_friction` (默认: 30): **工具使用失败惩罚**。比如试图读取一个不存在的文件。
*   `subagent_error_penalty` (默认: 80): **子系统崩溃惩罚**。这是非常严重的事故，分数很高。

### 3. 时间与频率 (`intervals`)
*   `worker_poll_ms` (默认: 900000 即 15分钟): **后台进化巡检间隔**。系统多久在后台扫描一次报错记录并总结出新规则。一般不需要改。
*   `task_timeout_ms` (默认: 1800000 即 30分钟): **任务超时极限**。

### 4. 信任与权限体系 (`trust`)
这是系统的绝对核心。AI 初始有个“信任分”，干得好加分，瞎搞破坏减分。分数对应 4 个阶级（Observer -> Editor -> Developer -> Architect）。阶级越低，AI 受到的限制越多（比如不准写超过 10 行的代码）。

*   **`stages` (阶级门槛)**:
    *   `stage_1_observer` (默认: 30): 低于 30 分，AI 沦为纯“只读”模式，只能帮你查 Bug，不能改代码。
    *   `stage_2_editor` (默认: 60): 能改小段代码，不能碰核心区。
    *   `stage_3_developer` (默认: 80): 可以修改核心代码，但必须先写 `PLAN.md` 计划书。
*   **`penalties` (扣分项)**:
    *   `tool_failure_base` (默认: -8): 报错一次扣 8 分。
    *   `risky_failure_base` (默认: -15): 在核心保护区报错，罪加一等，扣 15 分。
*   **`rewards` (加分项)**:
    *   `success_base` (默认: 1): 成功干完一个小任务，加 1 分。
    *   `streak_bonus` (默认: 5): 连续 5 次成功（连杀奖励），额外加 5 分。

### 5. 元认知深度反思 (`deep_reflection`)
*   `enabled`: 是否允许 AI 停下来深思熟虑。
*   `auto_trigger_conditions.error_rate_threshold` (默认: 0.3): 当近期操作的错误率超过 30% 时，强制让 AI 停下手头的活，调用 `deep_reflect` 工具分析自己是不是大方向搞错了。

---

### ⚠️ 高风险操作警告！

如果您把 `penalties` 里的扣分调得极低（比如改成 -1），或者把初始信任分调得极高（100分），**防爆拦截系统实际上就失效了**。AI 将变成一个彻头彻尾的“莽夫”，这在操作大型复杂项目时极易引发灾难性的代码破坏。

**修改建议**：推荐通过界面的 `auditLevel`（防爆拦截级别）来宏观调节，而不是直接魔改这些微观数值。

---

## ⚙️ 工作区目录配置

系统通过以下方式确定工作区目录：

### 配置文件（推荐）

创建 `~/.openclaw/principles-disciple.json`：

```json
{
  "workspace": "/home/user/my-workspace",
  "state": "/home/user/my-workspace/.state",
  "debug": false
}
```

### 环境变量

| 变量名 | 描述 | 示例 |
|--------|------|------|
| `PD_WORKSPACE_DIR` | 自定义工作区目录 | `/home/user/workspace` |
| `PD_STATE_DIR` | 自定义状态目录 | `/home/user/workspace/.state` |
| `DEBUG` | 启用调试日志 | `true` |

### 优先级

1. 环境变量 > 配置文件 > 默认值

### 调试日志

开启 `DEBUG=true` 后，日志会显示：

```
[PD:PathResolver] Using workspace from config file: /home/user/workspace
[PD:WorkspaceContext] Normalized workspaceDir: /home/user/clawd/memory -> /home/user/clawd
[PD:TrustEngine] Scorecard not found, creating initial scorecard
```