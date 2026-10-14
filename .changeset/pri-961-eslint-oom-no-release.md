---
---

fix(lint): PRI-961 全量 type-aware ESLint 改为逐包独立进程调度（新增 scripts/lint-by-package.mjs），默认堆限制下不再 OOM；lint / lint:fix 的规则、忽略与文件覆盖语义保持不变。变更仅涉及根级开发脚本，不随任何发布工件分发，故显式 no-release。
