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

### 相关 Issue
<!-- 关闭的 issue：Closes #XX -->
