# 扩展思维模型索引

> 根据任务需要，使用 `read` 工具加载一个或多个模型进行组合分析。

## 可用模型

| ID | 名称 | 适用场景 | 文件路径 |
|----|------|----------|----------|
| MARKETING_4P | 营销4P模型 | 营销策略、市场规划、产品推广 | docs/models/marketing_4p.md |
| SWOT | SWOT分析 | 战略分析、竞争评估、决策支持 | docs/models/swot.md |
| PORTER_FIVE | 波特五力模型 | 行业分析、竞争格局、市场进入 | docs/models/porter_five.md |
| FIRST_PRINCIPLES | 第一性原理 | 复杂问题拆解、创新思考 | docs/models/first_principles.md |
| USER_STORY_MAP | 用户故事地图 | 产品规划、需求分析、用户体验 | docs/models/user_story_map.md |

## 使用方式

1. 分析任务上下文，判断需要哪些思维模型
2. 使用 `read` 工具加载选中的模型文件
3. 可以加载多个模型进行组合分析
4. 如果没有匹配的模型，直接使用元认知模型（T-01 到 T-09）

## 模型组合建议

- **营销策略分析**：MARKETING_4P + SWOT
- **市场进入决策**：PORTER_FIVE + SWOT
- **产品创新**：FIRST_PRINCIPLES + USER_STORY_MAP
- **竞争分析**：SWOT + PORTER_FIVE
