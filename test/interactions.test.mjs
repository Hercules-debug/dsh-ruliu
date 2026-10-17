/** 审批 / 提问在如流这边的渲染与解析：离线自测，不碰网络。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAnswers, buildApprovalOutcome, parseAnswerInput, renderApproval, renderQuestions,
} from '../lib/interactions.mjs'

test('审批消息带工具名、理由和两个短编号', () => {
  const text = renderApproval({ toolName: 'bash', reason: '写工作区外的文件' })
  assert.match(text, /需要审批/u)
  assert.match(text, /bash/u)
  assert.match(text, /写工作区外的文件/u)
  assert.match(text, /\/1 允许一次/u)
  assert.match(text, /\/2 拒绝/u)
})

test('问题渲染：单题多选、多选题按顺序编号、无选项时提示回文字', () => {
  const single = renderQuestions([{
    id: 'q1', question: '用哪个方案？', options: [{ label: '方案 A', description: '快' }, { label: '方案 B' }],
  }])
  assert.match(single, /用哪个方案？/u)
  assert.match(single, /\/1 方案 A —— 快/u)
  assert.match(single, /\/2 方案 B/u)

  const multi = renderQuestions([
    { id: 'q1', question: '先做哪个？', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '什么时候？', options: [{ label: '现在' }, { label: '稍后' }] },
  ])
  assert.match(multi, /按顺序回编号/u)
  assert.match(multi, /1\. 先做哪个？/u)
  assert.match(multi, /2\. 什么时候？/u)

  const open = renderQuestions([{ id: 'q1', question: '项目叫什么？' }])
  assert.match(open, /直接回文字即可/u)
})

test('解析短编号：/1、/1 2、/1,3 认；裸 1 和别的命令不认', () => {
  assert.deepEqual(parseAnswerInput('/1'), { picked: [[1]] })
  assert.deepEqual(parseAnswerInput('/1 2'), { picked: [[1], [2]] })
  assert.deepEqual(parseAnswerInput('/1,3'), { picked: [[1, 3]] })
  assert.deepEqual(parseAnswerInput('/1,3 2'), { picked: [[1, 3], [2]] })
  // 裸数字/其它命令不是答案：交给正常流程
  assert.deepEqual(parseAnswerInput('1'), { text: '1' })
  assert.deepEqual(parseAnswerInput('/list'), { text: '/list' })
  assert.deepEqual(parseAnswerInput('/0'), { text: '/0' })
})

test('组装答案：编号走 selected，文字走 custom', () => {
  const questions = [
    { id: 'q1', question: '先做哪个？', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '什么时候？', options: [{ label: '现在' }, { label: '稍后' }] },
  ]
  assert.deepEqual(buildAnswers(questions, { picked: [[2], [1]] }), [
    { id: 'q1', selected: ['B'] },
    { id: 'q2', selected: ['现在'] },
  ])
  // 编号数量对不上 → 答不出来
  assert.equal(buildAnswers(questions, { picked: [[1]] }), undefined)
  // 越界的编号被丢掉，不编造选项
  assert.deepEqual(buildAnswers([questions[0]], { picked: [[9]] }), [{ id: 'q1', selected: [] }])
  assert.deepEqual(buildAnswers([{ id: 'q3', question: '项目叫什么？' }], { text: '如流桥' }), [
    { id: 'q3', selected: [], custom: '如流桥' },
  ])
})

test('审批结果：/1 允许一次，其余拒绝，没答返回 undefined', () => {
  assert.equal(buildApprovalOutcome([[1]]), 'allowed-once')
  assert.equal(buildApprovalOutcome([[2]]), 'rejected')
  assert.equal(buildApprovalOutcome([[7]]), 'rejected')
  assert.equal(buildApprovalOutcome(undefined), undefined)
  assert.equal(buildApprovalOutcome([]), undefined)
})
