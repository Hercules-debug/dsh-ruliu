import assert from 'node:assert/strict'
import test from 'node:test'
import { createTransportLifecycle } from '../lib/transport-lifecycle.mjs'

test('saves replace routes and listeners in order, and disabling removes them', async () => {
  let config = { enabled: false, agentId: 1 }
  const events = []
  const lifecycle = createTransportLifecycle({
    read: () => config,
    report: (error) => { throw error },
    mount: (snapshot) => {
      events.push(`mount:${snapshot.agentId}`)
      return { await: async () => {}, dispose: async () => { await Promise.resolve(); events.push(`dispose:${snapshot.agentId}`) } }
    },
  })
  await lifecycle.refresh()
  assert.deepEqual(events, [])
  config = { enabled: true, agentId: 1 }
  await lifecycle.refresh()
  config = { enabled: true, agentId: 2 }
  const first = lifecycle.refresh()
  config = { enabled: true, agentId: 3 }
  const second = lifecycle.refresh()
  await Promise.all([first, second])
  config = { enabled: false }
  await lifecycle.refresh()
  assert.deepEqual(events, ['mount:1', 'dispose:1', 'mount:2', 'dispose:2', 'mount:3', 'dispose:3'])
  await lifecycle.dispose()
})

test('disposal cancels queued mounts and removes the active transport once', async () => {
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const events = []
  const lifecycle = createTransportLifecycle({
    read: () => ({ enabled: true }), report: () => {},
    mount: () => { events.push('mount'); return { await: () => barrier, dispose: async () => { events.push('dispose') } } },
  })
  const first = lifecycle.refresh()
  await Promise.resolve()
  const pending = lifecycle.refresh()
  const closing = lifecycle.dispose()
  release()
  await Promise.all([first, pending, closing])
  await lifecycle.dispose()
  assert.deepEqual(events, ['mount', 'dispose'])
})

test('a failed transport mount is cleaned up and the next save recovers', async () => {
  let fail = true
  const events = []
  const lifecycle = createTransportLifecycle({
    read: () => ({ enabled: true }), report: () => events.push('reported'),
    mount: () => ({ await: async () => { if (fail) throw new Error('mount failed') }, dispose: async () => events.push('dispose') }),
  })
  await assert.rejects(lifecycle.refresh(), /mount failed/)
  fail = false
  await lifecycle.refresh()
  await lifecycle.dispose()
  assert.deepEqual(events, ['reported', 'dispose', 'dispose'])
})
