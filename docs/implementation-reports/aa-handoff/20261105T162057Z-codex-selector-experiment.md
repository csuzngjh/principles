# PRI-1141 实验检查点

- 已实现隔离专用Decisions→GLM研究CLI；24项本地测试与core构建PASS。
- 真实首请求HTTP400，decision1、GLM0；按卡STOPPED，未重试换模型，无比较结果。
- 原始错误体未保存，确切根因UNKNOWN；已补安全错误投影与本地静态原因/阶段。两路Luna只读审查已完成。
- 保留原始失败账本、一次审批claim和原始hash。全仓bootstrap skip-build的readiness未通过，未声称全仓READY。
- 新请求需要批准1次同参数免费诊断，不调用GLM；当前已提出具体询问，其他工程交付继续。
