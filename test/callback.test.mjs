/**
 * 回调注册层离线自测：不碰网络、不读真实网卡 —— fetch / 随机源 / 网卡表全部注入。
 *
 * 依据是官方 SDK 的 RobotApi.updateCallbackUrl：
 *   POST /api/v1/imRobot/updateReCallUrl { recallUrl, receiveMsgState, token, encodingAesKey, enWebSocket }
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveCallbackURL, generateAESKey, generateCheckToken, md5Hex, pickLanIPv4, registerCallback,
} from '../lib/callback.mjs'

test('生成的 token / AESKey 形态符合如流要求', () => {
  assert.match(generateCheckToken(), /^[A-Za-z0-9]{20}$/u)
  const aes = generateAESKey()
  assert.match(aes, /^[A-Za-z0-9_-]{22}$/u)
  assert.equal(Buffer.from(aes, 'base64url').length, 16)
})

test('内网地址选择跳过回环、link-local 与容器网桥', () => {
  const interfaces = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    docker0: [{ family: 'IPv4', internal: false, address: '192.168.5.1' }],
    eth2: [{ family: 'IPv4', internal: false, address: '33.10.80.22' }],
    bond0: [{ family: 'IPv4', internal: false, address: '10.206.116.22' }],
    eth9: [{ family: 'IPv4', internal: false, address: '169.254.1.1' }],
  }
  assert.equal(pickLanIPv4(interfaces), '10.206.116.22')
  assert.equal(pickLanIPv4({}), '')
})

test('回调地址按 显式配置 > 非回环 origin > 内网地址 推导', () => {
  const interfaces = { bond0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }] }
  assert.equal(
    deriveCallbackURL({ publicCallbackUrl: 'http://a.example/hook', webhookPath: '/x', dshWebUrl: 'http://127.0.0.1:8080' }),
    'http://a.example/hook',
  )
  assert.equal(
    deriveCallbackURL({ webhookPath: '/dsh-ruliu/webhook', origin: 'http://10.1.2.3:9000', dshWebUrl: 'http://127.0.0.1:8080' }),
    'http://10.1.2.3:9000/dsh-ruliu/webhook',
  )
  // 浏览器在回环上时，退回内网地址 + DSH_WEB_URL 里的端口
  assert.equal(
    deriveCallbackURL({ webhookPath: '/dsh-ruliu/webhook', origin: 'http://127.0.0.1:8080', dshWebUrl: 'http://127.0.0.1:8080', interfaces }),
    'http://10.0.0.5:8080/dsh-ruliu/webhook',
  )
  assert.equal(deriveCallbackURL({ webhookPath: '/dsh-ruliu/webhook', dshWebUrl: 'http://127.0.0.1:8080', interfaces: {} }), '')
})

test('注册流程先取 token 再调 updateReCallUrl，并把 token/AESKey 一起提交', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/api/v1/auth/app_access_token')) {
      return { ok: true, status: 200, json: async () => ({ code: 'ok', data: { app_access_token: 'at_x' } }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 'ok' }) }
  }
  const result = await registerCallback({
    apiHost: 'http://apiin.im.baidu.com/',
    appKey: 'k',
    appSecret: 's',
    callbackUrl: 'http://10.0.0.5:8080/dsh-ruliu/webhook',
    checkToken: 'tok',
    encodingAESKey: 'aes',
    fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://apiin.im.baidu.com/api/v1/auth/app_access_token')
  assert.deepEqual(JSON.parse(calls[0].init.body), { app_key: 'k', app_secret: md5Hex('s') })
  assert.equal(calls[1].url, 'http://apiin.im.baidu.com/api/v1/imRobot/updateReCallUrl')
  assert.equal(calls[1].init.headers.authorization, 'Bearer-at_x')
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    recallUrl: 'http://10.0.0.5:8080/dsh-ruliu/webhook',
    receiveMsgState: 1,
    token: 'tok',
    encodingAesKey: 'aes',
    enWebSocket: 0,
  })
})

test('取不到 token / 没有回调地址时返回失败而不是抛错', async () => {
  const noUrl = await registerCallback({ apiHost: 'http://x', appKey: 'k', appSecret: 's', callbackUrl: '  ' })
  assert.equal(noUrl.ok, false)
  assert.equal(noUrl.code, 'no-url')
  const noToken = await registerCallback({
    apiHost: 'http://x',
    appKey: 'k',
    appSecret: 's',
    callbackUrl: 'http://h/p',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  })
  assert.equal(noToken.ok, false)
  assert.match(noToken.message, /取 token 失败/u)
  const rejected = await registerCallback({
    apiHost: 'http://x',
    appKey: 'k',
    appSecret: 's',
    callbackUrl: 'http://h/p',
    fetchImpl: async (url) => (url.endsWith('/app_access_token')
      ? { ok: true, status: 200, json: async () => ({ code: 'ok', data: { app_access_token: 'at_x' } }) }
      : { ok: true, status: 200, text: async () => 'boom' }),
  })
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /boom/u)
})
