---
"@principles/core": major
"principles-disciple": minor
---

Principle Context Batch 1（PRI-1269，Owner 2026-11-17 授权）：CURRENT_FOCUS 由 Agent 工作记忆文件转型为 Owner 手动维护的 Principle Context 来源文件（只读）。退役 prompt 路径的自动恢复/自动压缩/历史版本注入/工作记忆注入与 compaction 工作记忆写入；`/pd-focus compress` 退役，`status` 改为文件事实（存在性/大小/行数/更新时间），`rollback` 改为原始字节恢复（先备份当前原始字节，不改写换行/BOM、不追加版本或状态文本）；`/pd-init` 改为访谈并输出三节草案（不写文件）；普通 OpenClaw Prompt 启动不再创建 CURRENT_FOCUS.md（模板移除）；`projectFocus` 旧配置保留加载兼容但不再产生任何读取或注入行为（标记 deprecated）。

**Breaking（@principles/core）**：`@principles/core` 根导出与 `@principles/core/prompt-builder` 子路径移除已退役的工作记忆/压缩符号（`compressFocusContent`、`parseWorkingMemorySection`、`workingMemoryToInjection`、`mergeWorkingMemory`、`extractSummary`、`extractMilestones`、`validateCurrentFocus`、`cleanupStaleInfoPure`、`DEFAULT_FOCUS_COMPRESSION_OPTIONS`、`extractDescription`、`extractProblems`、`extractNextActions`、`deduplicateArtifacts` 及类型 `FileArtifact` / `WorkingMemorySnapshot` / `FocusCompressionOptions` / `FocusCompressionResult`）；仅保留 `extractVersion` / `extractDate` 两个展示辅助函数。这些符号随其唯一生产消费者（openclaw-plugin focus 链路）一并退役，无内部调用者残留。
