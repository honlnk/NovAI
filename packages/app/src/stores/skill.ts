import { ref } from 'vue'
import { defineStore } from 'pinia'

import {
  createBlankSkill,
  deleteSkill,
  importSkills,
  listSkills,
} from '@novai/core/services/skill-service'
import type { BrokenSkillView, SkillView } from '@novai/core/services/types'

import { useProjectStore } from './project'

/**
 * 技能 store（技能包 UI/UX 施工计划 §3.2）：技能分类面板的唯一数据入口。
 * 读 listSkills；删除（作者手动操作，决策 9）在 store 执行——调服务后刷文件树
 * 与技能列表，结果回填给 SkillList 的确认对话框。
 */
export const useSkillStore = defineStore('skill', () => {
  const skills = ref<SkillView[]>([])
  const broken = ref<BrokenSkillView[]>([])
  const isLoading = ref(false)

  /** 上次成功加载的项目 id：同项目幂等（分类来回切换不重复扫描）。 */
  let loadedProjectId: string | null = null
  /** 加载代次：晚到的旧请求（切换/复位后返回）不得覆盖新现场。 */
  let loadGeneration = 0
  /** 磁盘可能已变（AI 经文件工具改动技能）：下次 refresh 必重算。 */
  let isStale = false

  /**
   * 加载技能列表。force = false 时同项目且未标脏则幂等；force = true 强制重算
   * （刷新按钮、写操作后）。
   */
  async function refresh(projectId: string, force = false): Promise<void> {
    if (!force && !isStale && loadedProjectId === projectId) {
      return
    }
    const generation = ++loadGeneration
    isLoading.value = true
    try {
      const view = await listSkills(projectId)
      if (generation !== loadGeneration) {
        return
      }
      skills.value = view.skills
      broken.value = view.broken
      loadedProjectId = projectId
      isStale = false
    } finally {
      if (generation === loadGeneration) {
        isLoading.value = false
      }
    }
  }

  /**
   * 文件树变化标脏（§3.2 刷新通道）：AI 通过文件工具改动技能后，下次进入技能
   * 分类或点刷新时重算。O(1) 无扫描成本，高频文件树变化安全。
   */
  function markStale(): void {
    if (loadedProjectId !== null) {
      isStale = true
    }
  }

  /** 切换/关闭项目时复位（旧项目技能不进新项目视图，在途请求作废）。 */
  function reset(): void {
    loadGeneration++
    skills.value = []
    broken.value = []
    isLoading.value = false
    loadedProjectId = null
    isStale = false
  }

  /**
   * 删除技能（决策 9：作者手动整夹删除，二次确认在 SkillList 内完成）：
   * 删盘 → 刷文件树（同一刷新通道）→ 强制重算技能列表；失败也重算对齐磁盘
   * （技能可能已被 AI 先删）。返回错误供确认对话框显示，不抛出。
   */
  async function removeSkill(projectId: string, name: string): Promise<Error | null> {
    try {
      await deleteSkill(projectId, name)
    } catch (error) {
      void refresh(projectId, true).catch(() => {})
      return error instanceof Error ? error : new Error('删除失败')
    }
    await flushAfterWrite(projectId)
    return null
  }

  /**
   * 新建空白技能（§3.4 模板）：成功后刷文件树与技能列表，返回新技能的
   * SKILL.md 路径（调用方随即在右侧打开进入编辑）；重名/非法名返回错误。
   */
  async function createBlank(
    projectId: string,
    folderName: string,
  ): Promise<{ skillFilePath: string } | Error> {
    try {
      await createBlankSkill(projectId, folderName)
    } catch (error) {
      return error instanceof Error ? error : new Error('新建技能失败')
    }
    await flushAfterWrite(projectId)
    return { skillFilePath: `skills/${folderName.trim()}/SKILL.md` }
  }

  /**
   * 导入选中候选（§3.1 importSkills 的 store 接线）：复制 → 刷文件树与技能
   * 列表，返回逐个成功/跳过结果（对话框结果态展示）。扫描（scanImportSource，
   * 只读）由组件直调服务。
   */
  async function importSkillsFrom(
    projectId: string,
    sourceHandle: FileSystemDirectoryHandle,
    folderNames: string[],
  ) {
    const outcome = await importSkills(projectId, sourceHandle, folderNames)
    await flushAfterWrite(projectId)
    return outcome
  }

  /** 写操作后的统一刷新通道：文件树 + 技能列表（§3.1）。 */
  async function flushAfterWrite(projectId: string): Promise<void> {
    const projectStore = useProjectStore()
    await Promise.all([
      projectStore.refreshTree().catch(() => {}),
      refresh(projectId, true),
    ])
  }

  return { skills, broken, isLoading, refresh, markStale, removeSkill, createBlank, importSkillsFrom, reset }
})
