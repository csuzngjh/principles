#!/bin/sh
# Remediation round-2 progress snapshot (appended by main agent).
cat >> "D:/Code/principles-private/docs/reports/workbuddy-host-adapter-20261013-remediation/STATE.md" << 'EOF'

## 第二轮整改进行中（review 2026-10-13-remediation-independent-review）

HEAD 基线 a9b633ec91（两份 dirty packaged manifests 保留未动）。

| 发现 | 复验 | 处置 |
|---|---|---|
| P1 Console 读项目库 | 确认（installer:4194 autoLaunch(options.workspaceDir)；E2E 进程证据 PID 12588/55952） | 已修：resolveConsoleWorkspaceDir(host,...)——workbuddy → 治理目录，openclaw/codex 保持项目目录；autoLaunch+canary+manual-open 三处统一（installer.ts）；回归 console-workspace-routing.test.ts 2/2 绿（先红后绿）；installer dist 已重建 |
| §3 P2 flag 字段顺序 | 确认（固定 +1/+2 偏移在 category-first 顺序下产生重复 enabled） | 已修：整个 mapping 块内定位 enabled/category（任意顺序/注释/空行），只补缺失字段；重复键畸形配置拒绝且零修改。回归 4 新测试，32/32 绿 |
| §4 P2 BDD 断链 | 确认 | 子代理 e2e-bdd-fixes 处理中（feature/step 重绑定、trajectory.db、真实 LLM profile、真实 pd activation approve、区分 BLOCKED 与空队列） |
| §4 P2 原则正文读取 | 确认 | 子代理处理中（principleDraft.statement 生产合同） |
| §6 P2 前置失败 exit0 | 确认（pack FAIL → exit0 实测） | 子代理处理中（统一 finalize+退出码+脚本级回归） |
| §5 Write 失败无 post 事件 | **被反证**：审查者实测 PostToolUseFailure 触发（2009，文件未变）；我方原探针四事件插件未订阅 | 子代理 ptuf-8k3m2x 处理中（独立复验+生产订阅+归一化/准入验证） |
EOF
echo appended
