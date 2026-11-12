---
'create-principles-disciple': patch
---

修复 N-1 升级门禁的「上一版」基线推导：优先取 npm registry 上严格小于候选版本的最高已发布版本（plugin `4.0.0` → `3.3.0`），仅在 registry 不可达时退回算术步进，且退回值必须经 registry 校验真实存在，否则明确报错；`0.0.0` 仍按原语义失败。

影响：组件大版本跳变（`x.0.0`）不再让 release matrix 的 N-1 校验在 `previousReleaseVersion` 处抛错并连带跳过整列 publish。门禁强度不变：结果必须是严格 semver 且严格小于候选。
