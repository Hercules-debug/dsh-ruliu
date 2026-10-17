import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let descriptor
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(value) { descriptor = value } } },
})
assert.equal(descriptor.id, 'dsh-ruliu')
const fakeReact = { createElement: () => null, useSyncExternalStore: () => ({}), useState: () => ['', () => {}] }
const fakePrimitives = {
  SettingsForm: 'SettingsForm', SettingsSecretField: 'SettingsSecretField', SettingsValueField: 'SettingsValueField', Checkbox: 'Checkbox', Button: 'Button',
}
const client = descriptor.factory((specifier) => specifier === 'react' ? fakeReact : fakePrimitives)

test('client bundle registers a real settings section', () => {
  assert.deepEqual([...client.inject], ['slots', 'configForms', 'remote', 'remote.settings'])
  assert.equal(typeof client.apply, 'function')
})

test('blank secrets are omitted while changed secrets are write-only mutations', () => {
  const base = { value: { enabled: false, agentId: 7, apiHost: 'https://api.im.baidu.com' } }
  const ops = client.buildMutation(base, { appSecret: '', appKey: 'new-key', agentId: '8' })
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), [
    { op: 'set', path: ['agentId'], value: 8 },
    { op: 'set', path: ['appKey'], value: 'new-key' },
  ])
})

test('clearing the optional robot id unsets it instead of writing an empty value', () => {
  const base = { value: { enabled: true, agentId: 7 } }
  assert.deepEqual(JSON.parse(JSON.stringify(client.buildMutation(base, { agentId: '  ' }))), [
    { op: 'unset', path: ['agentId'] },
  ])
  // 本来就没有值时不重复 unset
  assert.deepEqual(JSON.parse(JSON.stringify(client.buildMutation({ value: { enabled: true } }, { agentId: '' }))), [])
})

test('callback URL uses the configured route and rejects unsafe routes', () => {
  assert.equal(client.callbackURL('http://10.0.0.2:8080', '/dsh-ruliu/webhook'), 'http://10.0.0.2:8080/dsh-ruliu/webhook')
  assert.equal(client.callbackURL('http://10.0.0.2:8080', '//other.example'), '')
})
