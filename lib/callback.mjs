/**
 * 回调注册：生成 token / AESKey，并把回调地址注册到如流机器人后台。
 *
 * 依据（本机官方 SDK `@iflow` 的 `RobotApi.updateCallbackUrl`）：
 *   POST {apiHost}/api/v1/imRobot/updateReCallUrl
 *   body: { recallUrl, receiveMsgState: 1, token, encodingAesKey, enWebSocket: 0 }
 *   header: `Authorization: Bearer-<access_token>`（连字符，不是空格）
 * access_token 由 `POST /api/v1/auth/app_access_token` 取得（app_secret 传 md5 hex）。
 *
 * 关键事实：**token 和 encodingAesKey 是调用方生成后告诉如流的**，不是如流下发的。
 * 所以用户只需要填 AppKey / AppSecret，这两个值由插件随机生成并注册上去 ——
 * 官方 SDK 的 `starter.register()` 做的就是这件事。
 *
 * 本模块刻意不 import 任何 DSH 包：纯函数 + 可注入的 fetch / 随机源 / 网卡表，
 * 便于离线测试。
 *
 * @module dsh-ruliu/lib/callback
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'

/** 如流后台的回调模式：0 = webhook，1 = websocket。 */
export const WEBHOOK_MODE = 0

/** 如流接口要求的 app_secret 形态：md5 hex。 */
export const md5Hex = (value) => createHash('md5').update(String(value), 'utf8').digest('hex')

/**
 * 生成随机 checkToken（字母数字 20 位）。
 *
 * 如流后台对这个字段没有格式要求，只要两边一致；用随机值避免用户自己想。
 * @param randomBytes - 注入的随机源，默认 node:crypto。
 * @returns token 字符串。
 */
export function generateCheckToken(randomBytes = nodeRandomBytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(20)
  let out = ''
  for (let index = 0; index < 20; index += 1) out += alphabet[bytes[index] % alphabet.length]
  return out
}

/**
 * 生成随机 encodingAESKey：16 字节 → Base64URLSafe 22 位。
 *
 * 22 位正是如流/企业微信那一套常见的 AESKey 形态（插件解密时按 base64url 还原成
 * 16 字节，走 aes-128-ecb）。
 * @param randomBytes - 注入的随机源，默认 node:crypto。
 * @returns 22 位 key 字符串。
 */
export function generateAESKey(randomBytes = nodeRandomBytes) {
  return randomBytes(16).toString('base64url')
}

/**
 * 挑一个如流服务器够得着的本机 IPv4。
 *
 * 排序偏好：10.x（机房内网）> 192.168.x > 172.16-31.x > 其它；跳过回环、
 * link-local 和常见容器/虚拟网桥 —— 实测这台机器上 docker0 的 192.168.5.1 会
 * 排在 bond0 的 10.206.116.22 前面，必须排除。
 * @param interfaces - 注入的网卡表，默认 os.networkInterfaces()。
 * @returns IPv4 字符串，找不到返回空串。
 */
export function pickLanIPv4(interfaces = networkInterfaces()) {
  const candidates = []
  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    if (/^(docker|br-|veth|virbr|vmnet|tun|tap)/u.test(name)) continue
    for (const address of addresses ?? []) {
      if (address?.family !== 'IPv4' || address.internal === true) continue
      const ip = String(address.address ?? '')
      if (ip === '' || ip.startsWith('169.254.')) continue
      let rank = 3
      if (ip.startsWith('10.')) rank = 0
      else if (ip.startsWith('192.168.')) rank = 1
      else if (/^172\.(1[6-9]|2\d|3[01])\./u.test(ip)) rank = 2
      candidates.push({ ip, rank })
    }
  }
  candidates.sort((left, right) => left.rank - right.rank)
  return candidates[0]?.ip ?? ''
}

/** 解析 URL，失败返回 undefined（不抛）。 */
function parseURL(value) {
  try {
    return new URL(String(value))
  } catch {
    return undefined
  }
}

/** 回环地址判断。 */
function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * 推导「如流服务器能访问到的」回调地址。
 *
 * 优先级：显式配置 > 浏览器 origin > DSH_WEB_URL > 探测到的内网地址。
 * 前两者只要不是回环就直接用（端口取自它们，缺省 8080）—— 用户是怎么访问 DSH 的，
 * 那个地址通常就是如流能访问的地址。
 * @param options - 各来源。
 * @returns 完整回调 URL；推导不出来返回空串（调用方据此跳过注册）。
 */
export function deriveCallbackURL(options = {}) {
  const {
    publicCallbackUrl, webhookPath = '/dsh-ruliu/webhook', origin, dshWebUrl, interfaces,
  } = options
  const explicit = String(publicCallbackUrl ?? '').trim()
  if (explicit !== '') return explicit
  const port = parseURL(origin)?.port || parseURL(dshWebUrl)?.port || '8080'
  for (const value of [origin, dshWebUrl]) {
    const url = parseURL(value)
    if (url === undefined || isLoopback(url.hostname)) continue
    return `${url.protocol}//${url.hostname}:${port}${webhookPath}`
  }
  const lan = pickLanIPv4(interfaces)
  return lan === '' ? '' : `http://${lan}:${port}${webhookPath}`
}

/**
 * 取 access token 并调用 updateReCallUrl，把回调地址 + token + AESKey 注册到如流。
 *
 * 只做两件事，不做重试：失败就把原因交回调用方记日志 —— 注册失败不该影响
 * webhook 继续服务（已注册过的机器人照常推消息）。
 * @param options - apiHost / appKey / appSecret / callbackUrl / checkToken /
 *   encodingAESKey，以及可注入的 fetchImpl、timeoutMs。
 * @returns {Promise<{ok: boolean, code: string, message: string}>}
 */
export async function registerCallback(options) {
  const {
    apiHost, appKey, appSecret, callbackUrl, checkToken, encodingAESKey,
    fetchImpl = globalThis.fetch, timeoutMs = 15000,
  } = options
  if (String(callbackUrl ?? '').trim() === '') return { ok: false, code: 'no-url', message: '没有可用的回调地址' }
  const base = String(apiHost ?? '').replace(/\/+$/u, '')
  const tokenRes = await fetchImpl(`${base}/api/v1/auth/app_access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_key: appKey, app_secret: md5Hex(appSecret) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const tokenJson = await tokenRes.json().catch(() => null)
  const accessToken = tokenJson?.data?.app_access_token
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, code: String(tokenJson?.code ?? tokenRes.status), message: `取 token 失败：HTTP ${tokenRes.status}` }
  }
  const res = await fetchImpl(`${base}/api/v1/imRobot/updateReCallUrl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer-${accessToken}` },
    body: JSON.stringify({
      recallUrl: callbackUrl,
      receiveMsgState: 1,
      token: checkToken,
      encodingAesKey: encodingAESKey,
      enWebSocket: WEBHOOK_MODE,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await res.text()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  const code = parsed?.code ?? parsed?.data?.code ?? res.status
  // 成功码在不同环境见过 0 / 200 / 'ok' 三种写法（实测返回 {"code":"ok"}）。
  // 非 JSON 的 2xx 只有「空响应体」当成功，否则按失败处理 —— 免得把 HTML 报错页
  // 之类的东西当成注册成功。
  const ok = res.ok && (parsed === undefined ? raw.trim() === '' : [0, 200, '0', '200', 'ok'].includes(code))
  return { ok, code: String(code), message: ok ? `已注册回调 ${callbackUrl}` : raw.slice(0, 200) }
}
