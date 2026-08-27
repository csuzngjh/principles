import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "Principles Disciple",
  description: "Principles Disciple is an AI Agent Governance System that turns repeated Agent corrections into reviewable, reversible behavior principles governed by the Owner.",
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: false,

  head: [
    ['link', { rel: 'icon', href: '/images/favicon.svg' }],
    // Fonts: Inter (VitePress built-in), JetBrains Mono (code), Noto Sans SC (Chinese)
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', {
      href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Noto+Sans+SC:wght@300;400;500;700&display=swap',
      rel: 'stylesheet'
    }],
    // Open Graph — canonical production URL; update if primary domain changes
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Principles Disciple' }],
    ['meta', { property: 'og:description', content: 'Principles Disciple is an AI Agent Governance System — turn repeated corrections into Owner-approved, observable, reversible Agent behavior principles.' }],
    ['meta', { property: 'og:image', content: 'https://principles-website.pages.dev/images/og-image.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://principles-website.pages.dev/images/og-image.png' }],
    // Cloudflare Web Analytics beacon — privacy-first, no cookies, gives Core Web Vitals
    ['script', {
      defer: true,
      src: 'https://static.cloudflareinsights.com/beacon.min.js',
      'data-cf-beacon': '{"token": "17b7954b9e24419198b8837990ddb022"}'
    }],
    // Umami Cloud analytics — privacy-first, no cookies, supports custom events
    // Complements Cloudflare Web Analytics (which lacks event tracking)
    ['script', {
      defer: true,
      src: 'https://cloud.umami.is/script.js',
      'data-website-id': '0f7e4622-4634-40c1-8c52-8496226e41d0'
    }],
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      description: 'Principles Disciple is an AI Agent Governance System — owner-governed, observable, reversible behavior principles for AI Agents.',
      themeConfig: {
        nav: [
          { text: 'Home', link: '/' },
          { text: 'Install', link: '/install' },
          { text: 'Download', link: '/download' },
          { text: 'Docs', link: '/docs/getting-started' },
          { text: 'FAQ', link: '/faq' },
          { text: 'Abyss', link: '/abyss/' },
          { text: 'GitHub', link: 'https://github.com/csuzngjh/principles' }
        ],
        sidebar: {
          '/docs/': [
            {
              text: 'Guide & Reference',
              items: [
                { text: 'What is a Principle?', link: '/docs/principles' },
                { text: 'From Experience to Principle', link: '/docs/principle-internalization' },
                { text: 'Getting Started', link: '/docs/getting-started' },
                { text: 'User Guide', link: '/docs/user-guide' },
                { text: 'Slash Commands', link: '/docs/slash-commands' },
                { text: 'Anonymous Telemetry (Privacy)', link: '/docs/telemetry' },
                { text: 'Development Guide', link: '/docs/development' },
              ]
            }
          ],
          '/abyss/': [
            {
              text: "Abyss of Thought",
              items: [
                { text: 'Introduction', link: '/abyss/' },
                { text: '01 | The Helmsman Crisis & Cyber Escape Pod', link: '/abyss/01-the-helmsman-crisis' },
                { text: '02 | The Illusion of Wisdom', link: '/abyss/02-poisonous-chicken-soup' },
                { text: '03 | Pain is the Signal: Forward Evolution', link: '/abyss/03-biological-forward-pass' },
                { text: '04 | The Alchemy of Soft to Hard Rules', link: '/abyss/04-soft-to-hard-rules' },
                { text: '05 | Co-evolution: Why the Owner is the Crucial Variable', link: '/abyss/05-co-evolution' },
                { text: '06 | The Expanding Boundary: The Tower, the Boat, and the Silicon Amoeba', link: '/abyss/06-expanding-boundary' },
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
      description: 'Principles Disciple（PD）是一个 AI Agent 行为治理系统——把反复纠正沉淀为由 Owner 审批、效果可观察、随时可回滚的 Agent 行为原则。',
      themeConfig: {
        nav: [
          { text: '首页', link: '/zh/' },
          { text: '安装', link: '/zh/install' },
          { text: '下载', link: '/zh/download' },
          { text: '文档', link: '/zh/docs/getting-started' },
          { text: '常见问题', link: '/zh/faq' },
          { text: '思维深渊', link: '/zh/abyss/' },
          { text: 'GitHub', link: 'https://github.com/csuzngjh/principles' }
        ],
        sidebar: {
          '/zh/docs/': [
            {
              text: '使用指南与参考手册',
              items: [
                { text: '什么是原则 (What is a Principle)', link: '/zh/docs/principles' },
                { text: '从经验到原则 (From Experience to Principle)', link: '/zh/docs/principle-internalization' },
                { text: '快速开始 (Getting Started)', link: '/zh/docs/getting-started' },
                { text: '用户指南 (User Guide)', link: '/zh/docs/user-guide' },
                { text: '斜杠命令参考 (Slash Commands)', link: '/zh/docs/slash-commands' },
                { text: '匿名遥测（隐私说明）', link: '/zh/docs/telemetry' },
                { text: '开发指南 (Development Guide)', link: '/zh/docs/development' },
              ]
            }
          ],
          '/zh/abyss/': [
            {
              text: '思维深渊',
              items: [
                { text: '深渊导引', link: '/zh/abyss/' },
                { text: '01 | 赛博垃圾围城与人类逃生舱', link: '/zh/abyss/01-the-helmsman-crisis' },
                { text: '02 | 为什么“硅基鸡汤”注定沦为赛博噪音？', link: '/zh/abyss/02-poisonous-chicken-soup' },
                { text: '03 | 痛苦即信号：前向进化的生物学硬核启示', link: '/zh/abyss/03-biological-forward-pass' },
                { text: '04 | 软硬转换炼金术：系统本能的内化之路', link: '/zh/abyss/04-soft-to-hard-rules' },
                { text: '05 | 协同进化：为什么 Owner 才是智能系统的关键变量？', link: '/zh/abyss/05-co-evolution' },
                { text: '06 | 智能的膨胀边界：巨塔、小艇与硅基阿米巴', link: '/zh/abyss/06-expanding-boundary' },
              ]
            }
          ]
        }
      }
    }

  },

  themeConfig: {
    logo: '/images/logo.svg',
    search: {
      provider: 'local'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/csuzngjh/principles' }
    ]
  }
})
