---
"@principles/pd-console": minor
---

Examiner 验证页按 Owner 视角重排（2026-11-11 UI/UX 审计 F-28 落地）：首屏改为"结论卡"（生效状态 + 效果结论一句话 + 主操作按钮，"已生效"要求本原则存在激活行而非仅全局读取健康），原则列表以原则文本为主键（不再是裸 UUID），实验列表显示日期/只读标记/初步结论标签（元数据读取失败时显示"数据异常"而非伪装成"未生成报告"）；三段式引导卡收敛为单行"这是什么"。门禁与生产证据面板移入默认折叠的"技术详情"区，主页面与共享面板的原始枚举（ok/degraded/BLOCKED/submitted/agent_claimed 等）经 enum-labels 新类别映射为中文（Study/Configure 子页残留枚举留 follow-up），服务器降级原因以 reasonCode 结构化下发（activation/injection/audit 车道补码，receipts 复用既有 coverage 码），`/overview` 的 gates 由英文长句改为 `{id,state}` 机器码、executionScope 改为 `executionScopeCode`、studies 由目录名数组升级为带元数据（目标原则/模式/创建时间/报告状态/点估计/读取问题码）的摘要列表，结论方向推导收敛到共享纯函数 `examiner-conclusion`（报告页同源复用）。已知破坏性 API 变更（控制台服务端与 UI 同包同发）：`GET /api/examiner/overview` 响应字段如上；evidence 响应删除静态英文 `principle.ledgerStatusNote` 字段。修复窄屏卡片叠压：证据网格补 `min-w-0` 与逐格断行。
