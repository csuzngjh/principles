import DefaultTheme from 'vitepress/theme'
import './custom.css'
import HeroSection from './components/HeroSection.vue'
import BehaviorExampleSection from './components/BehaviorExampleSection.vue'
import GovernanceLoopSection from './components/GovernanceLoopSection.vue'
import MottoSection from './components/MottoSection.vue'
import UseCasesSection from './components/UseCasesSection.vue'
import InstallSection from './components/InstallSection.vue'
import ThinkingLogCard from './components/ThinkingLogCard.vue'
import InstallGuide from './components/InstallGuide.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HeroSection', HeroSection)
    app.component('BehaviorExampleSection', BehaviorExampleSection)
    app.component('GovernanceLoopSection', GovernanceLoopSection)
    app.component('MottoSection', MottoSection)
    app.component('UseCasesSection', UseCasesSection)
    app.component('InstallSection', InstallSection)
    app.component('ThinkingLogCard', ThinkingLogCard)
    app.component('InstallGuide', InstallGuide)
  }
}
