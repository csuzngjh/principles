# PRI-CR1：视觉基线 — design tokens + 基础组件

**Type**: AFK
**Priority**: P0（最先做，所有页面依赖）
**Blocked by**: 无
**必读**: `../01-shared-constraints.md`（**A.1 技术栈、A.2 主题系统**、B 节全部、E 节）、`packages/pd-console/design-prototype/governance-focus.html` 与 `principle-review.html`（token 参考实现，含亮色/暗色双模式）、`docs/brand/PD_BRAND_CONSTITUTION.md` §5

## 背景

当前 `src/ui/styles/globals.css` 的 `@theme` 用的是偏亮的 SaaS 蓝
（`--color-primary: hsl(210 80% 50%)`），偏离品牌宪章 §5.2 要求的暖纸背景 +
Governance Blue。本工单把品牌视觉基线固化为 design tokens 和一组基础组件样式，
作为后续所有页面的唯一视觉来源。

## What to build

1. **替换 `globals.css` 的 `@theme` 颜色 token** 为 `01-shared-constraints.md` B.1
   的整套值（paper/surface/ink ramp/line/gov/amber/green/danger）。同时实现
   B.1.1 暗色模式 token（`[data-theme="dark"]` 选择器覆盖，**不是** `.dark` class）。
2. **加入间距/圆角/阴影/动效 token**（B.2）：8px 间距基、`--r-sm/--r/--r-lg`、
   三档阴影 `--e1: none / --e2 / --e3`（默认无阴影）、统一缓动
   `cubic-bezier(.4,0,.2,1)`，以及 `prefers-reduced-motion` 全局降级。
3. **字体 token**（B.3）：安装 `@fontsource/jetbrains-mono`（A.1 唯一新增依赖），
   配置字体栈（`--sans` / `--mono`）、光学字号阶梯（CSS 变量或 Tailwind 配置），
   全局数字 `tabular-nums`。
4. **校准基础组件**（`src/ui/components/ui/` 既有 shadcn 组件）使其符合上面 token：
   - `button`：primary（gov 实底）、ghost（描边）、quiet（无底）三态，
     `border-radius: var(--r-sm)` (3px)，`font-size: 12.5px`，`padding: 6px 14px`（B.4.7）。
   - `card`：默认无阴影（`--e1: none`），hover 仅阴影出现（`--e2`）+ 边框色加深，
     **无 transform**（无 translateY/scale，B.4.4）。
   - `badge`/状态标签：低饱和，按 E 节状态词配色（待审查=gov、需注意=amber、
     稳定=green、风险=danger），`border-radius: 2px`，`font-family: var(--mono)`，
     `font-size: 11px`（B.4.5）。
5. **主题系统切换**（A.2）：修改 `theme-provider.tsx`，从 `classList.toggle('dark')`
   切换为 `setAttribute('data-theme', isDark ? 'dark' : 'light')`，偏好持久化到
   `localStorage('pd-theme')`，无值时跟随 `prefers-color-scheme`。
6. **建立一个 `/design-system` 内部预览路由（仅开发可见）**，渲染所有 token 色板（含
   亮色/暗色双模式）、按钮态、卡片、标签、空状态、错误态，作为后续工单的对照基准
   和回归视觉锚点。

## Acceptance criteria

- [ ] `globals.css` 不再包含 `hsl(210 80% 50%)` 这类高饱和蓝；主色为 `--gov: #1E3A5F`（B.1）。
- [ ] 所有颜色集中在 `@theme`，页面/组件**不出现**硬编码十六进制色值（除 token 定义处）。
- [ ] 暗色模式 token 完整实现（B.1.1），通过 `[data-theme="dark"]` 选择器覆盖，
      **不是** `.dark` class（A.2）。
- [ ] `/design-system` 预览页渲染：亮色/暗色色板、3 种按钮态、卡片 hover（无 transform，
      仅阴影+边框加深）、4 种状态标签（2px 圆角等宽）、1 个空状态、1 个错误态，
      视觉与 `design-prototype` 一致。
- [ ] `prefers-reduced-motion: reduce` 下所有过渡/动画关闭。
- [ ] `@fontsource/jetbrains-mono` 已安装并在 `main.tsx` 或 `globals.css` 中 import。
- [ ] `theme-provider.tsx` 使用 `data-theme` 属性而非 `classList`（A.2）。
- [ ] `cd packages/pd-console && npm run build && npm run test` 通过；`npm run lint` 通过。

## 实施提示（防漂移）

- 直接把 `design-prototype/governance-focus.html` 的 `:root` 段当作 token 的**事实
  来源**逐条搬运，不要自行调整色值或新增颜色。暗色 token 参考同文件的
  `[data-theme="dark"]` 段。
- 不要引入新依赖（除 `@fontsource/jetbrains-mono`）、新 UI 库、新动画库。只用现有
  Tailwind v4 + shadcn。
- 组件改造保持 API 兼容（props 不变），只改样式，避免破坏未迁移页面的编译。
- 卡片 hover **禁止**使用 `transform: translateY()` 或 `scale()`（B.4.4），仅用
  阴影 + 边框色变化。
- 主题系统必须用 `data-theme` 属性（A.2），不要用 `.dark` class。

## MVP 三问

- **不做会怎样**：每个页面各自调色，必然风格漂移，重做失去意义。
- **怎么观察**：`/design-system` 预览页 + 构建通过。
- **怎么关闭**：纯样式层；token 可整体回退到旧 `@theme`（git revert 本 PR）。

## DoD

见 `../01-shared-constraints.md` I 节。
