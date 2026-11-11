---
---

E2E 测试隔离：`rulecode-owner-live-decision.spec.ts` 声明 `test.describe.configure({ retries: 0 })`。

该 journey 执行不可逆的 break-glass 操作（暂停全部 Live RuleCode、紧急停用），而 E2E 运行对同一 workspace 只 seed 一次，no-auth 服务又无法释放 pause（403 `owner_authentication_required`）。因此 CI retry 必然复用被首跑改坏的状态，并在 `Seeded RuleCode owner decision is missing` 处失败，掩盖真实的首跑错误。

本 PR 只收紧重试语义：不改变产品行为，不放宽任何断言，首跑失败直接可见。可安全重试所需的 per-attempt workspace 重置见 PRI-1190。

无发布意图：仅测试代码变更。
