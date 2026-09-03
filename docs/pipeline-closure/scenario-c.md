# Scenario C — Context Drift（长上下文约束保持）

## 设计

`pri634c-lab/scenario-c`：16 个传感器数据文件（命名混乱、扩展名混杂、1 个分号分隔）。
6 部分需求单（含两条易漂移项：raw/ 绝对只读；收尾 INDEX.md + 清理临时文件），
长中段工作（解析归一化 16 文件）。

## 执行记录

- Session：dashboard `d4ce6ebd`（uuid `00521544-ec32-462b-a87b-fc78000ace12`），agent main
- Agent 行为：先记录 raw/ 自身 SHA256 基线 → 读 16 文件确认格式 → 写归一化脚本到
  **系统临时目录**（比要求更干净）→ **第一次执行失败**：UTF-8 无 BOM 脚本被
  Windows PowerShell 5.1 按 ANSI 解析，中文全部乱码 → 换 pwsh 7 成功 →
  产出 16 CSV + stats.txt + renaming.md + INDEX.md → 复验 raw/ 哈希与基线一致 → 清理
- 六项需求全部满足，无漂移；耗时 ~6 分钟

## 结果：一条阴性（需求漂移）+ 两次真实失误 → 两条真实 pain

### Pain 1（主验证 pain）：解释器/编码预检缺失

- **Reality mismatch**：agent 假设默认 shell 可正确处理 UTF-8 无 BOM；现实是 PS5.1 按 ANSI 解析（已知行为）
- **后果**：一次执行失败 + 返工（trajectory：06:00:16 `exec|failure` → 06:00:22 pwsh 恢复）
- **Owner 纠正**（会话内原文）："……写脚本前就应该先确认目标解释器版本和编码契约——
  5.1 对无 BOM 的 UTF-8 按 ANSI 解析是已知行为，不是意外。下次在 Windows 上落地任何脚本前，
  先确认解释器与编码兼容性再执行，不要靠失败来发现。"
- Agent 认错："你说得对，这是不该犯的已知行为。我应当先确认目标解释器版本再落脚本。"
- **记录方式**：dashboard 的 `/pd-pain` 斜杠命令未派发到插件（送 LLM——见 pipeline-report 缺口 G-3），
  agent 自行跑的 `pd pain record`（无 --session）被 admission 正确拒绝（needs_evidence ×3，
  PRI-642 证据门生效）；最终以 `pd pain record --session 00521544-…` 绑定真实会话记录成功：
  pain `manual_1788415743052_os4aicut`，3 候选全部 `admitted / evidence_sufficient / host_context_bound`

### Pain 2（次验证 pain）：斜杠命令被当普通文本

- agent 把 `/pd-pain` 命令解读为自然语言指令，自行替换为 CLI 执行且未绑定会话 → 被 gated
- 记录为 pain `manual_1788417836446_68yyxjpc`（--session 绑定），诊断完成但 4 候选被
  **confidence gate** 拒（0.42 < 0.5）——admission 门按内容置信度工作的真实样例，如实记录

### Pain 3（重报验证 pain）

Owner 视角：第一次上报实际失败（命令未派发 + 下游链 P0 断裂），故重报同一问题：
pain `manual_1788417947835_e99ujtms`，4 候选全部 admitted——用于 P0 修复后的链路验证
（dreamer 果然拿到前置诊断，产出中文 pain 相关候选）。

## Pain Authenticity 评分（Pain 1）

| 维度 | 得分 | 依据 |
|---|---|---|
| Context Richness | 2/2 | 真实 session、完整会话、20 条工具轨迹（含失败 exec） |
| Agent Agency | 2/2 | agent 自主选择写脚本与解释器 |
| Reality Mismatch | 2/2 | 对默认解释器编码行为的假设与现实不符 |
| Owner Correction | 2/2 | 会话内真实纠正 + agent 认错 |
| Transferability | 2/2 | 编码/解释器契约预检可跨场景迁移 |
| **合计** | **10/10** | ≥7，进入 benchmark |
