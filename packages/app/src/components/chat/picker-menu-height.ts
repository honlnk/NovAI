/**
 * 档位菜单限高（权限档位 / 思考强度两个选择器共用）：
 * 菜单向上弹出、底边贴定位祖先的上沿，能用的高度 = 定位祖先上沿到可视区顶的余量。
 * 定位祖先不一定是按钮外壳——窄屏下选择器根节点是 static，菜单挂到输入区外壳上（见两个选择器的注释），
 * 所以要从菜单自己的 offsetParent 量。视口矮（手机横屏、弹出软键盘）时上方放不下整张菜单，
 * 按视口比例限高仍会伸出顶边，因此量实际余量。
 * 可视区顶取 visualViewport.offsetTop：软键盘只压缩可视区时它是非零值。下限 120px 保证极矮时仍可滚。
 */
export const PICKER_MENU_MAX_HEIGHT = 360
const PICKER_MENU_MIN_HEIGHT = 120
/** 菜单与定位祖先的间距（两个选择器最大 8px）+ 视口顶边留白 */
const PICKER_MENU_TOP_GAP = 12

export function pickerMenuMaxHeight(menu: HTMLElement | null): number {
  const anchorTop = menu?.offsetParent?.getBoundingClientRect().top
  if (anchorTop === undefined) return PICKER_MENU_MAX_HEIGHT
  const viewportTop = window.visualViewport?.offsetTop ?? 0
  return Math.max(
    PICKER_MENU_MIN_HEIGHT,
    Math.min(PICKER_MENU_MAX_HEIGHT, Math.floor(anchorTop - viewportTop - PICKER_MENU_TOP_GAP)),
  )
}
