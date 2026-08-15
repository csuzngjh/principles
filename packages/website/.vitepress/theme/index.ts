import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import './custom.css'
import HeroSection from './components/HeroSection.vue'
import BehaviorExampleSection from './components/BehaviorExampleSection.vue'
import GovernanceLoopSection from './components/GovernanceLoopSection.vue'
import BoundarySection from './components/BoundarySection.vue'
import UseCasesSection from './components/UseCasesSection.vue'
import CompoundingSection from './components/CompoundingSection.vue'
import InstallSection from './components/InstallSection.vue'
import ThinkingLogCard from './components/ThinkingLogCard.vue'
import ClosingSection from './components/ClosingSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import InstallGuide from './components/InstallGuide.vue'
import DownloadPage from './components/DownloadPage.vue'

export default {
  extends: DefaultTheme,
  // Inject the site footer globally via the layout-bottom slot so it appears
  // on every page (home, docs, abyss), not only on the homepage.
  Layout: () => {
    return h(DefaultTheme.Layout, null, {
      'layout-bottom': () => h(SiteFooter)
    })
  },
  enhanceApp({ app }) {
    app.component('HeroSection', HeroSection)
    app.component('BehaviorExampleSection', BehaviorExampleSection)
    app.component('GovernanceLoopSection', GovernanceLoopSection)
    app.component('BoundarySection', BoundarySection)
    app.component('UseCasesSection', UseCasesSection)
    app.component('CompoundingSection', CompoundingSection)
    app.component('InstallSection', InstallSection)
    app.component('ThinkingLogCard', ThinkingLogCard)
    app.component('ClosingSection', ClosingSection)
    app.component('InstallGuide', InstallGuide)
    app.component('DownloadPage', DownloadPage)
  }
}
