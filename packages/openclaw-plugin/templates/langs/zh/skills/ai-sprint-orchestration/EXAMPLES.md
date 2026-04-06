# AI 冲刺编排示例

## 示例 1：baseline + validation

```powershell
node scripts/run.mjs --self-check
node scripts/run.mjs --help
node scripts/run.mjs --task workflow-validation-minimal
node scripts/run.mjs --task workflow-validation-minimal-verify
```

## 示例 2：自定义 runtime 根目录

```powershell
node scripts/run.mjs --task workflow-validation-minimal --runtime-root D:/Temp/ai-sprint-runtime
```

## 示例 3：失败分类

- `workflow bug`：package-local script 仍然写回 repo-root `ops/ai-sprints`
- `agent behavior issue`：reviewer 漏掉 `VERDICT`，或 `DIMENSIONS` 格式错误
- `environment issue`：`acpx` 缺失，或 workspace 不可写
- `sample-spec issue`：validation spec 要求的字段，当前 sample / product 还没有实现

## 示例 4：何时停止

如果问题属于以下情况，完成分类后立刻停止本轮：

- the issue belongs to `packages/openclaw-plugin`
- the issue depends on `D:/Code/openclaw`
- the fix would require dashboard/stageGraph/self-optimization sprint expansion
- the problem is a sample-side or product-side gap rather than workflow plumbing

## 示例 5：从复杂 bugfix 模板开始

1. Copy `references/specs/bugfix-complex-template.json`
2. Replace every placeholder in `taskContract`
3. Narrow `executionScope` to the smallest useful round
4. Run the packaged entrypoint with the edited spec:

```powershell
node scripts/run.mjs --task custom-bugfix --task-spec D:/path/to/your-bugfix-spec.json
```

## 示例 6：从复杂 feature 模板开始

1. Copy `references/specs/feature-complex-template.json`
2. Fill `Goal`, `In scope`, `Out of scope`, `Validation commands`, and `Expected artifacts`
3. Confirm the spec does not require product-side closure outside this milestone
4. Run:

```powershell
node scripts/run.mjs --task custom-feature --task-spec D:/path/to/your-feature-spec.json
```

## 示例 7：continuation 前先看 checkpoint summary

当一轮以 `revise` 结束时，优先检查：

- `stages/<stage>/checkpoint-summary.md`
- `stages/<stage>/handoff.json`

下一轮应该把 checkpoint summary 当作主 carry-forward，上下文不够时才回退到完整 decision 文本。
