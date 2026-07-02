import { computed } from 'vue'
import { useData } from 'vitepress'

export function useIsZh() {
  const { lang } = useData()
  return computed(() => lang.value === 'zh-CN')
}
