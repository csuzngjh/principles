import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "Principles Disciple",
  description: "A Thinking OS and Evolution Sandbox for AI Agents",
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', href: '/images/favicon.svg' }],
    // Fonts: Inter (VitePress built-in), JetBrains Mono (code), Noto Sans SC (Chinese)
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', {
      href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Noto+Sans+SC:wght@300;400;500;700&display=swap',
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
          { text: 'Docs', link: '/docs/getting-started' },
          { text: 'Abyss', link: '/abyss/' },
          { text: 'GitHub', link: 'https://github.com/csuzngjh/principles' }
        ],
        sidebar: {
          '/docs/': [
            {
              text: 'Guide & Reference',
              items: [
                { text: 'Getting Started', link: '/docs/getting-started' },
                { text: 'User Guide', link: '/docs/user-guide' },
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
          { text: '文档', link: '/zh/docs/user-guide' },
          { text: '思维深渊', link: '/zh/abyss/' },
          { text: 'GitHub', link: 'https://github.com/csuzngjh/principles' }
        ],
        sidebar: {
          '/zh/docs/': [
            {
              text: '使用指南与参考手册',
              items: [
                { text: '用户指南 (User Guide)', link: '/zh/docs/user-guide' },
              ]
            }
          ],
          '/zh/abyss/': [
            {
              text: '思维深渊',
              items: [
                { text: '深渊导引', link: '/zh/abyss/' },
                { text: '01 | 赛博垃圾围城与人类逃生舱', link: '/zh/abyss/01-the-helmsman-crisis' },
                { text: '02 | 为什么"硅基鸡汤"是无效摩擦', link: '/zh/abyss/02-poisonous-chicken-soup' },
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
 'https://github.com/csuzngjh/principles' }
    ]
  }
})
