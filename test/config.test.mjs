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

test('enabled channel rejects missing credentials and invalid robot ids', () => {
  for (const field of ['appKey', 'appSecret', 'checkToken', 'encodingAESKey']) {
    const config = Config({ ...valid, [field]: '' }).get()
    assert.throws(() => validateConfiguration(config), /启用如流前/)
  }
  assert.throws(() => validateConfiguration(Config({ ...valid, agentId: undefined }).get()), /Agent ID/)
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
