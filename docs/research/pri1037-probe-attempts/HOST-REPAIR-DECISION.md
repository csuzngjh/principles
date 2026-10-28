# PRI-1037 探针阻塞报告：OpenClaw 宿主卡死于半更新状态（S8，2026-10-28）

## 结论

**BLOCKED_ON_OWNER_DECISION** — 唯一待决事项：是否批准对共享宿主执行 `openclaw update repair` + `openclaw doctor --fix`（OpenClaw 官方修复路径）。

## 证据链

1. **attempt-4（授权周期 1，5 轮×600s caps，窗口 15:10Z–21:10Z）**：round-1 即触发停止条件（fail-fast 生效，rounds 2–5 未执行）。transport 失败原因：exec 的全部插件加载抛 `FsSafeError: copy path changed during operation`（codex/deepseek/feishu/perplexity/principles-disciple/tavily/zai 全部命中），exec 以 `status=error, kind=exception` 退出——**模型调用未发生**。证据：`attempt-4-PRI-1037.json`。
2. **故障非瞬时**：三次独立执行（attempt-4 round-1、两次诊断复现，间隔约 30 分钟）同错；诊断复现取得完整 envelope（sessionId 有值、model/provider 为 null——模型调用前即失败）。
3. **`openclaw update status` / `openclaw doctor` 实测**：安装处于卡死的半更新状态——codex/deepseek/feishu/perplexity/principles-disciple/tavily/zai 七个插件的 data/settings upgrade 均未完成（"Package convergence must wait until the updating parent releases its install records"）；一条 abandoned update 事务待修；官方修复路径 = `openclaw update repair` 然后 `openclaw doctor --fix`；另有待装更新 **2026.10.5 → 2026.10.8**。
4. **影响面**：该状态下任何 `openclaw agent exec` 都无法到达模型调用——探针、以及宿主上的其他 OpenClaw 智能体，全部同样受阻。

## 为什么这是 Owner 决策（自主执行规则的停止条件）

1. **宿主安装修复 = 共享宿主变更**：`openclaw update repair` 会改写安装记录/插件目录；本机有多个 Agent 并行工作（本仓库 29 个 worktree、其他 Agent 活跃），修复与并发 OpenClaw 使用存在相互干扰风险。
2. **版本变更超出授权目标**：修复大概率连带安装待装更新 2026.10.5→2026.10.8。Owner 指令明确授权目标为 **OpenClaw 2026.10.5**；版本变更后适配器契约（`--config`/exec 选项面/轨迹 schema）需对新版本重新核验，探针授权目标也随之改变——等同更换授权目标环境。
3. **备选路径不成立**：用剥离插件的精简 pin 配置绕过插件加载 = 改变被测环境（PD 插件属于目标被测环境，S7 §三 已明令禁止）；`--isolated` 不读任何配置 = zai provider 消失（S5.2.1 实据）。

## 授权与证据状态（全部保留）

- 授权周期 1（本轮）：**REVOKED**（15:40Z，撤销原因记录停止条件与证据位置）。
- 授权周期 0（S6）：REVOKED（11:20Z）保留。
- attempt-1..4 记录 + CALL-COUNT-RECONCILIATION.md：全部入库，原件未动。
- 三个 S6 workRoot + 本轮 workRoot（`.tmp/pri1037-probe-1793200288139`）未清理供检验。
- 十套件 184/184 绿（main=cca1d47a2）；三研究 freeze --verify OK；真实模型请求 **0**。

## Owner 批准后的执行序列（机械就绪）

1. Owner 批准并执行 `openclaw update repair` → `openclaw doctor --fix`（或 Owner 自行修复后指示继续）。
2. 若宿主版本变为 2026.10.8：先对新版本跑一遍 adapter 契约核验（exec --help 选项面 + 一次 dry-run）。
3. 签发全新授权（APPROVED，5 轮 × 600s，6h 窗）→ `run-isolation-probe.mjs --study CEB-001 --openclaw-bin <node+openclaw.mjs>` → `verifyF2ProbeEvidence` 深验 → 归档。
4. 深验通过 → F2 独立授权 → 真实实验 → 裁定 → PRI-1024 终局收口。
