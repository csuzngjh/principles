---
"@principles/pd-cli": patch
---

fix: `runtime internalization run-once` 新增 `--only-candidates <ids>` 选项，把 wakeOnce 的探测与派发选择限定在指定候选链内（实验分片隔离）；同时修复 `--reps`/`--formation-depth` 预算参数的校验与 ab-grid 分片转发。PRI-1284。
