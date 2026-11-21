/**
 * 章节目录的接线层（作者字段控制权计划阶段 1）。
 *
 * 目录从项目文件树纯派生（与章节侧栏同一事实源，树刷新即更新，不引入第二份
 * 章节事实源）；真实新建走 core chapter-service（新建语义落盘 + 运行时树更新），
 * 完成后刷新应用侧文件树。跨项目晚到结果不回填新现场（计划 §三.4）。
 */
import { computed } from 'vue'

import { useProjectStore } from '../stores/project'
import {
  ChapterNumberTakenError,
  InvalidChapterNumberError,
  buildChapterCatalog,
  createProjectChapter,
  suggestNextChapterNumber,
} from '@novai/core/services/chapter-service'
import type { ChapterCreateOutcome } from '../components/card-board/chapter-picker-state'

export function useChapterCatalog() {
  const projectStore = useProjectStore()

  /** 目录随 currentProject.files 响应式重算（树刷新 / 切项目自动跟进）。 */
  const catalog = computed(() => buildChapterCatalog(projectStore.currentProject?.files ?? []))
  const projectId = computed(() => projectStore.currentProject?.id ?? null)
  const entries = computed(() => catalog.value.entries)
  /** 目录是否已随项目载入（未就绪时选择器只显示原始引用，不下「无章节」结论）。 */
  const catalogReady = computed(() => projectStore.currentProject !== null)

  const suggestedNumber = computed(() => suggestNextChapterNumber(catalog.value))

  /**
   * 真实新建空章节。创建与卡片保存是两件独立的事：章节创建成功后即使卡片
   * 取消或保存失败，也不反向删除章节（计划 §三.4 第 4 条）。
   */
  async function createChapter(input: { chapterNumber: number; title: string | null }): Promise<ChapterCreateOutcome> {
    const startedProjectId = projectId.value
    if (!startedProjectId) {
      return { kind: 'failed', message: '未打开项目，无法创建章节' }
    }

    try {
      const result = await createProjectChapter(startedProjectId, input)

      // 跨项目晚到：创建期间已切项目，结果不回填新现场
      if (projectId.value !== startedProjectId) {
        return { kind: 'stale' }
      }

      await projectStore.refreshTree()
      return { kind: 'created', entry: result.entry }
    } catch (error) {
      if (projectId.value !== startedProjectId) {
        return { kind: 'stale' }
      }
      if (error instanceof ChapterNumberTakenError) {
        return { kind: 'number-taken', existing: error.existing }
      }
      if (error instanceof InvalidChapterNumberError) {
        return { kind: 'invalid-number', message: error.message }
      }
      return {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 读取失败重试：刷新文件树（保留选择器当前值与输入由组件负责）。 */
  async function retryLoad(): Promise<void> {
    await projectStore.refreshTree()
  }

  return {
    catalog,
    entries,
    catalogReady,
    projectId,
    suggestedNumber,
    createChapter,
    retryLoad,
  }
}
