---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"@principles/pd-cli": patch
"create-principles-disciple": patch
---

chore(deps): bump js-yaml 5.4.1 -> 5.4.3（#2011）。js-yaml 是 core / host-runtime / plugin / pd-cli / console 的运行时 dependency，console 随 installer 分发，故这 4 个可发布包与 installer 各声明 patch。
