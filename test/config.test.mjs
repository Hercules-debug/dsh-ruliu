import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, validateConfiguration } from '../lib/config.mjs'

const valid = { enabled: true, appKey: 'example-app', appSecret: 'example-secret', agentId: 123, checkToken: 'example-token', encodingAESKey: Buffer.from('0123456789abcdef').toString('base64url') }

test('fresh installation has a disabled, editable settings snapshot', () => {
  const config = Config({}).get()
  assert.equal(config.enabled, false)
  assert.equal(config.apiHost, 'https://api.im.baidu.com')
  assert.equal(config.webhookPath, '/dsh-ruliu/webhook')
  validateConfiguration(config)
  const serialized = Config.toJSON()
  const schema = serialized.refs[serialized.uid]
  assert.equal(schema.meta.volatile, true)
  for (const field of ['appKey', 'appSecret', 'checkToken', 'encodingAESKey']) assert.equal(serialized.refs[schema.dict[field]].meta.role, 'secret')
})

test('existing profile configuration remains compatible', () => {
  const config = Config({ ...valid, cwd: '/workspace', stateDir: '/state', agentPreset: 'default', msgType: 'md' }).get()
  validateConfiguration(config)
  assert.equal(config.appSecret, valid.appSecret)
  assert.equal(config.agentPreset, 'default')
  assert.equal(config.stateDir, '/state')
})

test('enabled channel rejects missing credentials but accepts an omitted robot id', () => {
  for (const field of ['appKey', 'appSecret', 'checkToken', 'encodingAESKey']) {
    const config = Config({ ...valid, [field]: '' }).get()
    assert.throws(() => validateConfiguration(config), /启用如流前/)
  }
  // 机器人 ID 可选：留空（unset）时照常启用，发送路径不带 agentid
  const withoutAgent = Config({ ...valid, agentId: undefined }).get()
  assert.equal(withoutAgent.agentId, undefined)
  validateConfiguration(withoutAgent)
  // 填了就必须是正整数（schema 先卡一道，validateConfiguration 是最后一道防线）
  const full = { ...valid, apiHost: 'https://api.im.baidu.com', webhookPath: '/dsh-ruliu/webhook' }
  assert.throws(() => validateConfiguration({ ...full, agentId: 0 }), /Agent ID/)
  for (const agentId of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => Config({ ...valid, agentId }))
})

test('invalid callback paths and endpoints fail without echoing submitted values', () => {
  for (const webhookPath of ['relative', '//example.com/path', '/path?token=secret', '/path#fragment', '/has space']) {
    assert.throws(() => validateConfiguration(Config({ ...valid, webhookPath }).get()), /回调路径/)
  }
  for (const apiHost of ['file:///tmp/secret', 'not-a-url', 'https://user:secret@example.com']) {
    assert.throws(() => validateConfiguration(Config({ ...valid, apiHost }).get()), (error) => !error.message.includes('secret') && /接口地址/.test(error.message))
  }
  assert.throws(() => validateConfiguration(Config({ ...valid, encodingAESKey: 'invalid' }).get()), /AES Key/)
})
