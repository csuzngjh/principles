@mvp-quiet
Feature: Owner 管理关键词信号词库

  纠正观察员和共情观察员在后台用关键词检测信号，关键词可能过时或误报。
  Owner 需要能在控制台直接管理这些词库——添加、编辑、分类、删除——不需要去后端操作。

  覆盖设计文档验收矩阵:
  - @spec-entry: 入口仅出现在纠正观察员/共情观察员 L2 面板
  - @spec-filter: signalCollector 不作为独立 agent 展示
  - @spec-list: 信号关键词分页列表
  - @spec-edit: 编辑/删除都在 UI 内完成，不跳后端
  - @spec-pending: 待分类断词列表

  Background:
    Given Owner 已登录 PD Console

  @spec-entry
  Scenario: 纠正观察员展开后的 L2 面板显示"管理关键词"入口
    When Owner 展开纠正观察员的 L2 详情面板
    Then L2 面板中有一个"管理关键词"的入口
    And 点击后跳转到信号关键词页面，URL 携带 ?category=correction

  @spec-entry
  Scenario: 共情观察员展开后的 L2 面板显示"管理关键词"入口
    When Owner 展开共情观察员的 L2 详情面板
    Then L2 面板中有一个"管理关键词"的入口
    And 点击后跳转到信号关键词页面，URL 携带 ?category=empathy

  @spec-filter
  Scenario: 信号采集器不在代理列表中展示
    When Owner 打开控制中心
    Then sidechain 分组中只显示纠正观察员和共情观察员
    And 信号采集器 (signalCollector) 不显示在任何分组中

  @spec-list
  Scenario: 信号关键词页面展示关键词列表
    When Owner 通过纠正观察员入口进入信号关键词页面
    Then 页面标题显示"纠正关键词"
    And 列表中展示每个关键词的短语、来源、状态
    And 来源标签显示 seed / migrated / owner_promoted / llm_candidate

  @spec-edit
  Scenario: Owner 编辑一个已有关键词的来源
    When Owner 在关键词列表中点击编辑按钮
    Then 弹出一个编辑对话框
    And 对话框中可修改短语、来源、响应方式
    And 保存后列表立即更新

  @spec-edit
  Scenario: Owner 删除一个关键词
    When Owner 在关键词列表中点击删除按钮
    Then 弹出一个删除确认提示
    And Owner 确认后该关键词从列表中移除

  @spec-pending
  Scenario: 待分类断词列表展示待处理的断词
    When Owner 打开信号关键词页面
    Then 页面中有一个"待分类"区块
    And 区块中展示未分配类别的断词条目
    And 每一条断词可标记为"忽略"或"确认为关键词"
