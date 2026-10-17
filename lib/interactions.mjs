/**
 * 审批 / 提问在如流这边的渲染与解析（纯函数，便于离线测试）。
 *
 * 输入统一用短编号：`/1`、`/2` …… 多个问题时按顺序 `/1 2`，多选 `/1,3`；
 * 没有选项的问题直接回文字。
 *
 * @module dsh-ruliu/lib/interactions
 */

/** 审批的两个编号（就两个，短到不用想）。 */
export const APPROVAL_CHOICES = Object.freeze(['允许一次', '拒绝'])

/**
 * 渲染一条审批请求。
 * @param request - { toolName, reason }。
 * @returns 待答消息文本。
 */
export function renderApproval(request = {}) {
  const toolName = String(request.toolName ?? '(未知工具)')
  const reason = String(request.reason ?? '').trim()
  return [
    '⚠️ **需要审批**',
    '',
    `工具：\`${toolName}\``,
    ...(reason === '' ? [] : [`理由：${reason}`]),
    '',
    ...APPROVAL_CHOICES.map((label, index) => `/${index + 1} ${label}`),
  ].join('\n')
}

/**
 * 渲染模型的问题（可能一批多个）。
 * @param questions - AskUserQuestionItem[]。
 * @returns 待答消息文本。
 */
export function renderQuestions(questions) {
  const items = Array.isArray(questions) ? questions : []
  const lines = ['❓ **需要你选一下**', '']
  items.forEach((question, index) => {
    const title = String(question?.question ?? '(未命名问题)')
    lines.push(items.length > 1 ? `${index + 1}. ${title}` : title)
    const detail = String(question?.detail ?? '').trim()
    if (detail !== '') lines.push(detail)
    const options = Array.isArray(question?.options) ? question.options : []
    options.forEach((option, optionIndex) => {
      const description = String(option?.description ?? '').trim()
      lines.push(`/${optionIndex + 1} ${String(option?.label ?? '')}${description === '' ? '' : ` —— ${description}`}`)
    })
    if (options.length === 0) lines.push('（这题没有选项，直接回文字即可）')
    lines.push('')
  })
  if (items.length > 1) lines.push('按顺序回编号，例如 `/1 2`')
  else if (items[0]?.multiSelect === true) lines.push('可多选，例如 `/1,3`')
  return lines.join('\n').trimEnd()
}

/**
 * 解析用户回的短编号。
 *
 * 只认「以 / 开头的纯编号」：`/1`、`/2`、`/1 2`、`/1,3`。裸的 `1` 不认 ——
 * 那可能是正常聊天内容；`/0` 这种不合法编号也不认，按普通文本返回。
 * @param input - 已 trim 的消息文本。
 * @returns { picked } 或 { text }。
 */
export function parseAnswerInput(input) {
  const text = String(input ?? '').trim()
  const numbered = /^\/(\d+(?:,\d+)*(?:\s+\d+(?:,\d+)*)*)$/u.exec(text)
  if (numbered !== null) {
    const picked = numbered[1].trim().split(/\s+/u).map((token) => token.split(',').map((part) => Number.parseInt(part, 10)))
    if (picked.every((group) => group.every((value) => Number.isInteger(value) && value > 0))) return { picked }
  }
  return { text }
}

/**
 * 把用户的选择组装成 DSH 的答案批次。
 * @param questions - 原问题数组。
 * @param answer - { picked } 或 { text }。
 * @returns 答案数组；答不出来返回 undefined。
 */
export function buildAnswers(questions, answer = {}) {
  const items = Array.isArray(questions) ? questions : []
  if (typeof answer.text === 'string') {
    // 文字回答：统一走 custom（无选项的问题只能这样答；有选项的也允许"其它"）
    return items.map((question) => ({ id: String(question?.id ?? ''), selected: [], custom: answer.text }))
  }
  const picked = answer.picked
  if (!Array.isArray(picked) || picked.length !== items.length) return undefined
  return items.map((question, index) => {
    const options = Array.isArray(question?.options) ? question.options : []
    const selected = (picked[index] ?? [])
      .map((position) => options[position - 1])
      .filter((option) => option !== undefined)
      .map((option) => String(option?.label ?? ''))
    return { id: String(question?.id ?? ''), selected }
  })
}

/**
 * 审批编号 → DSH 结果。只有 `/1` 是允许。
 * @param picked - parseAnswerInput 的结果。
 * @returns ApprovalOutcome 或 undefined（没答）。
 */
export function buildApprovalOutcome(picked) {
  const choice = Array.isArray(picked) ? picked[0]?.[0] : undefined
  if (choice === undefined) return undefined
  return choice === 1 ? 'allowed-once' : 'rejected'
}
