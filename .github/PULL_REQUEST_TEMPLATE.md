## 🧬 PR 描述

### 变更内容
<!-- 简要描述这个 PR 做了什么 -->

### 变更类型
- [ ] 🐛 Bug 修复
- [ ] ✨ 新功能
- [ ] 📝 文档更新
- [ ] 🔧 重构/优化
- [ ] 🧪 测试

### 测试情况
- [ ] 所有现有测试通过 (`npm test`)
- [ ] 新增测试覆盖新功能
- [ ] 测试覆盖率 > 60%

### 检查清单
- [ ] 代码符合项目风格
- [ ] 文档已更新
- [ ] 无破坏性变更（或已标记为 breaking change）
- [ ] 通过 Thinking OS 检查（T-01/T-04/T-05）
- [ ] 迁移删除检查：如果删除了源文件，确认 barrel (`index.ts`) 和 compile test (`exports-compile.ts`) 已同步清理
- [ ] Core 边界检查：本 PR 是否在 `packages/principles-core/src/` 新增了 `fs`/`path` 导入？如果是，是否更新了 `architecture-regression.test.ts` 的白名单和 `eslint.config.js` 的豁免列表？

### ERR Checklist（必填）
<!-- 列出本 PR 考虑过的 ERR 条目（最少 3 个），及如何避免复发。参考 docs/ERROR_PATTERN_INDEX.md -->
<!-- 示例：ERR-001 (parsed JSON as any) — 本 PR 使用 typeof 类型守卫，未使用 as 绕过 -->

- ERR-___:
- ERR-___:
- ERR-___:

### Runtime Contract 自检（必填）
<!-- 本 PR 是否处理不可信数据（parsed JSON / LLM output / DB diagnosticJson / artifact metadata）？ -->
<!-- 若是，列出适用的 Rule 1-9 及遵守方式；若否，填写 "N/A — 本 PR 不处理不可信数据" -->

- [ ] 本 PR 处理不可信数据
- 适用 Rule 及遵守方式：

### CLI Gate 自检（条件性 — 仅当修改 `packages/pd-cli/src/commands/**` 时填写）
<!-- 若本 PR 修改了 CLI 命令，请逐条确认 7 条 CLI Gate 规则 -->
<!-- 1. JSON mode 严格输出  2. exit 后立即 return  3. --no-* flag 有 parser 测试 -->
<!-- 4. dry-run/confirm 语义  5. 失败路径不 mutate state  6. 降级输出含 nextAction  7. 测试真实 command wiring -->

- [ ] N/A — 本 PR 未修改 CLI 命令
- 或填写 7 条规则遵守情况：

### Feature Flag 注册检查（条件性 — 仅当引入新功能子系统/hook/writer/reader 时填写）
<!-- 若本 PR 引入新的功能子系统、hook、writer 或 reader，需在 .pd/feature-flags.yaml 注册 -->
<!-- 参考 AGENTS.md "Feature Flag Registration" 章节 -->

- [ ] N/A — 本 PR 未引入新功能子系统
- 或填写注册情况：

### 相关 Issue
<!-- 关闭的 issue：Closes #XX -->
