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
