# PRI-1122 OpenRouter 专用 Decisions + GLM-5.3-Flash 最小实验补充方案

日期：2026-11-05。Owner 指定使用 OpenRouter decisions 分类中的免费决策模型，通用推理使用 ZAI glm-5.3-flash，可参考书生 Discovery / AMD TokenFactory。该消息明确了模型来源与实验意向；本补充列出与先前普通生成模型方案不同的具体协议，待确认后编码/执行。

## 1. 本轮确认与纠错

上一轮“决策模型只是角色、可用普通小模型承担”的解释不完整：用户明确指的是专门输出 decision 概率的模型类型。它不是普通聊天模型的 JSON 模式。先前 Groq/Qwen 方案降为历史替代，不继续作为当前主选。

公开目录 `GET https://openrouter.ai/api/v1/models?output_modalities=decisions` 本轮返回35个条目。其中 prompt/completion 均为0的条目为 `respan/span-01-lite` 和 `respan/span-01-lite:free`，属于同一模型家族的两条路由，不声称两个独立免费模型。选择显式免费 ID `respan/span-01-lite:free`，不启用付费 fallback、不用 openrouter/free 随机挑聊天模型。模型别名可变，保存调用实际返回 model 与当时 provider 版本信息（若无则 unknown）。公开 context_length=0 是未知元数据，不能解释为无限或不可输入。

该模型是行为存在概率评分器：把自然语言描述的条件映射为概率。是否能胜任任务/目标/阶段变化检测需要实验；模型厂商的通用 benchmark 不能证明 PD 任务适用性。公开页面延迟不是本机实测。

只读鉴权/目录核实：OPENROUTER_API_KEY 可访问账户元数据；ZAI coding 地址的 models 返回 glm-5.3-flash；AMD 目录返回 GLM-5.3-Flash。本地已具备这些凭据引用，未输出或复制密钥。模型目录存在不代表推理成功、订阅允许此用途、剩余额度足够或零费用。

## 2. 调用链与输入输出

隔离、合成、无宿主写入的研究 CLI（非生产 hook）：

冻结合成样本 → 事前上下文快照 → C 单次GLM，或 D Decisions概率 → 同一GLM选择 → 确定性校验 → 证据文件。

阶段一：`POST https://openrouter.ai/api/alpha/decisions`。输入 state 包含 previousTask、currentInput、目标/阶段来源，绝不含密钥、真实私人会话或原则候选。questions 为固定条件评分：新任务、显式目标变化、阶段变化、信息不足；优先使用官方 noul（条件成立概率）协议。初次实验验证该模型实际支持的 question 类型与应答形状；不预设支持 choice、生成摘要、解释或输入片段引用。400/不支持即停止，不通过自动换模型或改schema继续消耗。

输出仅允许有限数值概率，范围[0,1]且全部问题齐全；保留各分数。分数不强制相加为1，不取 argmax 假装互斥分类。厂商概率不等于 PD 分布上已校准。首轮不设置生产门控阈值，不靠低分跳过阶段二。

阶段二：优先 ZAI 已配置 `https://open.bigmodel.cn/api/coding/paas/v4` 下 `glm-5.3-flash`。从环境/既有配置引用凭据，不落盘。输入为相同合成上下文和研究专用候选夹具；D 额外提供标为“不可信辅助测量”的阶段一分数，不能覆盖当前指令和授权事实。C/D 使用相同候选、同一模型和参数。输出 selected / none_applicable / uncertain；selected 仅含已给候选引用与摘要，不允许模型创造新原则。

这是离线合成候选研究，夹具只模拟授权有效性，不读写真实授权、不证明真实原则送达。实际宿主授权读取/重验仍由现有运行时负责；未来实现按原方案接线。

GLM 使用既有 pi-ai 完成路径；Decisions 不是 pi-ai 当前文本生成接口，现有代码未发现可直接使用的 Decisions 调用实现。仅研究入口增加薄协议客户端，优先复用现有安全HTTP传输；不新增通用模型后端、不改变生产 RuntimeKind/profile enum。若未来产品化需共享能力，另审最小接入设计，不假装零工程成本。

## 3. 有界执行卡（待批准）

- 目标：验证免费 Decisions 协议能否读中文任务变化、GLM能否完成原则选择，以及 D 相对 C 是否出现明显语义收益/损害。不是行为或长期泛化实验。
- 数据：6条公开可读的原创合成开发样本：任务延续、新任务、目标变化、实现转验收、缺前序上下文、引用中的伪任务切换。每条预先写允许判断/弃选、禁止错误及原则选择期待；本批不称 heldout/Gold。先冻结文件与hash，运行中不改题。
- 请求硬上限：OpenRouter 6次；ZAI GLM 12次（C/D各6）；合计18次，包含所有失败尝试。第一条兼容性请求计入这18次，不额外增加“预检回合”。失败不补跑；GET目录/账户元数据不算推理请求，另记操作。
- 输入上限：阶段一每次6000字符；阶段二每次12000字符（含提示、候选和分数），候选最多4条合成原则；超限拒绝发送，不静默截断。GLM每次输出max_tokens=512，12次最大6144输出token；实际token依服务端用量保存，字符不冒充token硬上限。
- 成本：决策模型 prompt/completion 当前标价0，固定该 ID 且禁付费回退。GLM消耗既有 ZAI 计划额度，未证实无费用；当前未确认价格、此API使用范围及余额，不填写虚构金额。执行批准需明确接受最多12次GLM请求和6144输出token的计划额度消耗，若需金额硬上限则先核实价格/服务端限额，未具备不能宣称本地token设置可硬控金额。
- 时长：每请求绝对截止30秒，顺序执行，总墙钟最多10分钟；额外请求/SDK重试/repair/输出策略降级均禁用。网络发送边界计数，失败算一次；每个边界输出前后计数可审阅。阶段一推理不是宿主实时延迟验收，不把本上限当产品SLO。
- 停止：鉴权、计费/订阅用途拒绝、429、协议不兼容、超预算、非白名单模型、敏感内容进入payload立即停止，不自动换端点、不购买额度、不延长预算。普通合法弃选/质量错误保留记录，可继续剩余既定样本。
- 无自动 fallback：ZAI为本轮固定来源。AMD是已核实备选，书生页面为可用来源线索；需要替换时记录新配置/模型、重新确认执行卡，不在同一对照臂中悄悄换供应商。
- 清理与回滚：仅写任务工作树研究文件和脱敏响应；关闭研究CLI即可。没有安装/启用、迁移、生产配置或治理写入，无需修改现有宿主。

## 4. 验收与证据

执行前：fake HTTP下证明模型/端点白名单、真实发送次数上限、超时取消、非法概率/缺字段失败、GLM候选外ID拒绝、密钥不进日志。若真实 pi-ai 输出路径不能保证一次HTTP请求，不进入真实调用；先提交最小实现方案差异。

执行后：逐样本记录 input/config/candidate哈希、prompt版本、实际model/provider、http状态、请求次数、用量/费用可观测性、latency、概率向量、C/D校验后的选择、事前期待与偏差。保留超时/失败/unknown分母。原始响应先白名单投影，不保存认证头或任意异常文本。

6条开发样本只能用于协议与明显错误诊断。C/D选择差异不代表真实行为改善；后续四臂 actor 与独立留出评价仍按 PRI-1141 原方案另外准备和批准。

## 5. 官方来源

- 模型类别与实时目录：<https://openrouter.ai/models?output_modalities=decisions>，<https://openrouter.ai/api/v1/models?output_modalities=decisions>
- 免费目标与用途：<https://openrouter.ai/respan/span-01-lite:free>
- Decisions端点与typed questions：<https://openrouter.ai/docs/guides/community/multimodal-decisions>
- Respan行为评分定义：<https://www.respan.ai/docs/documentation/features/pulse/behaviors>
- Owner提供的备选入口：<https://discovery.intern-ai.org.cn/token-plan/home?tabIndex=0>、<https://developer.amd.com.cn/radeon/tokenfactory>。两处动态网页本轮未取得有效套餐内容，不推断具体免费额度。

## 6. 需要确认的具体边界

请求 Owner 批准本补充的专用 Decisions 薄客户端、隔离CLI及fake HTTP验收，并批准上述最多18次请求的合成诊断（GLM最多12次，512输出token/次；不包括actor、真实会话和生产启用）。当前仅完成调查与方案，不因凭据存在或选择来源而推定新协议设计已获批准。

已准备可审阅的6条开发样本与问题定义：PD-AA-PRI-1122-DECISIONS-SYNTHETIC-DEV-v0.1.json；SHA-256：126759edb1508b9f8ab99cab8d22455532376e3e6070725a8db628fbedf4930e。该版本尚未执行；批准后须按实际文件字节再核实hash，不在运行中调题。

