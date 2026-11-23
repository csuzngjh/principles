---
"@principles/pd-cli": patch
---

fix: `runtime internalization run-once` 新增 `--only-candidates <ids>` 选项，把 wakeOnce 的探测与派发选择限定在指定候选链内（实验分片隔离）；同时修复 `--reps`/`--formation-depth` 预算参数的校验与 ab-grid 分片转发。PRI-1284。

风险对账（AGENTS.md §14，error:context EP-02/EP-04/EP-14 HIGH）：

- **EP-02（真实生产入口消费）**：`--only-candidates` 由真实命令树 `buildPdProgram()` → `runtime internalization run-once` 注册并消费，测试文件 `runtime-internalization-run-once.cli-wiring.test.ts` 驱动真实 Commander parse，probe 与 dispatch 两层 wakeOnce 均断言携带候选过滤谓词。
- **EP-04（CLI 边界）**：解析发生在 Commander 层而非仅 handler；`--reps`/`--formation-depth` 在 ab-run 与 ab-grid 两个入口均先做正整数校验再产生任何副作用（manifest、分片、记录），`--flag=value` 等号形式被规范化接受而非静默回退；恢复时预算不一致在写任何记录前拒绝。
- **EP-14（跨包发布边界）**：`piTaskBelongsToCandidates` 通过 admission 记录从 `@principles/core` runtime barrel 导出（expires 2027-05-23），消费方为 pd-cli `runtime-internalization-run-once.ts`；barrel 冻结快照与 export-surface baseline 已同步重录，pd-cli 侧测试经真实 specifier 解析。
