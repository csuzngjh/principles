# Principles Disciple (PD) - Website & Blog Development Specification

> **⚠️ ARCHIVED**: This spec is outdated and retained for historical reference only. The website implementation has diverged from this document. Do not use it as a build spec. Refer to the actual website source at `packages/website/` and `docs/product/PRODUCT_IDENTITY.md` for current product definitions.

> **Target Audience**: AI Coding Assistant / Frontend Engineer
> **Role**: Execute this specification precisely to scaffold and deploy the official PD website using VitePress.

---

## 1. Context & Tech Stack

- **Goal**: Create a highly polished, bilingual (English/Chinese) documentation and blog site for the Principles Disciple (PD) project.
- **Framework**: VitePress (Vue 3 based).
- **Location**: `packages/website` within the existing pnpm monorepo.
- **Hosting**: Vercel.

### MVP Content Scope

> **IMPORTANT**: Only Article 01 is production-ready. Articles 02–05 are drafts and MUST NOT be published.
> The MVP ships with one live article; the sidebar shows future articles as "Coming Soon" placeholders.

| Article | Status | Action |
|---------|--------|--------|
| 01 - The Helmsman Crisis | ✅ Ready | Publish |
| 02 - Poisonous Chicken Soup | 🚧 Draft | Sidebar placeholder only |
| 03 - Biological Forward Pass | 🚧 Draft | Sidebar placeholder only |
| 04 - Soft-to-Hard Rules | 🚧 Draft | Sidebar placeholder only |
| 05 - The Silicon Musk | 🚧 Draft | Sidebar placeholder only |

---

## 2. Directory Structure Blueprint

Scaffold the following directory structure inside `packages/website`:

```text
packages/website/
├── package.json               # Dependencies and scripts
├── .vitepress/
│   ├── config.mts             # Core VitePress configuration (i18n, routing, theme)
│   ├── public/                # Static assets (images, icons, etc.)
│   │   └── images/            # Blog illustrations + static assets
│   │       ├── hero.png       # Landing page hero image (ALREADY EXISTS)
│   │       ├── og-image.png   # Social share card 1200×630 (use hero.png for now)
│   │       ├── favicon.svg    # Browser tab icon (CREATE per spec below)
│   │       ├── 1.png          # Article 01 illustration: developer + AI network (ALREADY EXISTS)
│   │       ├── 2.png          # Article 01 illustration: cyber garbage siege (ALREADY EXISTS)
│   │       ├── 3.png          # Article 01 illustration: replicated AI pipelines (ALREADY EXISTS)
│   │       ├── 4.png          # Article 01 illustration: typist trapped by rules (ALREADY EXISTS)
│   │       ├── 5.png          # Article 01 illustration: constructive friction (ALREADY EXISTS)
│   │       ├── 6.png          # Article 01 illustration: AI brain self-renewal (ALREADY EXISTS)
│   │       └── 7.png          # Article 01 illustration: helmsman + AI sailing (ALREADY EXISTS)
│   └── theme/
│       ├── index.ts           # Theme entry
│       └── custom.css         # Cyberpunk Fluid Layout Styles
├── index.md                   # English Landing Page
├── blog/                      # English Blog Posts
│   └── 01-the-helmsman-crisis.md
└── zh/
    ├── index.md               # Chinese Landing Page
    └── blog/                  # Chinese Blog Posts
        └── 01-the-helmsman-crisis.md
```

---

## 3. Dependency & Scripts Setup (`package.json`)

Create `packages/website/package.json`:

```json
{
  "name": "@principles/website",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "docs:dev": "vitepress dev",
    "docs:build": "vitepress build",
    "docs:preview": "vitepress preview"
  },
  "devDependencies": {
    "vitepress": "^1.6.3",
    "vue": "^3.4.0"
  }
}
```

> **Note**: Pin `vitepress` to a specific minor version (never `"latest"`). Verify the latest stable release before scaffolding and update the version string accordingly.

---

## 4. VitePress Configuration (`.vitepress/config.mts`)

```typescript
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "Principles Disciple",
  description: "A Thinking OS and Evolution Sandbox for AI Agents",
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ['link', { rel: 'icon', href: '/images/favicon.svg' }],
    // Google Fonts: Space Grotesk (Latin), JetBrains Mono (code), Noto Sans SC (Chinese)
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', {
      href: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=JetBrains+Mono:wght@400;700&family=Noto+Sans+SC:wght@400;700&display=swap',
      rel: 'stylesheet'
    }],
    // Open Graph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Principles Disciple' }],
    ['meta', { property: 'og:description', content: '硅基生命的思维操作系统与进化沙盒 | A Thinking OS for Silicon Lifeforms' }],
    ['meta', { property: 'og:image', content: 'https://principles-disciple.vercel.app/images/og-image.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://principles-disciple.vercel.app/images/og-image.png' }],
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      description: 'A Thinking OS and Evolution Sandbox for AI Agents',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/' },
          { text: 'Manifesto', link: '/blog/01-the-helmsman-crisis' },
          { text: 'GitHub', link: 'https://github.com/csuzngjh/principles' }
        ],
        sidebar: {
          '/blog/': [
            {
              text: 'The Evolution Manifesto',
              items: [
                { text: '01 | The Helmsman Crisis', link: '/blog/01-the-helmsman-crisis' },
                // Articles 02-05: translations pending — listed for navigation context only
                { text: '02 | The Illusion of Wisdom (coming soon)', link: '/blog/01-the-helmsman-crisis' },
                { text: '03 | Pain as Signal (coming soon)', link: '/blog/01-the-helmsman-crisis' },
                { text: '04 | Soft-to-Hard Alchemy (coming soon)', link: '/blog/01-the-helmsman-crisis' },
                { text: '05 | The Silicon Musk (coming soon)', link: '/blog/01-the-helmsman-crisis' },
              ]
            }
          ]
        }
      }
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      description: '硅基生命的思维操作系统与进化沙盒',
      themeConfig: {
        nav: [
          { text: '首页', link: '/zh/' },
          { text: '进化宣言', link: '/zh/blog/01-the-helmsman-crisis' },
          { text: 'GitHub', link: 'https://github.com/csuzngjh/principles' }
        ],
        sidebar: {
          '/zh/blog/': [
            {
              text: '硅基进化宣言 (连载)',
              items: [
                { text: '01 | 赛博垃圾围城与人类逃生舱', link: '/zh/blog/01-the-helmsman-crisis' },
                { text: '02 | 为什么"硅基鸡汤"是无效摩擦 (即将上线)', link: '/zh/blog/01-the-helmsman-crisis' },
                { text: '03 | 前向进化的生物学硬核启示 (即将上线)', link: '/zh/blog/01-the-helmsman-crisis' },
                { text: '04 | 软硬转换炼金术 (即将上线)', link: '/zh/blog/01-the-helmsman-crisis' },
                { text: '05 | 逃生舱里的沙盒：打造硅基马斯克 (即将上线)', link: '/zh/blog/01-the-helmsman-crisis' },
              ]
            }
          ]
        }
      }
    }
  },

  themeConfig: {
    search: {
      provider: 'local'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/csuzngjh/principles' }
    ]
  }
})
```

---

## 5. Visual Identity & Fluid Layout (CSS Overrides)

Create `packages/website/.vitepress/theme/custom.css` with the following "Cyberpunk Fluid" styles.

```css
/* ── Font Stack ─────────────────────────────────────────── */
:root {
  --vp-font-family-base: 'Space Grotesk', 'Noto Sans SC', system-ui, sans-serif;
  --vp-font-family-mono: 'JetBrains Mono', monospace;

  /* Brand colors */
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: linear-gradient(135deg, #38bdf8 0%, #a855f7 100%);
  --vp-home-hero-image-filter: drop-shadow(0 0 50px rgba(56, 189, 248, 0.3));
  --vp-c-brand-1: #38bdf8;
  --vp-c-brand-2: #a855f7;
  --vp-c-bg: #0b0e14; /* Deep cyber black */
}

/* ── Fluid Hero Background Animation ───────────────────── */
.VPHero {
  background: radial-gradient(circle at 50% -20%, rgba(56, 189, 248, 0.15) 0%, transparent 50%);
  position: relative;
  overflow: hidden;
}

.VPHero::before {
  content: "";
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
  opacity: 0.05;
  pointer-events: none;
  animation: flux 30s infinite linear;
}

@keyframes flux {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── Glassmorphism Feature Cards ────────────────────────── */
.VPFeature {
  background: rgba(255, 255, 255, 0.03) !important;
  border: 1px solid rgba(255, 255, 255, 0.05) !important;
  backdrop-filter: blur(10px);
  border-radius: 16px !important;
  transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) !important;
}

.VPFeature:hover {
  transform: translateY(-8px) scale(1.02);
  border-color: var(--vp-c-brand-1) !important;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
}

/* ── Fluid Staggered Layout for Features ────────────────── */
@media (min-width: 960px) {
  .VPFeatures .container .items .item:nth-child(even) {
    margin-top: 40px; /* Fluid stagger effect */
  }
}
@media (max-width: 959px) {
  .VPFeatures .container .items .item {
    margin-top: 0; /* Reset for mobile */
  }
}

/* ── Cyberpunk Image Styling in Markdown ────────────────── */
.vp-doc img {
  border-radius: 12px;
  border: 1px solid rgba(56, 189, 248, 0.2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  transition: border-color 0.3s ease;
  width: 100%;
  height: auto;
  display: block;
  margin: 2rem auto;
}

.vp-doc img:hover {
  border-color: var(--vp-c-brand-1);
}

/* ── "Coming Soon" sidebar item styling ─────────────────── */
.VPSidebarItem .text:has(+ .coming-soon),
a[href*="coming-soon"] {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}
```

---

## 6. Theme Entry (`.vitepress/theme/index.ts`)

```typescript
import DefaultTheme from 'vitepress/theme'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Register custom components if needed
  }
}
```

---

## 7. Static Assets — Create These Files

### 7a. Favicon (`favicon.svg`)

Create `.vitepress/public/images/favicon.svg` with the following content:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <!-- Hexagon shape representing the "disciple" node -->
  <polygon points="16,2 28,9 28,23 16,30 4,23 4,9"
           fill="none" stroke="url(#g)" stroke-width="2"/>
  <!-- Inner triangle: the "principle" spark -->
  <polygon points="16,8 23,20 9,20"
           fill="url(#g)" opacity="0.85"/>
</svg>
```

### 7b. OG Image

The file `.vitepress/public/images/og-image.png` is required for social sharing cards (1200×630 px).

**For MVP**: Copy `hero.png` and crop/resize to 1200×630:
```powershell
# Run from packages/website/.vitepress/public/images/
Copy-Item hero.png og-image.png
```
A proper OG image (with title text overlay) can be created post-launch.

---

## 8. Landing Page Design (Hero Section)

### English Homepage (`index.md`)

```markdown
---
layout: home

hero:
  name: "Principles Disciple"
  text: "A Thinking OS for Silicon Lifeforms"
  tagline: "Stop building obedient typists. Start cultivating cognitive partners through Constructive Friction and System Dynamics."
  image:
    src: /images/hero.png
    alt: "Principles Disciple — A human and AI co-navigating the cyberpunk frontier"
  actions:
    - theme: brand
      text: Read the Manifesto
      link: /blog/01-the-helmsman-crisis
    - theme: alt
      text: View on GitHub
      link: https://github.com/csuzngjh/principles

features:
  - title: Constructive Friction
    details: Introduces calculated friction before execution, forcing AI to evaluate the "Why" to prevent the generation of cyber garbage.
  - title: Soft-to-Hard Alchemy
    details: Compiles abstract natural language principles (L1) into concrete AST/Lint constraints (L2), creating AI muscle memory without context debt.
  - title: Evolution Sandbox
    details: A safe environment powered by Pain + Reflection, enabling continuous cognitive evolution for autonomous agents.
---
```

### Chinese Homepage (`zh/index.md`)

```markdown
---
layout: home

hero:
  name: "Principles Disciple"
  text: "硅基生命的思维操作系统"
  tagline: "拒绝平庸的顺从执行。通过「建设性摩擦」与「软硬规则编译」，将哲学植入代码土壤，打造拥有高维认知的硅基合伙人。"
  image:
    src: /images/hero.png
    alt: "原则门徒 — 人类与 AI 并肩驾驭赛博朋克前沿"
  actions:
    - theme: brand
      text: 阅读进化宣言
      link: /zh/blog/01-the-helmsman-crisis
    - theme: alt
      text: GitHub 开源
      link: https://github.com/csuzngjh/principles

features:
  - title: 建设性摩擦 (Constructive Friction)
    details: 阻断零摩擦的盲目执行，在核心决策点引入高强度反思，迫使 AI 在写烂代码前踩下刹车。
  - title: 软硬编译炼金术 (Soft-to-Hard)
    details: 独创 PrincipleCompiler，将抽象的大道理解码为 AST/Lint 硬防御，清空大模型上下文，建立真正的肌肉记忆。
  - title: 百年进化沙盒
    details: 摒弃惩罚机制，以 Pain + Reflection 为核心驱动力，记录每一次犯错与进化，赋予硅基生命连续的身份认同。
---
```

---

## 9. Article Frontmatter Standard

Every article markdown file **MUST** include the following frontmatter. Add it if missing during migration.

```yaml
---
title: "Article Title Here"
description: "One-sentence summary for SEO meta description (max 160 chars)."
date: YYYY-MM-DD
author: Wesley
lang: zh-CN   # or en
---
```

---

## 10. Content Migration Protocol

### Step 1: Clean Up Illustration Prompt Placeholders

The source articles (both Chinese and English) contain illustration prompt comments in the following formats:

```
![插图提示：...](empty)         ← Chinese format
*[Illustration Prompt: ...]*    ← English format
![Cover Illustration Prompt: ...]()  ← Cover format
```

**These MUST be replaced with actual image tags before publishing.** Do NOT copy raw placeholder text to the website.

**Image mapping for Article 01** (apply during migration):

| Placeholder position | Replace with |
|----------------------|--------------|
| Cover / opening image | `![开发者与 AI 认知网络](/images/1.png)` |
| Section 01 (execution carnival) | `![赛博垃圾围城](/images/2.png)` |
| Section 02 (pixel replication) | `![AI 流水线被无限复制](/images/3.png)` |
| Section 03 (cognitive trap) | `![打字员困境](/images/4.png)` |
| Section 04 (constructive friction) | `![建设性摩擦核心场景](/images/5.png)` |
| Section 05 (self-warning) | `![AI 大脑自我进化重构](/images/6.png)` |
| Section 06 (closing / trailblazers) | `![人类与 AI 并肩驾船远航](/images/7.png)` |

Use the same `/images/N.png` paths in the English article, with English alt text.

### Step 2: Copy Files

1. Copy `docs/articles/01-the-helmsman-crisis.md` → `packages/website/zh/blog/01-the-helmsman-crisis.md`
2. Copy `docs/articles/01-the-helmsman-crisis-en.md` → `packages/website/blog/01-the-helmsman-crisis.md`
3. Apply image replacement mapping from Step 1 to **both** files.
4. Add frontmatter (per Section 9) to both files if missing.

### Step 3: Do NOT copy 02–05

Articles 02–05 are draft-only. Their sidebar entries already link back to article 01 as placeholders. Copy these files only when their content is finalized.

---

## 11. Vercel Deployment Protocol

Once the code is committed and pushed to GitHub, configure Vercel with these **exact** settings:

| Setting | Value |
|---------|-------|
| Framework Preset | `VitePress` |
| Root Directory | `packages/website` |
| Build Command | `npm run docs:build` |
| Output Directory | `.vitepress/dist` |
| Node.js Version | 20.x |

> **After first deployment**: Update the `og:image` and `twitter:image` URLs in `config.mts` with the real Vercel domain, then redeploy.

---

## 12. Post-MVP Checklist (Do After Launch)

- [ ] Finalize Articles 02–05 and migrate them (removing the "coming soon" sidebar placeholders)
- [ ] Commission proper OG image (1200×630) with title text overlay
- [ ] Add `vitepress-plugin-rss` for RSS feed support
- [ ] Enable Vercel Analytics in project settings
- [ ] Add `sitemap.xml` generation (`vitepress` built-in: set `sitemap: { hostname: '...' }` in config)

---

**Execution Command**: AI Assistant, please read this spec, create the necessary files, run `pnpm install`, and test with `npm run docs:dev` inside the `packages/website` directory. Follow sections in order: 3 → 4 → 5 → 6 → 7 → 8 → 10, then verify with `docs:build` before committing.
