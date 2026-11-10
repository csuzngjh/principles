---
"@principles/core": patch
---

fix(principles-core): PRI-675 dreamer 不再以模型自证的 `valid` 作为准入条件

`dreamer-output.valid` 是模型自己声明的"本次输出有效"，没有任何下游消费者，却被 `DefaultDreamerValidator` 当成唯一准入条件：模型把每个必填字段都填对、只因为写了 `"valid": false` 就整单判死，而 dreamer 没有 `priorValidatorErrors` 回喂，三次重试是盲重试。`DreamerRunner.postFetchTransform` 现在把该断言当作不可信回声归一化为运行时真相（与 `taskId`/`sourcePainId` 同族），并发出 `dreamer_self_attested_valid_overridden` 保留原始断言值；validator 移除该语义门禁，schema 层仍要求字段为 boolean，内容校验强度不变。`diag-rootcause-output` 的同名门禁不动——那里的 `valid` 有真实下游消费者（`pain-signal-bridge`）。
