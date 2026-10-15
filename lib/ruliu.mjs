/**
 * 如流（InfoFlow）协议客户端 —— 只依赖 node:crypto 与全局 fetch。
 *
 * 协议依据（调研自 OpenClaw 的如流通道插件 + 官方 SDK
 * @baidu/infoflow-sdk-nodejs 2026.9.23）：
 *
 *  入站 webhook（按 Content-Type 分三种）
 *    - application/x-www-form-urlencoded + echostr  → URL 校验，回显 echostr
 *    - application/x-www-form-urlencoded + messageJson → 单聊（明文 PascalCase）
 *    - text/plain                                   → 群聊（body 整体是密文）
 *    密文一律 AES-ECB 无 IV，key = Base64URLSafe-decode(encodingAESKey)
 *    校验：md5(rn + timestamp + checkToken) 与 signature 常数时间比较
 *
 *  出站
 *    - POST {apiHost}/api/v1/auth/app_access_token   取 token（app_secret 传 md5 hex）
 *    - POST {apiHost}/api/v1/app/message/send        单聊
 *    - POST {apiHost}/api/v1/robot/msg/groupmsgsend  群聊
 *    - 鉴权头是 `Authorization: Bearer-<token>`（连字符，不是空格）
 *
 * 已知坑（都在下面处理了）：大整数 ID 精度、消息重投去重、单聊时间是秒、
 * 响应双层错误码（外层 code 是字符串 "ok"）。
 *
 * @module dsh-ruliu/lib/ruliu
 */

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

/** 如流开放平台默认 API 域名（内网变体是 http://apiin.im.baidu.com）。 */
const DEFAULT_API_HOST = 'https://api.im.baidu.com'

/** token 缓存提前量：到期前 5 分钟就刷新。 */
const TOKEN_REFRESH_MARGIN_MS = 300 * 1000

/** 去重窗口与容量。 */
const DEDUPE_TTL_MS = 5 * 60 * 1000
const DEDUPE_MAX = 1000

/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 30 * 1000

/** 单条消息的字符上限，超过就按行切段分多条发。 */
const MAX_MESSAGE_CHARS = 3000

/**
 * md5 小写 hex。
 * @param value - 待摘要字符串。
 * @returns 32 位小写十六进制。
 */
function md5Hex(value) {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

/**
 * Base64URLSafe 解码（补回 `+`/`/` 与缺失的 `=`）。
 * @param value - base64url 字符串。
 * @returns Buffer。
 */
function base64UrlDecode(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

/**
 * 用 encodingAESKey 做 AES-ECB 解密。
 * @param cipherText - Base64URLSafe 密文。
 * @param encodingAESKey - 原始 22 位或已 base64 的 key 字符串。
 * @returns 解密后的 UTF-8 明文。
 */
function aesEcbDecrypt(cipherText, encodingAESKey) {
  const key = base64UrlDecode(encodingAESKey)
  const algorithm = key.length === 16 ? 'aes-128-ecb' : key.length === 24 ? 'aes-192-ecb' : key.length === 32 ? 'aes-256-ecb' : null
  if (algorithm === null) {
    throw new Error(`encodingAESKey 解码后长度非法：${key.length} 字节（应为 16/24/32）`)
  }
  const decipher = createDecipheriv(algorithm, key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(base64UrlDecode(cipherText)), decipher.final()]).toString('utf8')
}

/**
 * 从原始 JSON 文本里按正则抠出大整数 id。
 *
 * messageid 形如 1859713223686736431，超过 2^53-1，JSON.parse 会静默截断，
 * 导致去重失效、回复指错消息 —— 所以只能从原文抠。
 * @param rawJson - 解密后的 JSON 原文。
 * @param keys - 候选键名（大小写不敏感）。
 * @returns 命中的第一段数字字符串，或 undefined。
 */
function extractPreciseId(rawJson, keys) {
  for (const key of keys) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"?([0-9]{15,})"?`, 'i')
    const match = pattern.exec(rawJson)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * 常数时间比较两个签名。
 * @param left - 计算值。
 * @param right - 传入值。
 * @returns 是否相等。
 */
function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8')
  const b = Buffer.from(String(right), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 创建一个如流客户端。
 * @param config - 行配置：appKey / appSecret / agentId / checkToken /
 *   encodingAESKey / apiHost / robotName / msgType。
 * @param logger - Cordis logger，可为空。
 * @returns 客户端对象；凭证不全时返回 undefined。
 */
export function createRuliuClient(config = {}, logger) {
  const appKey = String(config.appKey ?? '').trim()
  const appSecret = String(config.appSecret ?? '').trim()
  if (appKey === '' || appSecret === '') return undefined

  const agentId = config.agentId
  const checkToken = String(config.checkToken ?? '').trim()
  const encodingAESKey = String(config.encodingAESKey ?? '').trim()
  const apiHost = String(config.apiHost ?? DEFAULT_API_HOST).replace(/\/+$/u, '')
  const msgType = String(config.msgType ?? 'text').toLowerCase() === 'md' ? 'md' : 'text'

  /** token 缓存。 */
  let token = null
  let tokenExpiresAt = 0

  /** 已处理消息 id → 时间戳，用于重投去重。 */
  const seen = new Map()

  /**
   * 记录并判断一条消息是否重复。
   * @param id - 平台消息 id（缺失时退化为 undefined，视为不重复）。
   * @returns true 表示是重复投递，应忽略。
   */
  const isDuplicate = (id) => {
    const now = Date.now()
    for (const [key, at] of seen) {
      if (now - at > DEDUPE_TTL_MS) seen.delete(key)
    }
    if (seen.size > DEDUPE_MAX) {
      const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, seen.size - DEDUPE_MAX)
      for (const [key] of oldest) seen.delete(key)
    }
    if (id === undefined || id === null || id === '') return false
    const key = String(id)
    if (seen.has(key)) return true
    seen.set(key, now)
    return false
  }

  /**
   * 取（并缓存）app_access_token。
   * @returns access token。
   */
  const getToken = async () => {
    const now = Date.now()
    if (token !== null && now < tokenExpiresAt) return token
    const response = await fetch(`${apiHost}/api/v1/auth/app_access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_key: appKey, app_secret: md5Hex(appSecret) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => null)
    // 真实响应（实测）：{"code":"ok","data":{"app_access_token":"at_…","expire":7200}}
    // 外层 code 是字符串 "ok"；过期字段名是 expire（不是 expires_in）。
    const outerOk = payload !== null && String(payload?.code ?? '') === 'ok'
    if (!response.ok || payload === null || (!outerOk && Number(payload?.errcode ?? -1) !== 0)) {
      throw new Error(`取 token 失败：HTTP ${response.status} ${JSON.stringify(payload)?.slice(0, 200) ?? ''}`)
    }
    token = payload?.data?.app_access_token
    if (typeof token !== 'string' || token === '') throw new Error('取 token 失败：响应里没有 app_access_token')
    const expiresInSec = Number(payload?.data?.expire ?? payload?.data?.expires_in ?? 7200)
    tokenExpiresAt = Date.now() + Math.max(60, expiresInSec * 1000 - TOKEN_REFRESH_MARGIN_MS)
    return token
  }

  /**
   * 发一条文本/markdown 到单聊或群聊。
   * @param chatId - `private:<userId>` 或 `group:<groupId>`。
   * @param text - 正文。
   * @param replyTo - 可选，被回复消息的 id（群聊才生效）。
   */
  const sendText = async (chatId, text, replyTo) => {
    const content = String(text ?? '')
    if (content === '') return
    // 如流单条消息有长度上限，长回复按行切段逐条发（第一段带引用回复）。
    const chunks = splitForIM(content, MAX_MESSAGE_CHARS)
    for (let index = 0; index < chunks.length; index++) {
      await sendOne(chatId, chunks[index], index === 0 ? replyTo : undefined)
    }
  }

  /**
   * 发一段文本（不再切分）。
   * @param chatId - `private:<userId>` 或 `group:<groupId>`。
   * @param content - 正文。
   * @param replyTo - 可选，被回复消息的 id（群聊才生效）。
   */
  const sendOne = async (chatId, content, replyTo) => {
    const [kind, target] = String(chatId).split(':', 2)
    const accessToken = await getToken()
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer-${accessToken}`,
    }

    let url
    let body
    if (kind === 'group') {
      url = `${apiHost}/api/v1/robot/msg/groupmsgsend`
      const header = {
        toid: Number(target),
        totype: 'GROUP',
        msgtype: msgType === 'md' ? 'MD' : 'TEXT',
        clientmsgid: Date.now(),
        role: 'robot',
      }
      if (agentId !== undefined && agentId !== '') header.agentid = Number(agentId)
      const message = {
        header,
        body: [{ type: msgType === 'md' ? 'MD' : 'TEXT', content }],
      }
      if (replyTo !== undefined && replyTo !== null && replyTo !== '') {
        message.reply = { messageid: String(replyTo), replytype: '1' }
      }
      body = { message }
    } else {
      url = `${apiHost}/api/v1/app/message/send`
      const payload = { touser: target, msgtype: msgType }
      payload[msgType] = { content }
      if (agentId !== undefined && agentId !== '') payload.agentid = Number(agentId)
      body = payload
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const raw = await response.text()
    // 双层错误码：外层 code 是字符串 "ok"，内层 data.errcode 是数字。
    const okOuter = /"code"\s*:\s*"ok"/u.test(raw)
    const innerErr = /"errcode"\s*:\s*(-?\d+)/u.exec(raw)
    const innerOk = innerErr === null || innerErr[1] === '0'
    if (!response.ok || !okOuter || !innerOk) {
      throw new Error(`发送失败：HTTP ${response.status} ${raw.slice(0, 300)}`)
    }
    logger?.debug?.('dsh-ruliu: 已发送到 %s（%d 字节）', chatId, content.length)
  }

  /**
   * 解析一个入站 webhook 请求。
   *
   * 返回四选一：
   *   { kind: 'reply', status, contentType, body }  按平台要求原样应答
   *   { kind: 'message', chatId, text, messageId, chatType, senderId }
   *   { kind: 'ignore', reason }                    回 200 success 但不处理
   * @param req - Node IncomingMessage（只读 headers）。
   * @param raw - 已读出的请求体原文（必须保留原文，群聊要靠它解密）。
   * @returns 解析结果。
   */
  const parseInbound = (req, raw) => {
    const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase()
    const body = String(raw ?? '')

    // ---- URL 校验（challenge）----
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(body)
      const echostr = form.get('echostr')
      if (echostr !== null) {
        const signature = form.get('signature') ?? ''
        const timestamp = form.get('timestamp') ?? ''
        const rn = form.get('rn') ?? ''
        if (checkToken === '') {
          return { kind: 'reply', status: 500, contentType: 'text/plain; charset=utf-8', body: 'checkToken 未配置' }
        }
        const expected = md5Hex(`${rn}${timestamp}${checkToken}`)
        if (!safeEqual(expected, signature)) {
          logger?.warn?.('dsh-ruliu: 回调校验签名不匹配')
          return { kind: 'reply', status: 403, contentType: 'text/plain; charset=utf-8', body: 'Invalid signature' }
        }
        // 通过：原样回显 echostr
        return { kind: 'reply', status: 200, contentType: 'text/plain; charset=utf-8', body: echostr }
      }

      // ---- 单聊消息 ----
      const messageJson = form.get('messageJson')
      if (messageJson === null) {
        return { kind: 'reply', status: 400, contentType: 'text/plain; charset=utf-8', body: 'unsupported content type' }
      }
      let cipher
      try {
        cipher = JSON.parse(messageJson)?.Encrypt
      } catch {
        return { kind: 'reply', status: 400, contentType: 'text/plain; charset=utf-8', body: 'failed to parse message' }
      }
      if (typeof cipher !== 'string' || cipher === '') {
        return { kind: 'reply', status: 400, contentType: 'text/plain; charset=utf-8', body: 'missing Encrypt' }
      }
      const plain = decodePlain(cipher)
      if (plain === null) {
        return { kind: 'reply', status: 500, contentType: 'text/plain; charset=utf-8', body: 'decryption failed' }
      }
      const messageId = extractPreciseId(plain.raw, ['MsgId', 'msgid', 'messageid'])
      const senderId = plain.json.FromUserId ?? plain.json.fromuserid
      if (isDuplicate(messageId)) return { kind: 'ignore', reason: 'duplicate' }
      const text = textOfPrivate(plain.json)
      if (text === '') return { kind: 'ignore', reason: `非文本消息（MsgType=${String(plain.json.MsgType ?? '')}）` }
      return {
        kind: 'message',
        chatId: `private:${String(senderId ?? '')}`,
        text,
        messageId,
        chatType: 'private',
        senderId: senderId === undefined ? undefined : String(senderId),
      }
    }

    // ---- 群聊消息（body 整体是密文）----
    if (contentType.includes('text/plain')) {
      const plain = decodePlain(body.trim())
      if (plain === null) {
        return { kind: 'reply', status: 500, contentType: 'text/plain; charset=utf-8', body: 'decryption failed' }
      }
      const json = plain.json
      const header = json?.message?.header ?? {}
      const messageId = extractPreciseId(plain.raw, ['messageid', 'msgid', 'MsgId']) ?? (header.messageid === undefined ? undefined : String(header.messageid))
      if (isDuplicate(messageId)) return { kind: 'ignore', reason: 'duplicate' }
      const groupId = json?.groupid ?? header.toid
      const senderId = header.fromuserid ?? json?.fromid
      const text = textOfGroup(json)
      if (text === '') return { kind: 'ignore', reason: `非文本群消息（msgtype=${String(header.msgtype ?? '')}）` }
      return {
        kind: 'message',
        chatId: `group:${String(groupId ?? '')}`,
        text,
        messageId,
        chatType: 'group',
        senderId: senderId === undefined ? undefined : String(senderId),
      }
    }

    return { kind: 'reply', status: 400, contentType: 'text/plain; charset=utf-8', body: 'unsupported content type' }
  }

  /**
   * 解密一段密文并按 JSON 解析；同时保留原文供大整数抠取。
   * @param cipher - Base64URLSafe 密文。
   * @returns { json, raw } 或 null（解密/解析失败）。
   */
  function decodePlain(cipher) {
    let text
    try {
      // 未配置 encodingAESKey 时按明文 JSON 兜底（SDK 的开发期行为）
      text = encodingAESKey === '' ? cipher : aesEcbDecrypt(cipher, encodingAESKey)
    } catch (error) {
      logger?.warn?.('dsh-ruliu: 解密失败：%s', String(error?.message ?? error))
      return null
    }
    try {
      return { json: JSON.parse(text), raw: text }
    } catch {
      logger?.warn?.('dsh-ruliu: 明文不是 JSON，前 120 字节：%s', text.slice(0, 120))
      return null
    }
  }

  return { parseInbound, sendText, isDuplicate }
}

/**
 * 把长文本切成不超过 limit 的若干段，优先在换行处断开（IM 单条消息有长度上限）。
 * @param text - 原文。
 * @param limit - 每段最大字符数。
 * @returns 段落数组（原文不超限时就是它自己）。
 */
function splitForIM(text, limit) {
  if (text.length <= limit) return [text]
  const chunks = []
  let current = ''
  for (const line of text.split('\n')) {
    // 单行本身超限：硬切
    if (line.length > limit) {
      if (current !== '') { chunks.push(current); current = '' }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit))
      continue
    }
    if (current !== '' && current.length + 1 + line.length > limit) {
      chunks.push(current)
      current = line
    } else {
      current = current === '' ? line : `${current}\n${line}`
    }
  }
  if (current !== '') chunks.push(current)
  return chunks.length === 0 ? [text] : chunks
}

/**
 * 从单聊明文里取文本。
 * @param json - 单聊明文对象（PascalCase）。
 * @returns 文本；非文本消息返回空串。
 */
function textOfPrivate(json) {
  const type = String(json?.MsgType ?? json?.msgtype ?? '').toLowerCase()
  const content = json?.Content ?? json?.content
  if (type === '' || type === 'text' || type === 'md' || type === 'markdown' || type === 'richtext') {
    return typeof content === 'string' ? content.trim() : ''
  }
  return ''
}

/**
 * 从群聊明文里取文本（拼接 TEXT / MD 块，忽略 AT / 引用等）。
 * @param json - 群聊明文对象。
 * @returns 文本。
 */
function textOfGroup(json) {
  const body = json?.message?.body
  if (!Array.isArray(body)) return ''
  return body
    .filter((item) => {
      const type = String(item?.type ?? '').toUpperCase()
      return type === 'TEXT' || type === 'MD'
    })
    .map((item) => String(item?.content ?? ''))
    .join('')
    .trim()
}
