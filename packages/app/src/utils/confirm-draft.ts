/**
 * 写入确认面板的人工草稿分支判定（数据安全计划 §3-5「人工草稿与 AI 写入确认分离」）：
 * 按「磁盘探测结果」与「人工草稿」两条信息分别判断——只有「无草稿且磁盘可读」
 * 才能按原流程直接同意；有草稿（无论磁盘是否变化）阻止直接同意，先「保存草稿」
 * 或「保留副本后放弃草稿」再重新校验；磁盘读取失败与文件不存在分开提示，
 * 无法确认安全时默认不能同意。
 */

export type ConfirmDraftBranch =
  /** 无人工草稿：保留现有候选差异与版本复检，可直接同意 */
  | 'none'
  /** 有草稿且磁盘未变（草稿基线 == 当前磁盘）：提示写入不会自动保存草稿，阻止直接同意 */
  | 'draft-clean'
  /** 有草稿且磁盘已变（三方关系：人工基线 / 当前磁盘 / AI 候选）：禁止直接同意 */
  | 'draft-diverged'
  /** 磁盘读取失败（不是不存在）：无法确认安全，默认不能同意 */
  | 'unreadable'
  /** 文件不存在（edit 目标没了 / create 目标被占用）：沿用版本失配出口 */
  | 'missing'

export type DraftProbeInput = {
  /** 磁盘探测结果（probeFile：ok 带 content；missing/unreadable 分开） */
  probe:
    | { kind: 'ok'; content: string }
    | { kind: 'missing' }
    | { kind: 'unreadable' }
  /** 目标路径的人工草稿条目（无草稿 null） */
  draftEntry: { content: string; baseContent: string } | null
  /** create 候选：目标已存在视为 missing（新建语义被占用）；目标不存在是正常空目标 */
  isCreate: boolean
  /** 追加式账本确认（关系账本）：create 目标存在是常态，不算占用 */
  createAppendLedger?: boolean
}

export function resolveConfirmDraftBranch(input: DraftProbeInput): ConfirmDraftBranch {
  const { probe, draftEntry, isCreate } = input

  if (probe.kind === 'unreadable') {
    return 'unreadable'
  }
  if (isCreate) {
    // create 探测到内容即目标被占用（新建不覆盖）；追加式账本（关系/时间线）除外——
    // 目标存在是常态，与 edit 同样按草稿基线比对
    if (probe.kind === 'ok' && !input.createAppendLedger) {
      return 'missing'
    }
    // 目标不存在是新建的正常前提（空目标），不是「文件不存在」失配
    const diskContent = probe.kind === 'ok' ? probe.content : ''
    if (!draftEntry) {
      return 'none'
    }
    return draftEntry.baseContent === diskContent ? 'draft-clean' : 'draft-diverged'
  }
  if (probe.kind === 'missing') {
    return 'missing'
  }
  if (!draftEntry) {
    return 'none'
  }
  // 草稿基线与当前磁盘比对：一致 = 磁盘未变；不一致 = AI（或外部）已写盘
  return draftEntry.baseContent === probe.content ? 'draft-clean' : 'draft-diverged'
}

/**
 * 合成 AI 候选写盘后的全文（有草稿时并列展示「人工草稿 × AI 候选结果」用）：
 * edit 按候选原文→新内容替换（replaceAll 为 false 只替换第一处），create 即候选内容。
 */
export function applyEditCandidate(
  diskContent: string,
  candidate: { kind: 'create'; content: string } | { kind: 'edit'; oldText: string; newText: string; replaceAll?: boolean },
): string {
  if (candidate.kind === 'create') {
    return candidate.content
  }
  const index = diskContent.indexOf(candidate.oldText)
  if (index < 0) {
    // 候选原文已不在（外部分支另行提示）：原样返回，差异展示退化为整篇对比
    return diskContent
  }
  if (candidate.replaceAll === true) {
    return diskContent.split(candidate.oldText).join(candidate.newText)
  }
  return diskContent.slice(0, index) + candidate.newText + diskContent.slice(index + candidate.oldText.length)
}
