import DefaultTheme from 'vitepress/theme'
import './custom.css'
import HeroSection from './components/HeroSection.vue'
import ValueProposition from './components/ValueProposition.vue'
import AgentContrast from './components/AgentContrast.vue'
import SystemPipeline from './components/SystemPipeline.vue'
import EvolutionMenu from './components/EvolutionMenu.vue'
import ThinkingLogCard from './components/ThinkingLogCard.vue'
import MottoSection from './components/MottoSection.vue'
import QuickInstallCard from './components/QuickInstallCard.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HeroSection', HeroSection)
    app.component('ValueProposition', ValueProposition)
    app.component('AgentContrast', AgentContrast)
    app.component('SystemPipeline', SystemPipeline)
    app.component('EvolutionMenu', EvolutionMenu)
    app.component('ThinkingLogCard', ThinkingLogCard)
    app.component('MottoSection', MottoSection)
    app.component('QuickInstallCard', QuickInstallCard)
  }
}
