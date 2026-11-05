# AA G1受控准入补充卡（供Owner确认）

日期2026-11-05。目标仍为一个OpenClaw embedded场景、一条现有有效原则；不更换模型、不增加付费调用、不修改安装或治理。

已核实：当前before_prompt_build producer没有currentUserMessageId/请求ID，不能将runId或随机token冒充这些原生身份。常规生产没有可信准入时必须保持Native。

建议受控路径：只在独立state/config/workspace的一次CLI调用中冻结本次真实输入、目标Artifact/Activation与完整content_json摘要；控制器的admissionId只表示实验准入，不声称宿主messageId。callback绑定真实ctx.sessionId/runId与单次hook标识，受控端点独立为实际HTTP请求编号。必须用实际输入、唯一调用及请求内容核对关联；历史/多请求/身份歧义保持unknown，不拼出成功。独立捕获先于首次输出的单调序列，不以模型自述判收益。

若当前模式无法可靠核对当前输入，则不放宽校验。可改用仓库既有challenge-openclaw-host.mjs的workspace-agents-md通道完成明确标注通道的受控工程实验；该通道不能冒称原prompt-hook已通过，也不自动替代真实工作中的试点。

成本与范围：最多一次正例、一次Native对照；每次配置预检25秒、宿主外层120秒、Agent45秒；仅127.0.0.1固定假provider；无工具、无并发、无fallback和自动重试。正文只保存在受控.tmp，提交摘要和最小引用。没有行为收益主张。

验收：工件使用前重验完整摘要与当前激活；目标完整指令在实际请求中且可关联准入/宿主真实session，独立请求收取早于输出；普通Native对照、已含目标、失效/预算/身份不可靠时不伪报新增或confirmed。不能满足关联则保留unknown。

回滚：停止该次受控调用及本地端点，关闭映射，生产Native不受影响。此卡不授权生产安装、真实工作区限域启用、外部provider、G2观察或AGENTS通道证据替代prompt-hook。

需确认的具体设计：允许以单次受控准入补充宿主缺失的消息身份取证；字段保持真实来源，不能伪称宿主原生消息或请求ID。若必须改通道，则另列结果，不混用验收。其他组件开发及测试继续进行。

Owner确认记录：本会话用户已书面回复“批准受控准入方案”。按上述范围继续；最多两次本地假模型调用的额度尚未使用。本记录不表示生产试用或发布获准。
