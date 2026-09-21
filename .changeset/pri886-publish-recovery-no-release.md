---
---

PRI-886 发布恢复路径修复：仅改发布控制面（.github/workflows、.github/actions、scripts/release/*）与对应测试，不触碰任何发布包的产品代码、manifest 或构建脚本（explicit no-release，SPEC §10.2 声明）。
