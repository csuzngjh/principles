# PRI-1043 执行能力事实链审计与回归报告（2026-10-25）

## 结论

本轮只完成现有能力与事实链的精准回归，没有新增生产代码。当前实现已具备 `design_approval` 能力声明与实时事实分离，以及由系统验证所声明事实的路径；这部分由 PRI-1019/PRI-1041 落地。本轮结果支持继续按既定边界推进：身份/宿主前置属于 PRI-1042，native host 验证属于 PRI-1044；PRI-1043 不扩展为通用 registry，也不新增 required fact kind。

本次测试全绿不证明已安装、native host 启用或 live 生产行为。安装后 generation `35+22` 是另一层既有证据，不是本轮执行或模型生成结果。

## 执行基线与边界

- 回归代码仓库：`D:\Code\principles`
- 回归 HEAD：`28514160413e7e7bbeac2049703ea4acb86f8b7b`
- 每个包均从包目录运行 `node ../../node_modules/vitest/vitest.mjs run ...`，未 build、未 clean dist。
- 主 checkout 中原有 dirty/untracked 文件未改动；未写源码、配置、DB 或安装目录；未提交、未调用 Linear。
- 日志均写至既有目录 `D:\Code\principles\.tmp\pri-1015-rulecode-recovery-20261021\post-update-20261025\`。

## 回归结果

| 包 | 定向测试文件 | 通过 | 跳过 | 失败 | 日志 |
| --- | --- | ---: | ---: | ---: | --- |
| principles-core | 4 | 117 | 0 | 0 | `1043-core-tests.log` |
| host-runtime | 3 | 16 | 0 | 0 | `1043-host-runtime-tests.log` |
| codex-adapter | 2 | 8 | 0 | 0 | `1043-codex-adapter-tests.log` |
| **合计** | **9** | **141** | **0** | **0** | |

实际命令（相对路径基于各自包 cwd）：

```text
# packages/principles-core
node ../../node_modules/vitest/vitest.mjs run src/runtime-v2/internalization/__tests__/artificer-intent-preflight.test.ts src/runtime-v2/internalization/__tests__/rulecode-verification-obligations.test.ts src/runtime-v2/tools/__tests__/artificer-l2-tool-contract.test.ts src/runtime-v2/__tests__/evaluator-runner-vslice-v2.test.ts

# packages/host-runtime
node ../../node_modules/vitest/vitest.mjs run tests/production-rulehost-gate-v2-isolation.test.ts tests/production-design-gate-pretool.test.ts tests/codex-design-gate-facts.test.ts

# packages/codex-adapter
node ../../node_modules/vitest/vitest.mjs run tests/codex-rule-context-provider.test.ts tests/codex-rule-context-live-history.test.ts
```

## 事实链覆盖

- `design_approval` 的四种 resolution：`approved`、`not_approved`、`not_required`、`unknown`；包含最新 SQLite 声明、当前 SPEC bytes 与 scope 绑定，以及撤销、缺声明、目标 scope 未知和 SPEC digest 不匹配情形。
- 系统拥有的 verification declaration、required fact cases 与 malformed/duplicate 声明验证；required `unsupported` fact 独立阻断，不由模型提供零用例绕过。
- host capability 的支持/不支持声明；`unknown`、历史不可用、身份/范围不足时保留未知，不推断为已批准或否定事实。
- Codex `PreToolUse` 的生产接线测试覆盖 Owner 拒绝后阻断、批准后重读并放行，以及新 session 首个受管动作在权威 `not_approved` 时阻断。
- EvaluatorRunner 回归包含 PRI-1041 declared-fact verification through the real Runner and sandbox，并验证 Runner 到 sandbox 的 `gateDeps` 注入/执行边界。该测试仍在测试宿主中运行，不代表 native 安装或生产启用。
- `priorRead` 是 input/history 能力，历史不完整或工具语义未声明时保留 `unknown`；本轮未把它扩成新的 required fact kind。

## 复杂度与状态

```text
Complexity Delta
New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: NO
New runtime feature flag: NO
New cross-package dependency: NO
New host/platform-specific behavior: NO
New external/network capability: NO
```

无代码变更，因此无需代码回滚。原有安装状态及主 checkout 的 dirty/untracked 文件未动。native host/安装/live 验证留在 PRI-1044 范围；本报告不对这些状态作通过声明。
