@mvp-core
Feature: Owner 在 FocusPage 审批原则

  Story A 前端切面:Owner 在 pd-console 的 FocusPage 看到 governance queue,
  点击审批通过,验证 pending 数量减少 + ActivationPage 出现激活项。

  对应现有 e2e 测试:focus-approve-flow.spec.ts

  Background:
    Given pd-console 服务已启动在 http://127.0.0.1:3100
    And governance queue 有 2 条待审批项

  @prd-matrix:focus-approve
  Scenario: governance queue 加载 → approve → pending 减少 + activation 出现
    When owner 在 FocusPage 点击第一条审批通过按钮
    Then governance queue 的 pending 数量减少 1
    And ActivationPage 出现新的激活项
