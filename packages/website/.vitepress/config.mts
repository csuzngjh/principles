import { defineConfig } from 'vitepress'

// 站点地址的唯一来源：og:image / twitter:image / sitemap / canonical 全部从这里派生。
// 换主域时只改这一行——原来散在 og 注释里的"update if primary domain changes"从此作废。
const SITE_URL = 'https://principles-website.pages.dev'

// 与 VitePress `generateSitemap()` 的拼法逐字对齐（它做的是同样的两次 replace），
// 否则 canonical 与 sitemap 的 <loc> 会分叉，等于给搜索引擎两个权威地址。
function canonicalHref(page: string, cleanUrls: boolean | undefined): string {
  const url = page
    .replace(/(^|\/)index\.md$/, '$1')
    .replace(/\.md$/, cleanUrls ? '' : '.html')
  return new URL(url, SITE_URL).href
}

export default defineConfig({
  title: "Principles Disciple",
  description: "Principles Disciple is an AI Agent Governance System that turns repeated Agent corrections into reviewable, reversible behavior principles governed by the Owner.",
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: false,

  // VitePress 只在设置了 hostname 时才产出 sitemap.xml（此前 404 就是这个原因）。
  sitemap: {
    hostname: SITE_URL,
    // `video/**` 是首页演示视频的工程目录，里面自带 AGENTS.md / CLAUDE.md /
    // design.md，VitePress 会把它们当正文页面渲染（线上实测
    // `GET /video/homepage-demo/README` = 200）。本文件不擅自下线这些 URL，
    // 只保证不把内部文档广播给搜索引擎。
    transformItems: (items) =>
      items.filter((item) => !(item.url ?? '').startsWith('video/')),
  },

  // VitePress 不自动生成 <link rel="canonical">；缺它时同一页的
  // `/foo`、`/foo.html`、带查询参数的版本会被当成三个页面。
  transformHead({ page, siteConfig }) {
    return [['link', { rel: 'canonical', href: canonicalHref(page, siteConfig.cleanUrls) }]]
  },

  head: [
    ['link', { rel: 'icon', href: '/images/favicon.svg' }],
    // Google Search Console 所有权验证（URL 前缀资源 https://principles-website.pages.dev/）。
    // *.pages.dev 的 NS 归 Cloudflare，我们无权放 DNS TXT，只能走这一条；删掉它等于
    // 悄悄失去站长平台的 sitemap 提交与收录请求配额，所以 tests/seo-contract.test.mjs 有断言守着。
    ['meta', { name: 'google-site-verification', content: 'Bj8PCwx4YUwfQKZZpL_uFHKJLSxWGOIBTaZd7M57vMc' }],
    // Bing Webmaster Tools 所有权验证（站点 https://principles-website.pages.dev/）。
    // 同一理由：*.pages.dev 无权放 DNS 记录，HTML 标记是唯一不动 Cloudflare 的路；
    // 标签删掉后 Bing 不立刻报错，下次重新校验才发现，所以同样由 seo 契约测试守着。
    ['meta', { name: 'msvalidate.01', content: '0406CE95FAFB007F71CD3F1E4492C498' }],
    // Fonts: Inter (VitePress built-in), JetBrains Mono (code), Noto Sans SC (Chinese)
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', {
      href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Noto+Sans+SC:wght@300;400;500;700&display=swap',
      rel: 'stylesheet'
    }],
    // Open Graph — 地址一律取自上面的 SITE_URL，不再各处硬编码域名
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Principles Disciple' }],
    ['meta', { property: 'og:description', content: 'Principles Disciple is an AI Agent Governance System — turn repeated corrections into Owner-approved, observable, reversible Agent behavior principles.' }],
    ['meta', { property: 'og:image', content: `${SITE_URL}/images/og-image.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: `${SITE_URL}/images/og-image.png` }],
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
                { text: '07 | The Goal Management Paradox: The Better We Get at Achieving Goals, the Farther We May Drift', link: '/abyss/07-goal-management-paradox' },
                { text: '08 | A Goal Is Not a Prompt: When Agents Learn to Execute, Who Is Responsible for Judgment?', link: '/abyss/08-goal-not-a-prompt' },
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
                { text: '07 | 当我们越来越擅长实现目标，为什么反而可能离目标越来越远？', link: '/zh/abyss/07-goal-management-paradox' },
                { text: '08 | 目标不是一段 Prompt：当智能体学会执行，谁来负责判断？', link: '/zh/abyss/08-goal-not-a-prompt' },
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
