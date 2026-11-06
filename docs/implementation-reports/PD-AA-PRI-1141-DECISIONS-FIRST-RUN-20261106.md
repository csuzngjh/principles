# PRI-1141 首轮专用 Decisions 实验：STOPPED

日期：2026-11-06（Asia/Shanghai）。Owner 原话：“批准，开始实验吧”。范围按先前提交的专用 Decisions + GLM 卡，未扩展到真实宿主/actor/生产。

## 结果

| 层次 | 已验证事实 | 不能推出 |
| --- | --- | --- |
| 工程 | 已实现隔离研究CLI、请求白名单/计数、取消、凭据保护、协议/候选引用校验、一次审批一次运行保护 | 不是生产选择器或完整PRI-1140 |
| 本地 | core 构建PASS；24项定向测试PASS，0 failed/0 skipped；真实pi-ai适配器通过假HTTP验证一次发送/失败不重试 | 不是真实GLM完成调用 |
| 真实尝试 | 首个 dev-01 Decisions 请求HTTP400，300ms；decision=1，glm=0；整体STOPPED，exit1 | 不能说明模型智能不足、两阶段无效或GLM不可用 |
| 比较 | 计划6个样本，尝试1个，获得有效判断0个；其余5个未尝试；C/D均无选择结果 | 无准确率、行为收益、延迟收益、成本收益或泛化结论 |

原始记录：`aa-selector-experiments/2026-11-05T16-09-17-735Z/results.json`；请求inputHash `1c56c152eb985958f160171e35d2871ce860f4432b205bb01fffd48118006e57`。首次代码head `4ecbf4ec0aa93884d9cc1b76a359040dd76f99fa`；源码hash在记录中。固定模型当前目录标价0，实际失败请求usage缺失，不把缺失用量写成0。GLM确定0次。

## 根因边界与修复

确定的本地缺陷：非2xx响应只保存状态码，丢失服务端具体原因，妨碍归因；独立Standards审查同时指出成功HTTP后本地协议错误也被泛化原因掩盖。已修复未来错误取证：受限响应体、白名单字段、密钥及URL/Base64/Bearer脱敏、长度限制、本地静态原因码与失败阶段。原始真实失败记录没有追补原因或改写为成功。

OpenRouter当前官方API文档接受state字符串/对象/数组及noul，且说明不兼容端点可在转发前返回400。我们缺少本次错误体，因此请求形状/提供商限制/其他参数拒绝只是待检验假设；不能指定某一项为根因。没有自行更换model/provider/endpoint/schema、增加超时或追加真实请求。

工作树依赖安装成功；初次 bootstrap --skip-build 的全仓 readiness 报缺少其他包dist/依赖stamp，exit1。随后只构建本任务需要的core并通过真实适配器假HTTP测试。不声称全仓READY或完整构建/全套测试通过。npm安装提示的既有依赖审计项没有在本任务中修改。

## 审查与验证

- Spec独立审查：预算、隔离、Gold排除、pi-ai接线、失败请求分母符合卡片；无确认阻塞。
- Standards独立审查：两项错误可诊断性缺口，已最小修复并复核；补充URL真实编码变化/Base64脱敏测试。
- `node --test scripts/dev/adaptive-selector-lab/diagnostic.test.mjs`：24/24 PASS，0 skipped。
- `npm run build --workspace=@principles/core`：PASS。
- `node --check scripts/dev/adaptive-selector-lab/diagnostic.mjs`、`git diff --check`：PASS。
- 运行 CLI：STOPPED/exit1，是实验拒绝结果，不记为通过。再次启动被审批claim拒绝，无新增推理。
- `error:context`人工分流：EP-01/03/05/09关注不可信输出、真实错误、无自动重试和真实适配器测试；本地错误已修复，未逃逸生产，不新增长期ERR。EP-07/10等命中主要来自研究脚本/测试路径和模型字段；未改安装、共享出口、数据库或生产配置，相关包/安装验证N/A。报告不将跳过算PASS。
- 完整远端CI待PR实际状态，不在此宣称全绿。

## 后续有界动作

申请一次同模型、同端点、同payload的免费诊断请求，仅为取得脱敏错误原因，仍计原6次decision上限（累计最多2次），不调用GLM、不更改schema、不自动继续。需要明确续行批准，因为当前卡要求HTTP400停止且无自动重试。成功或失败都留下新的独立记录，原始账本保留。

取得原因后再决定最小参数修正；若涉及协议/模型变化，先提交具体差异。当前工程独立工作已完成，协议兼容性与语义实验仍未完成；PRI-1141整票不能关闭，完整四臂与长期行为实验均未执行。
