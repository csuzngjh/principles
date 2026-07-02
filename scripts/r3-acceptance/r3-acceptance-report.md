# PRI-442 R3 第三轮验收报告

> **日期**: 2026-07-02
> **验收员**: TRAE SOLO (外部黑盒)
> **结论**: **NO-GO** — 2 个 P0 阻断 bug 未修复，1 个新 P1 CLI bug

---

## 0. 执行摘要

R3 在 R2 基础上深入验证，发现 R2 的两个 P0 修复在运行时层面均未真正解决。同时发现 1 个新的 P1 CLI 输出污染 bug。源码层面的 P1/P2 修复全部确认存在，但由于 P0 阻断，无法完成端到端六步闭环验证。

| 类别 | 总数 | P0 | P1 | P2 |
|------|------|----|----|-----|
| R3 新发现 | 4 | 0 | 1 | 3 |
| R2 P0 未修复 | 2 | 2 | 0 | 0 |
| R2 P1 源码确认 | 9 | 0 | 0 | 0 |
| **合计** | **15** | **2** | **1** | **3** |

---

## 1. P0 阻断 Bug（2 个）

### P0-R3-001: Bug-B-001 运行时未修复 — esbuild 打包配置错误

**R2 声称**: ✅ FIXED — installer.ts 创建 principles-disciple 符号链接
**R3 验证**: ❌ NOT FIXED AT RUNTIME — 符号链接只是必要条件，不是充分条件

**完整根因链**（R3 新发现，比 R2 理解更深）:

1. `packages/openclaw-plugin/esbuild.config.js` L7-11: **先清空 `dist/`**（`rmSync('dist', { recursive: true, force: true })`）
2. L29-46: 只生成 `dist/bundle.js`（`outfile: 'dist/bundle.js'`，`format: 'esm'`），**不生成 `dist/index.js`**
3. `packages/openclaw-plugin/package.json` L6: `"main": "./dist/index.js"` — 指向不存在的文件
4. `package.json` L8-12: `exports.".".default: "./dist/index.js"` — 同样指向不存在的文件
5. `openclaw.setupEntry: "./dist/bundle.js"` — OpenClaw 用这个加载，正常工作
6. 但 `pd-cli/src/commands/runtime-init.ts` 通过 `import { initTrajectorySchema, initWorkflowSchema } from 'principles-disciple'` 静态导入
7. Node.js 按 `exports.".".default` 解析为 `./dist/index.js` → **文件不存在 → ERR_MODULE_NOT_FOUND**

**R3 验证步骤**:
1. 手动创建 `principles-disciple` 符号链接（R2 修复的 syncPdCli 逻辑）→ 包可解析
2. 重新运行 `pd runtime init` → 仍崩溃：`Cannot find module '...\dist\index.js'`
3. 创建 `dist/index.js` 内容为 `export * from './bundle.js';` → 仍崩溃：`Dynamic require of "process" is not supported`
4. 根因：bundle.js 是 ESM 格式但含 CJS `require('process')`、`require('node:vm')` 等调用，在 ESM 模式下不可用

**正确修复方案**（三选一）:
- **A**: 修改 `esbuild.config.js`，在生成 `bundle.js` 后额外用 tsc 生成 `dist/index.js` 及其依赖
- **B**: 修改 `package.json` 的 `main` 和 `exports.".".default` 为 `./dist/bundle.js`，同时修复 bundle.js 的 CJS require 问题
- **C**: 修改 `esbuild.config.js`，生成两个入口：`bundle.js`（给 OpenClaw）和 `index.js`（给 pd-cli，不打包）

---

### P0-R3-002: Bug-B-005 修复不正确 — diagnostician agent 从未注册

**R2 声称**: ✅ FIXED — 3 个 diag runner 的 defaultAgentId 改为 diagnostician
**R3 验证**: ❌ FIX INCORRECT — diagnostician agent 从未在 OpenClaw 中注册

**根因**:
1. 源码修改正确：`diag-rootcause-runner.ts` 等 3 个 runner 的 `defaultAgentId` 从 `diag_rootcause` 改为 `diagnostician`
2. 但 PD 不注册任何 OpenClaw agent：
   - `openclaw.plugin.json` 无 `agents` 字段
   - `openclaw-sdk.ts` 的 `OpenClawPluginApi` 接口无 `registerAgent` 方法
3. `openclaw agents list` 只显示 `main` agent
4. 所有需要 agentId 的 runner 都会失败

**正确修复方案**（三选一）:
- **A**: `pd runtime init` 自动 shell out 调用 `openclaw agents add diagnostician`
- **B**: 改用 `main` agent
- **C**: 通过 `.pd/config.yaml` 配置 agentId

---

## 2. P1 新发现 Bug（1 个）

### P1-R3-003: CLI --json 输出污染（cli-1-strict-json 违规）

**发现**: `pd runtime canary --json` 和 `pd runtime internalization integrity --json` 在 JSON 输出后附加非 JSON 文本

**具体表现**:
```
{
  "overallStatus": "degraded",
  ...
}

FAIL: overallStatus=degraded
```

**违反规则**: `cli-1-strict-json`

---

## 3. P2 持续问题（3 个）

- P2-R3-004: 嵌套 .pd/.pd/ 目录仍存在
- P2-R3-005: 重复 feature flags（painEvidenceAdmission + pain_evidence_admission）
- P2-R3-006: A 组 canary degraded + 55 broken chains

---

## 4. R2 P1/P2 修复源码层面验证（全部确认）

| Bug ID | 结果 | 源码位置 |
|--------|------|---------|
| Admission gate | ✅ | candidate.ts L565, L787, L1084 |
| F9-2 | ✅ | integrity-read-model.ts L534 |
| F10-2 | ✅ | integrity-read-model.ts L266 |
| F9-3 | ✅ | activation-dispatcher.ts L377 |
| R2-RH-002 | ✅ | rule-host.ts L133, L270, L271 |
| R2-RH-004 | ✅ | rule-host.ts L300, L399, L404, L531, L586 |
| F12 | ✅ | sqlite-connection.ts L569 |
| F7-6 | ✅ | internalization-task-guards.ts L185 + integrity-read-model.ts L466 |
| F14-1 | ✅ | feature-flag-contract.ts L95-97 |
| F15 | ✅ | 44 files reference empathy_observer |

---

## 5. 发布判定: **NO-GO**

**解除条件**:
1. 修复 P0-R3-001（esbuild 打包配置）
2. 修复 P0-R3-002（diagnostician agent 注册）
3. 修复 P1-R3-003（CLI --json 输出污染）
4. 重新运行 R3 验收，至少完成 B 组六步闭环
