import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type WorkspacePanelMode =
  | 'preview'
  | 'generation'
  | 'prompt'
  | 'proofread'
  | 'organize'
  | 'version'

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  const panelMode = ref<WorkspacePanelMode>('preview')
  const selectedFilePath = ref('')

  const panelTitle = computed(() => {
    switch (panelMode.value) {
      case 'generation':
        return '生成预览'
      case 'prompt':
        return '提示词编辑'
      case 'proofread':
        return '校对视图'
      case 'organize':
        return '章节整理'
      case 'version':
        return '版本管理'
      default:
        return '文件预览'
    }
  })

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function setPanelMode(mode: WorkspacePanelMode) {
    panelMode.value = mode
  }

  function selectFile(path: string) {
    selectedFilePath.value = path
    panelMode.value = 'preview'
  }

  return {
    panelMode,
    panelTitle,
    selectedFilePath,
    sidebarCollapsed,
    selectFile,
    setPanelMode,
    toggleSidebar,
  }
})
