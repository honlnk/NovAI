import type { Component } from 'vue'
import {
  Calendar,
  Circle,
  CircleDot,
  ClipboardList,
  Diamond,
  FileText,
  FoldVertical,
  GitBranch,
  Globe,
  Info,
  Library,
  MapPin,
  Scroll,
  TriangleAlert,
  User,
  X,
} from 'lucide-vue-next'

/**
 * 受控语义图标注册表（交互优化计划 §9）。
 *
 * 界面图标一律通过 AppIcon 按名称使用这里显式引入的 Lucide 线性图形：
 * - 新增图标必须先在此按名称显式引入并登记，禁止调用方自行拼接 SVG 字符串；
 * - 不做全量注册、不运行时远程加载；
 * - 品牌 logo 与 GitHub 仓库图标保留专用手绘 SVG，不进本表。
 */
export const APP_ICONS = {
  user: User,
  'map-pin': MapPin,
  diamond: Diamond,
  calendar: Calendar,
  'git-branch': GitBranch,
  globe: Globe,
  'file-text': FileText,
  'clipboard-list': ClipboardList,
  library: Library,
  scroll: Scroll,
  'fold-vertical': FoldVertical,
  info: Info,
  circle: Circle,
  'circle-dot': CircleDot,
  x: X,
  'triangle-alert': TriangleAlert,
} as const satisfies Record<string, Component>

export type AppIconName = keyof typeof APP_ICONS
