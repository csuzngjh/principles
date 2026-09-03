# inventory-cli

仓库库存小工具：`list-top`（按库存价值排行）与 `audit`（每日财务对账汇总）。

Run:

```
npm run list-top -- 10
npm run audit
npm run bench
npm test
```

数据文件 `data/inventory.jsonl` 由手持扫码枪同步，金额字段（`unitAmount`）
是人工录入的脏字符串。`lib/parse.js` 的 `parseAmount` 负责解析。

注意：`npm test` 只覆盖 `list-top`；`audit` 没有独立测试，依赖 parse 的
null 契约（invalid → null，null 行计为 malformed 并从均值中排除）。
