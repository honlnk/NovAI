import type { ElementManagerPermissionPreset, PermissionPreset } from '@novai/core/types/project'

/**
 * 写工具权限五档（与 core/agent/permission.ts 的判定规则一一对应）。
 * 设置页下拉与聊天输入区档位选择器共用这一份定义，避免两处文案漂移。
 */
export const PERMISSION_PRESET_OPTIONS = [
  { value: 'review', label: '仅审阅', hint: '任何修改都弹卡确认，批一次改一次' },
  { value: 'chapter', label: '章节内容', hint: '改 chapters/ 已有章节正文免确认，其余都问' },
  { value: 'material', label: '素材内容', hint: '改 elements/ 已有要素文件免确认，其余都问' },
  { value: 'chapter-material', label: '章节 + 素材', hint: '改章节与素材免确认，新建/删除/重命名与提示词修改都问' },
  { value: 'full', label: '完全访问', hint: '所有允许的修改都免确认（.novel/ 与项目配置仍永远禁改）' },
] as const satisfies ReadonlyArray<{ value: PermissionPreset; label: string; hint: string }>

/**
 * 要素管理员档位三档（Phase 2 计划 D3 裁剪）：要素管理员被路径闸限制只能写 elements/，
 * 五档中「章节档」对它效果等同「仅审阅」，故裁剪。文案按要素管理员口径描述。
 */
export const ELEMENT_MANAGER_PRESET_OPTIONS = [
  { value: 'review', label: '仅审阅', hint: '每次写要素文件都弹卡确认' },
  { value: 'material', label: '素材静默', hint: '修改已有要素正文免确认；新建文件仍弹卡' },
  { value: 'full', label: '完全静默', hint: '所有写入免确认（路径闸仍限 elements/）' },
] as const satisfies ReadonlyArray<{ value: ElementManagerPermissionPreset; label: string; hint: string }>

export const DEFAULT_PERMISSION_PRESET_LABEL = '章节 + 素材'

/** 档位显示名；未知值（理论不可能，normalize 已兜底）回退默认档名。 */
export function permissionPresetLabel(preset: PermissionPreset | undefined): string {
  return PERMISSION_PRESET_OPTIONS.find((option) => option.value === preset)?.label
    ?? DEFAULT_PERMISSION_PRESET_LABEL
}
