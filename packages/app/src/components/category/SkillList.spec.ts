// @vitest-environment happy-dom
/**
 * 技能分类面板组件测试（技能包 UI/UX 施工计划 阶段 1 门禁）：
 * broken/warning 渲染、脚本不可点、删除二次确认、搜索过滤与空状态。
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrokenSkillView, SkillView } from '@novai/core/services/types'
import SkillList from './SkillList.vue'
import { useSkillStore } from '../../stores/skill'

/* ---------- 服务 mock（store 动作不真写盘） ---------- */

vi.mock('@novai/core/services/skill-service', () => ({
  deleteSkill: vi.fn(),
  listSkills: vi.fn(async () => ({ skills: [], broken: [] })),
}))

/* ---------- 工厂 ---------- */

function skill(overrides: Partial<SkillView> = {}): SkillView {
  return {
    name: '去AI味',
    description: '润色正文，去掉机器味',
    directory: 'skills/去AI味',
    skillFilePath: 'skills/去AI味/SKILL.md',
    files: [],
    warnings: [],
    ...overrides,
  }
}

function broken(overrides: Partial<BrokenSkillView> = {}): BrokenSkillView {
  return {
    name: '坏技能',
    directory: 'skills/坏技能',
    reason: '缺少描述，AI 看不到这个技能。打开 SKILL.md 补上 description 即可',
    code: 'skill_missing_description',
    skillFilePath: 'skills/坏技能/SKILL.md',
    ...overrides,
  }
}

function mountList(props: Partial<InstanceType<typeof SkillList>['$props']> = {}) {
  return mount(SkillList, {
    props: {
      projectId: 'p1',
      skills: [],
      broken: [],
      isLoading: false,
      ...props,
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('SkillList 技能行与文件清单', () => {
  it('技能行显示名称、描述与附属文件数；点击展开清单，SKILL.md 为首项，点击走文件详情', async () => {
    const wrapper = mountList({
      skills: [
        skill({
          files: [
            { path: 'references/词表.md', size: 1024, kind: 'text' },
          ],
        }),
      ],
    })

    const row = wrapper.find('[data-testid="skill-row"]')
    expect(row.text()).toContain('去AI味')
    expect(row.text()).toContain('润色正文，去掉机器味')
    expect(row.text()).toContain('1 个附属文件')

    expect(wrapper.find('[data-testid="skill-file-list"]').exists()).toBe(false)
    await row.trigger('click')
    expect(wrapper.find('[data-testid="skill-file-list"]').exists()).toBe(true)

    const entries = wrapper.findAll('[data-testid="skill-file-entry"]')
    expect(entries).toHaveLength(2)
    expect(entries[0].text()).toContain('SKILL.md')

    await entries[0].trigger('click')
    expect(wrapper.emitted('selectFile')).toEqual([['skills/去AI味/SKILL.md']])
    // 附属文本文件点击带完整路径
    await entries[1].trigger('click')
    expect(wrapper.emitted('selectFile')).toEqual([
      ['skills/去AI味/SKILL.md'],
      ['skills/去AI味/references/词表.md'],
    ])
  })

  it('warning 级诊断在技能行上显示提示标记（决策 8）', () => {
    const wrapper = mountList({
      skills: [
        skill({ warnings: [{ code: 'skill_name_mismatch', message: '名字不一致，以文件夹名为准' }] }),
      ],
    })

    const mark = wrapper.find('[data-testid="skill-warning-mark"]')
    expect(mark.exists()).toBe(true)
    expect(mark.attributes('aria-label')).toContain('名字不一致')
  })

  it('脚本与不支持文件灰显不可点、标注已忽略（决策 7）', async () => {
    const wrapper = mountList({
      skills: [
        skill({
          files: [
            { path: 'scripts/run.py', size: 10, kind: 'script' },
            { path: 'cover.png', size: 20, kind: 'unsupported' },
          ],
        }),
      ],
    })

    await wrapper.find('[data-testid="skill-row"]').trigger('click')

    const ignored = wrapper.findAll('[data-testid="skill-file-ignored"]')
    expect(ignored).toHaveLength(2)
    expect(ignored[0].text()).toContain('已忽略：不执行脚本')
    expect(ignored[1].text()).toContain('不支持的文件类型')
    // 可点开的只有 SKILL.md
    expect(wrapper.findAll('[data-testid="skill-file-entry"]')).toHaveLength(1)
  })
})

describe('SkillList broken 技能', () => {
  it('末尾灰显、行内人话原因；打开 SKILL.md 修复走文件详情', () => {
    const wrapper = mountList({
      skills: [skill()],
      broken: [broken()],
    })

    const brokenList = wrapper.find('[data-testid="skill-broken-list"]')
    expect(brokenList.exists()).toBe(true)
    expect(brokenList.text()).toContain('坏技能')
    expect(wrapper.find('[data-testid="skill-broken-reason"]').text()).toContain('补上 description')

    return wrapper.find('[data-testid="skill-broken-fix"]').trigger('click').then(() => {
      expect(wrapper.emitted('selectFile')).toEqual([['skills/坏技能/SKILL.md']])
    })
  })

  it('broken 技能可从行内删除（同样走二次确认）', async () => {
    const wrapper = mountList({ broken: [broken()] })

    await wrapper.find('[data-testid="skill-broken-delete"]').trigger('click')
    expect(wrapper.find('[data-testid="skill-delete-dialog"]').exists()).toBe(true)
  })
})

describe('SkillList 删除二次确认（决策 9）', () => {
  it('确认对话框写明整夹删除不可撤销；确认后调 store 删除并关闭', async () => {
    const store = useSkillStore()
    const removeSkill = vi.spyOn(store, 'removeSkill').mockResolvedValue(null)

    const wrapper = mountList({ skills: [skill()] })
    await wrapper.find('[data-testid="skill-delete-button"]').trigger('click')

    const dialog = wrapper.find('[data-testid="skill-delete-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('skills/去AI味/')
    expect(dialog.text()).toContain('不可撤销')

    await wrapper.find('[data-testid="skill-delete-confirm"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="skill-delete-dialog"]').exists()).toBe(false)
    })
    expect(removeSkill).toHaveBeenCalledWith('p1', '去AI味')
  })

  it('删除失败：错误留在对话框内，不关闭', async () => {
    const store = useSkillStore()
    vi.spyOn(store, 'removeSkill').mockResolvedValue(new Error('技能不存在，可能已被删除'))

    const wrapper = mountList({ skills: [skill()] })
    await wrapper.find('[data-testid="skill-delete-button"]').trigger('click')
    await wrapper.find('[data-testid="skill-delete-confirm"]').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="skill-delete-error"]').text()).toContain('技能不存在')
    })
    expect(wrapper.find('[data-testid="skill-delete-dialog"]').exists()).toBe(true)
  })
})

describe('SkillList 搜索与空状态（决策 11）', () => {
  it('技能不超过 8 个不显示搜索框；超过 8 个显示并按名称与描述过滤', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => skill({ name: `技能${i}`, directory: `skills/技能${i}`, skillFilePath: `skills/技能${i}/SKILL.md` }))
    const few = mountList({ skills: eight })
    expect(few.find('[data-testid="skill-search-input"]').exists()).toBe(false)

    const nine = [...eight, skill({ name: '文风仿写', description: '仿写指定文风' })]
    const many = mountList({ skills: nine })
    expect(many.find('[data-testid="skill-search-input"]').exists()).toBe(true)
    expect(many.findAll('[data-testid="skill-row"]')).toHaveLength(9)

    await many.find('[data-testid="skill-search-input"]').setValue('仿写')
    expect(many.findAll('[data-testid="skill-row"]')).toHaveLength(1)
  })

  it('空状态说明技能是什么与 #技能名 用法', () => {
    const wrapper = mountList()

    const empty = wrapper.find('[data-testid="skill-empty-state"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('#技能名')
  })
})
