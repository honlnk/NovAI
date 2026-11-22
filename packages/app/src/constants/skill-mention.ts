/**
 * `#技能` 点名（技能包 UI/UX 施工计划 §3.3，提示式——决策 1）。
 *
 * 选中技能后输入框留下 `#技能名` 标签；发送时命中的标签汇总为一句追加到发给
 * 模型的文本末尾（斜杠展开结果之后），要求先用 LoadSkill 加载再完成请求。
 * 气泡/队列/自动标题仍显示原草稿（displayLabel 显示/指令分离，core 不改）。
 *
 * token 规则与 text-ref 的 scanTextRefs 同口径：`#` 在行首或空白后，name 为
 * 连续非空白段（不含 @ / #），token 后紧跟空白或结尾才算完整——`# 标题` 因
 * `#` 后紧跟空格天然不触发（Markdown 标题安全）；名单外的 `#X` 不展开不着色。
 */

/** token 扫描（collect 与 text-ref 高亮共用口径；此处独立实现避免反向依赖） */
const SKILL_TOKEN_RE = /(^|\s)#([^\s@/#]+)/g

/** 收集文本中命中技能名单的点名：同名去重，保持出现顺序。 */
export function collectSkillMentions(text: string, skillNames: readonly string[]): string[] {
  const nameSet = new Set(skillNames)
  const matched: string[] = []
  SKILL_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SKILL_TOKEN_RE.exec(text)) !== null) {
    const name = match[2]!
    const end = match.index + match[0].length
    if (!/^(?:\s|$)/.test(text.slice(end))) continue
    if (!nameSet.has(name) || matched.includes(name)) continue
    matched.push(name)
  }
  return matched
}

/**
 * 发送展开：命中的 #技能名 汇总为一句追加到文本末尾；无命中原样返回。
 * 与斜杠命令可同时存在——调用方先做斜杠展开，本函数追加在其结果之后。
 */
export function expandSkillMentions(text: string, skillNames: readonly string[]): string {
  const matched = collectSkillMentions(text, skillNames)
  if (matched.length === 0) {
    return text
  }
  return `${text}\n\n（作者点名使用技能：${matched.join('、')}。请先用 LoadSkill 逐个加载，再按技能方法完成本条请求。）`
}
