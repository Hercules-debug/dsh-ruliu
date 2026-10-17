/**
 * dsh-ruliu — 百度如流（InfoFlow）↔ DeepSeek Harness 通道插件。
 *
 * 入站：如流开放平台把消息事件推到本插件注册的 HTTP 回调路由
 *       （webServer.register）。每个如流会话（chatId）对应一个 DSH 会话，
 *       映射持久化在 <profile>/.dsh-ruliu/sessions.json。
 *
 * 出站：订阅 DSH 的 `session/event`，把 assistant 的文本回复发回如流
 *       （群聊会带上被回复消息的 id）。
 *
 * 协议细节全部在 lib/ruliu.mjs，这里只做 DSH 侧的桥接。
 *
 * 宿主 API 依据（dsh 0.2.0-rc.2）：
 *   - ctx.webServer.register({ kind, path, handler })    dsh-host-webserver
 *   - ctx.agents.create(options): Promise<AgentHandle>   dsh-agent
 *   - ctx.agents.get(sessionId): Agent | undefined       dsh-agent
 *   - Agent.followup(userMessage)                        dsh-agent
 *   - ctx.on('session/event', (session, event) => …)     事件 type:
 *       'turn/start' | 'tool/call' | 'assistant/message' | 'turn/end'
 *   - 用户消息：本地 createUserMessage() 构造，等价 dsh-llm 的实现
 *       （deepFreeze(structuredClone({...input, id: uuid}))）—— 这样本插件
 *       零外部依赖，不受 link: 包的模块解析限制影响。
 *
 * @module dsh-ruliu
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRuliuClient } from './lib/ruliu.mjs'
import { Config, validateConfiguration } from './lib/config.mjs'
import {
  deriveCallbackURL, generateAESKey, generateCheckToken, registerCallback,
} from './lib/callback.mjs'
import {
  buildAnswers, buildApprovalOutcome, parseAnswerInput, renderApproval, renderQuestions,
} from './lib/interactions.mjs'

export { Config }

/** 稳定的 Cordis 插件名。 */
export const name = 'dsh-ruliu'

/**
 * webServer 注册回调路由；agents 起/续会话；sessions / sessionPersistence 读会话事实。
 *
 * sessionPersistence 必须在这里声明：Cordis 只会把 inject 里列出的服务解析进本 fiber 的
 * store，属性访问才命中；未声明时 `ctx.sessionPersistence` 直接抛
 * `cannot get property "sessionPersistence" without inject` —— `?.` 拦不住属性访问本身。
 * 少了它，/list 只剩内存里的活跃会话（也就是本插件自己建的），持久化里的历史一条都列不出来。
 */
export const inject = ['webServer', 'agents', 'sessions', 'sessionPersistence']

/** 单个回调请求体的上限，防止把宿主内存吃满。 */
const MAX_BODY_BYTES = 1 << 20

/**
 * 把任意错误值压成一行可读文本（Error / {message,code} 对象 / 字符串都覆盖）。
 * 之前直接 String(err) 得到 "[object Object]"，什么也看不出。
 * @param error - 待描述的值。
 * @returns 一行文本。
 */
function describeError(error) {
  if (error === undefined || error === null) return '(none)'
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message !== '') {
    return error.code === undefined ? error.message : `${error.message} (code=${String(error.code)})`
  }
  try {
    return JSON.stringify(error).slice(0, 300)
  } catch {
    return String(error)
  }
}

/**
 * 建一个往 `<stateDir>/log.ndjson` 追加结构化事件的日志器。
 *
 * 宿主日志不一定落盘，排障需要自己的落地记录：每一行是
 * `{ at, event, detail }`。日志失败绝不影响主流程。
 * @param stateDir - 插件的状态目录。
 * @returns (event, detail) => void。
 */
function createFileLog(stateDir) {
  const file = join(stateDir, 'log.ndjson')
  let ready = false
  return (event, detail) => {
    try {
      if (!ready) {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 })
        ready = true
      }
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`)
    } catch {
      /* 记日志失败不该影响对话 */
    }
  }
}

/**
 * 读插件自己的回调状态文件 `<stateDir>/callback.json`。
 *
 * 存的是「插件生成的 token / AESKey」和「最近一次注册用的地址」。生成的这组值必须
 * 固定下来：如果每次重启都换一把新 key，如流那边还是旧的，握手就会 403。
 * @param stateDir - 插件状态目录。
 * @returns 读不到或损坏时返回空对象。
 */
function readCallbackState(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'callback.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 写回调状态文件（含密钥，权限 0600）；失败只当没记住，不影响通道。
 * @param stateDir - 插件状态目录。
 * @param state - 待写入的状态对象。
 */
function writeCallbackState(stateDir, state) {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(stateDir, 'callback.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch {
    /* 状态写不进去不该影响通道 */
  }
}

/**
 * 递归冻结（等价 dsh-llm 的 deepFreeze）。
 * @param value - 待冻结的值。
 * @returns 同一个值。
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * 构造一条用户消息，等价于 `@deepseek-ai/dsh-llm` 的 createUserMessage
 * （该函数就是 deepFreeze(structuredClone({ ...input, id: uuid }))）。
 *
 * 内联而不是 import：本插件是 link 到 profile 外的目录，@deepseek-ai/* 的
 * 解析依赖 loader 的拦截；自带实现让插件零外部依赖，去掉这一层不确定性。
 * @param input - { content, source }。
 * @returns 冻结后的用户消息。
 */
function createUserMessage(input) {
  // role 必须显式写：漏掉它会让序列化时 message.role === undefined，provider 里
  // `previous?.role === wireRole` 在首条消息上即成立（undefined === undefined），
  // 接着读 previous.content → TypeError → 被包成 TRANSPORT（实测踩过这个坑）。
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * 解析当前 profile 目录，用于存放会话映射。
 *
 * 与 dshmarket 同样的做法：$DSH_HOME（空视为未设置）否则 ~/.dsh，
 * profile 名取自启动参数 `--profile <name>`，缺省 web。
 * @returns profile 目录的绝对路径。
 */
function resolveProfileDir() {
  const fromEnv = process.env.DSH_HOME
  const home = fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  const candidate = flag !== -1 ? argv[flag + 1] : undefined
  const profile = candidate !== undefined && !candidate.startsWith('-') ? candidate : 'web'
  return join(home, 'profiles', profile)
}

/**
 * 从 assistant 消息里取出纯文本。
 * @param message - session/event 里 event.data.message。
 * @returns 拼接后的文本（没有文本块时为空串）。
 */
function textOfAssistantMessage(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim()
}

/**
 * 读完一个请求体，超过上限即中止。
 * @param req - Node IncomingMessage。
 * @returns UTF-8 字符串。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('dsh-ruliu: request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 写一个响应。
 * @param res - Node ServerResponse。
 * @param status - HTTP 状态码。
 * @param contentType - Content-Type 头。
 * @param body - 响应体。
 */
function send(res, status, contentType, body) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * chatId → DSH sessionId 的持久映射。
 *
 * 只存映射本身，不存消息内容：会话事实由 DSH 自己的会话存储拥有。
 */
class SessionMap {
  /**
   * @param file - sessions.json 的绝对路径。
   * @param logger - Cordis logger，可为空。
   */
  constructor(file, logger) {
    this.file = file
    this.logger = logger
    this.byChat = new Map()
    this.bySession = new Map()
    this.load()
  }

  /** 从磁盘恢复；文件缺失或损坏都退化为空映射。 */
  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const [chatId, sessionId] of Object.entries(raw?.pairs ?? {})) {
        this.byChat.set(chatId, sessionId)
        this.bySession.set(sessionId, chatId)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.('dsh-ruliu: 会话映射读取失败，按空映射继续：%s', String(error?.message ?? error))
      }
    }
  }

  /** 落盘；失败只记日志，不影响本轮对话。 */
  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(this.file, JSON.stringify({ pairs: Object.fromEntries(this.byChat) }, null, 2))
    } catch (error) {
      this.logger?.warn?.('dsh-ruliu: 会话映射写入失败：%s', String(error?.message ?? error))
    }
  }

  /**
   * @param chatId - 如流会话 id（`private:<uid>` 或 `group:<gid>`）。
   * @returns 已绑定的 DSH 会话 id，或 undefined。
   */
  sessionOf(chatId) {
    return this.byChat.get(chatId)
  }

  /**
   * 已知的如流会话 id 列表。
   *
   * 用途：收消息失败（解不开密文）时，出站仍然是通的 —— 可以往已知会话发一条告警，
   * 把「静默卡住」变成用户看得见的错误。
   * @returns chatId 数组。
   */
  knownChats() {
    return [...this.byChat.keys()]
  }

  /**
   * @param sessionId - DSH 会话 id。
   * @returns 该会话绑定的如流 chatId，或 undefined。
   */
  chatOf(sessionId) {
    return this.bySession.get(sessionId)
  }

  /**
   * 建立绑定并落盘。
   * @param chatId - 如流会话 id。
   * @param sessionId - DSH 会话 id。
   */
  bind(chatId, sessionId) {
    this.byChat.set(chatId, sessionId)
    this.bySession.set(sessionId, chatId)
    this.save()
  }

  /**
   * 解除绑定：下一条消息会开新会话（对应 `/end`、`/new`）。
   * @param chatId - 如流会话 id。
   */
  unbind(chatId) {
    const sessionId = this.byChat.get(chatId)
    if (sessionId !== undefined) this.bySession.delete(sessionId)
    this.byChat.delete(chatId)
    this.save()
  }
}

/** Keep settings available even while the channel is disabled or awaiting credentials. */
export function apply(ctx, config) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  // Validate settings writes without logging or echoing their values.
  ctx.on('internal/config', function (_raw, next) {
    const raw = next()
    if (this === ctx.fiber) validateConfiguration(Config(raw).get())
    return raw
  })
  const snapshot = typeof config?.get === 'function' ? config.get() : config ?? {}
  mountTransport(ctx, snapshot)
  // A volatile form update changes the references in place. Restarting this
  // small bridge swaps the route and event subscription exactly once, while
  // preserving the rest of the DSH host and the persisted chat mapping.
  ctx.on('loader/volatile-update', () => { void ctx.fiber.restart().catch((error) => ctx.logger.warn(error)) })
}

/** Transport owns routes, session subscriptions and client tokens for one config snapshot. */
function mountTransport(ctx, config = {}) {
  const logger = ctx.logger

  if (config.enabled !== true) {
    logger?.info?.('dsh-ruliu: 未启用（config.enabled !== true），跳过挂载')
    return
  }

  const webhookPath = config.webhookPath || '/dsh-ruliu/webhook'
  const cwd = config.cwd || process.cwd()
  const stateDir = config.stateDir || join(resolveProfileDir(), '.dsh-ruliu')
  const sessions = new SessionMap(join(stateDir, 'sessions.json'), logger)
  const log = createFileLog(stateDir)

  // ---- 凭证：AppKey/AppSecret 必须由用户填；token/AESKey 默认也要用户填 ----
  //
  // 官方 SDK 说 token/encodingAesKey 是调用方生成后调 updateReCallUrl 告诉如流的，
  // 但实测：**在如流后台已经配过「接收消息服务器」的机器人上，接口带过去的新 AESKey
  // 不一定被消息管道采用** —— 表现是如流推来的消息解不开（webhook 回 500
  // decryption failed），而且它不回显落库内容，没法从响应判断。
  // 所以自动生成改成显式开关（config.autoRegisterCallback，默认 false）：
  // 默认要求把如流后台里的 Token/AESKey 填进配置，行为可预期。
  const storedCallback = readCallbackState(stateDir)
  const configuredToken = String(config.checkToken ?? '').trim()
  const configuredAESKey = String(config.encodingAESKey ?? '').trim()
  const storedToken = String(storedCallback.checkToken ?? '')
  const storedAESKey = String(storedCallback.encodingAESKey ?? '')
  const autoRegister = config.autoRegisterCallback === true
  const missingToken = configuredToken === '' && storedToken === ''
  const missingAESKey = configuredAESKey === '' && storedAESKey === ''
  const credentialsGenerated = autoRegister && (missingToken || missingAESKey)
  const checkToken = configuredToken || storedToken || (autoRegister ? generateCheckToken() : '')
  const encodingAESKey = configuredAESKey || storedAESKey || (autoRegister ? generateAESKey() : '')
  if (credentialsGenerated) {
    writeCallbackState(stateDir, { ...storedCallback, checkToken, encodingAESKey })
    log('credentials-resolved', { generated: true, aesKeyChars: encodingAESKey.length })
  } else if (missingToken || missingAESKey) {
    // 不自动生成时给出明确指引：去如流后台复制这两个值填进来
    logger?.warn?.('dsh-ruliu: 缺少 %s，请在「设置 → 如流」里填如流后台「接收消息服务器」里的值（或打开 autoRegisterCallback 让插件生成并注册）',
      [missingToken ? 'checkToken' : '', missingAESKey ? 'encodingAESKey' : ''].filter((part) => part !== '').join(' + '))
    log('credentials-missing', { checkToken: missingToken, encodingAESKey: missingAESKey })
  }

  const client = createRuliuClient({ ...config, checkToken, encodingAESKey }, logger)
  if (client === undefined) {
    logger?.warn?.('dsh-ruliu: 凭证不全（需要 appKey + appSecret），通道未挂载')
    return
  }

  /**
   * 把回调地址 + token + AESKey 注册到如流机器人后台。
   *
   * 只在「用户没填 token/AESKey、由插件生成」或「设置页手动点注册」时调用：
   * 已有完整配置的机器人不去动它 —— 万一推导出的地址不对，重注册会把能用的回调
   * 改坏。注册失败只记日志，webhook 照常服务。
   * @param options - callbackUrl（显式指定，优先）/ origin（浏览器地址，用于推导）/
   *   trigger（auto | manual，仅日志用）。
   * @returns {Promise<{ok: boolean, code: string, message: string, callbackUrl: string}>}
   */
  const registerRuliuCallback = async ({ callbackUrl: explicitUrl, origin, trigger } = {}) => {
    const explicit = String(explicitUrl ?? '').trim()
    const callbackUrl = explicit !== '' ? explicit : deriveCallbackURL({
      publicCallbackUrl: config.publicCallbackUrl,
      webhookPath,
      origin,
      // 宿主侧没有浏览器，只能靠 DSH_WEB_URL / webServer 端口推；回环会被跳过
      dshWebUrl: process.env.DSH_WEB_URL || `http://127.0.0.1:${ctx.webServer?.port ?? 8080}`,
    })
    if (callbackUrl === '') {
      const result = { ok: false, code: 'no-url', message: '推导不出如流能访问的回调地址，请在设置里填「对外回调地址」。', callbackUrl }
      log('callback-register', { trigger, ...result })
      return result
    }
    let result
    try {
      result = await registerCallback({
        apiHost: config.apiHost,
        appKey: config.appKey,
        appSecret: config.appSecret,
        callbackUrl,
        checkToken,
        encodingAESKey,
      })
    } catch (error) {
      result = { ok: false, code: 'error', message: describeError(error) }
    }
    log('callback-register', { trigger, callbackUrl, ok: result.ok, code: result.code, message: result.message })
    if (result.ok) {
      writeCallbackState(stateDir, {
        ...readCallbackState(stateDir), checkToken, encodingAESKey, callbackUrl, registeredAt: new Date().toISOString(),
      })
    }
    return { ...result, callbackUrl }
  }

  // 只有「刚生成 token/AESKey」时才自动注册一次，把首次配置也变成只填两个字段
  if (credentialsGenerated) {
    void registerRuliuCallback({ trigger: 'auto' }).catch((error) => log('callback-register-failed', { error: describeError(error) }))
  }

  /** chatId → 最近一条入站消息 id，用于群聊的引用回复。 */
  const lastInboundId = new Map()

  /**
   * preset id → 已 acquire 的 scope。
   *
   * 官方 dsh-webhook 在 agents.create 之前会 `agentPresets.acquireScope(id)`：
   * 那是引用计数（retain），保证 preset 的组合代次不被回收。不 acquire 的话，
   * mount 进 agent 世界的行会被回收掉 —— 表现为 agent 的 LLM provider 连接为空
   * （baseURL undefined → 同步抛错 → 被包成 TRANSPORT，重试 5 次后回合失败）。
   */
  const presetScopes = new Map()

  /**
   * 取（或首次 acquire）某个 preset 的 scope。
   * @param presets - ctx.agentPresets 服务。
   * @param id - preset id。
   * @returns scope，或 undefined（宿主没有 acquireScope 时）。
   */
  const acquirePresetScope = async (presets, id) => {
    if (id === undefined || typeof presets?.acquireScope !== 'function') return undefined
    const existing = presetScopes.get(id)
    if (existing !== undefined) return existing
    const scope = await presets.acquireScope(id)
    presetScopes.set(id, scope)
    log('preset-scope-acquired', { presetId: id })
    return scope
  }

  // ---- 交互层：斜杠命令 ----
  //
  // 交互模型参考 dsh-bridge 的 IM 通道：命令优先于对话；没有活动会话时给出
  // `/new` / `/list` 的提示，而不是把每条消息都灌进同一个会话。

  /** 最近一次 `/list` 的结果，供 `/use <序号>` 使用。 */
  let lastListing = []

  /**
   * 会话 id → 最近一次事件时间（Unix 毫秒），`/list` 排序用。
   *
   * 这是 `sessionController` 取不到时的兜底口径：只要本进程见过该会话的
   * `session/event` 就记一笔，冷会话（没在内存里）自然没有记录。
   */
  const activityAt = new Map()

  /** 命令帮助文本。 */
  const helpText = () => [
    '📖 **可用命令**',
    '',
    '`/new [提示词]` — 开一个新会话（可带首条提示词）',
    '`/list` — 列出最近的会话（别名 `/sessions`）',
    '`/use <序号>` — 把本聊天切到 `/list` 里的某个会话',
    '`/1` `/2` … — 回答审批或模型提问（有等待项时；多问题按顺序 `/1 2`，多选 `/1,3`）',
    '`/end` — 结束当前绑定，下条消息会开新会话',
    '`/status` — 看当前绑定的会话与模型',
    '`/help` — 显示这条帮助',
    '',
    '直接发普通文字就是和当前会话对话。',
  ].join('\n')

  /**
   * 给还没有标题的行补上 DSH 的会话标题（`session/title` 事件的折叠结果）。
   *
   * `sessionQuery` 故意不写进 inject：它只用来取标题，取不到就退化成「(未命名)」，
   * 不该因为它缺失就让整条通道挂不上 —— 所以用 `ctx.get()` 软取。
   * @param rows - listSessions 的行（就地写回 title）。
   */
  const fillTitles = async (rows) => {
    const missing = rows.filter((row) => row.title === '').map((row) => row.id)
    if (missing.length === 0) return
    try {
      const query = ctx.get?.('sessionQuery')
      if (typeof query?.readTitleSnapshots !== 'function') {
        log('title-fill-skipped', { reason: 'sessionQuery 不可用', missing: missing.length })
        return
      }
      const results = await query.readTitleSnapshots(missing)
      const byId = new Map(results.map((result) => [
        result?.sessionId,
        result?.status === 'fulfilled' ? result.value?.title?.title ?? '' : '',
      ]))
      for (const row of rows) {
        if (row.title === '') row.title = byId.get(row.id) ?? ''
      }
    } catch (error) {
      log('title-fill-failed', { error: describeError(error) })
    }
  }

  /**
   * 取每个会话的「最近活跃」时间（Unix 毫秒），供 `/list` 排序。
   *
   * 首选 `sessionController.list()`：它和 Web 侧边栏是同一个口径
   * （`updatedAt = max(createdAt, 最后一次用户消息时间)`），活跃会话和冷会话都覆盖，
   * 所以从 Web 或如流任一侧刚聊过的会话都会浮到最上面。
   *
   * 该服务没挂载时（例如 headless profile）退回本插件自己从 `session/event` 攒的时间戳；
   * 两者都没有就只剩 `createdAt`，排序退化成「按创建时间倒序」。
   * @returns {Promise<Map<string, number>>} 会话 id → 活跃时间。
   */
  const readActivityTimes = async () => {
    const times = new Map(activityAt)
    try {
      const controller = ctx.get?.('sessionController')
      if (typeof controller?.list !== 'function') return times
      const { items } = (await controller.list({}, AbortSignal.timeout(3000))) ?? {}
      for (const item of items ?? []) {
        const id = item?.sessionId
        if (id === undefined) continue
        const at = Number(item?.updatedAt ?? 0)
        if (Number.isFinite(at) && at > (times.get(id) ?? 0)) times.set(id, at)
      }
    } catch (error) {
      // 超时/服务不可用都不该让 /list 挂掉：退回兜底口径继续列
      log('activity-read-failed', { error: describeError(error) })
    }
    return times
  }

  /**
   * 列出可切换的会话：内存里的活跃会话 + 持久化里的历史会话，按**最近活跃**倒序。
   *
   * 坑：`ctx.sessionPersistence` 必须写进 `inject` 才取得到（见文件顶部 inject 的注释）。
   * 之前这里恒抛，`/list` 就只剩内存里的活跃会话（即本插件自己建的），历史会话一条都没有。
   * 坑二：早先按 `createdAt` 排序，刚聊过的老会话永远沉在下面 —— 改成活跃时间后，
   * 「刚活跃的窗口」才会出现在第 1 条。
   * @returns {Promise<Array<{id, title, createdAt, activityAt}>>} 最多 10 条。
   */
  const listSessions = async () => {
    const rows = new Map()
    try {
      for (const session of ctx.sessions?.list?.() ?? []) {
        const id = session?.id
        if (id === undefined) continue
        const header = session.header ?? {}
        // 只列本插件配置的工作目录，避免把整个 home 的会话都倒出来
        if (cwd !== '' && header.cwd !== undefined && header.cwd !== cwd) continue
        rows.set(id, { id, title: session.title ?? '', createdAt: header.createdAt ?? 0 })
      }
    } catch (error) {
      log('session-list-failed', { error: describeError(error) })
    }
    try {
      // 快照形状：`{ header, revision, sizeBytes }`（旧版是扁平 header，这里兼容两种）
      for (const snapshot of (await ctx.sessionPersistence.list()) ?? []) {
        const header = snapshot?.header ?? snapshot ?? {}
        if (header.id === undefined || rows.has(header.id)) continue
        if (cwd !== '' && header.cwd !== undefined && header.cwd !== cwd) continue
        rows.set(header.id, { id: header.id, title: '', createdAt: header.createdAt ?? 0 })
      }
    } catch (error) {
      log('session-persist-list-failed', { error: describeError(error) })
    }
    const activity = await readActivityTimes()
    const listing = [...rows.values()]
      .map((row) => ({ ...row, activityAt: Math.max(activity.get(row.id) ?? 0, row.createdAt ?? 0) }))
      .sort((a, b) => b.activityAt - a.activityAt || (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 10)
    await fillTitles(listing)
    return listing
  }

  /**
   * 取「当前绑定会话」的标题，仅在它不在 rows 里时用。
   *
   * 用途：绑定的会话可能已经掉出最近 10 条，这时 `/list` 要能补一句
   * 「当前绑定的是哪条」，否则用户会以为自己的会话凭空消失了。
   * @param bound - 绑定的会话 id，或 undefined。
   * @param rows - listSessions 的结果。
   * @returns {Promise<string>} 标题；不需要补时返回空串。
   */
  const titleOfMissing = async (bound, rows) => {
    if (bound === undefined || rows.some((row) => row.id === bound)) return ''
    const probe = [{ id: bound, title: '' }]
    await fillTitles(probe)
    return probe[0]?.title ?? ''
  }

  /**
   * 把会话列表渲染成 IM 文本：序号 + 标题，并标出本聊天当前绑定的那条。
   *
   * 故意不打印 `session-<uuid>`：那是 DSH 的内部实现细节，IM 里的使用者既读不出
   * 信息量也用不上 —— 切换靠的是序号（`/use <序号>`），id 只在日志里出现。
   * 也故意不打印创建时间和「🟢 活跃」：IM 是窄屏，这两项把标题挤到换行，
   * 而「活跃」本来就是排序依据（活跃的排在最前），标出来是冗余信息。
   *
   * 但「当前绑定的是哪条」必须标：如流这边一个聊天只绑一条会话，而列表是全工作区的
   * 会话，两者不是一回事 —— 不标的话，「我刚用过的会话」和「如流现在实际在用的会话」
   * 会被当成同一个，看列表就会觉得「我们的会话怎么没排在最上面」。
   * @param rows - listSessions 的结果。
   * @param bound - 本聊天当前绑定的会话 id，或 undefined（未绑定）。
   * @param boundTitle - 绑定会话的标题，仅在它不在 rows 里时用于提示。
   * @returns 文本。
   */
  const renderSessions = (rows, bound, boundTitle = '') => {
    if (rows.length === 0) return '还没有任何会话。发送 `/new <提示词>` 开一个。'
    const lines = ['🗂 **最近的会话**（用 `/use <序号>` 切换）', '']
    let marked = false
    rows.forEach((row, index) => {
      const current = bound !== undefined && row.id === bound
      if (current) marked = true
      lines.push(`${index + 1}. ${row.title === '' ? '(未命名)' : row.title}${current ? ' ← 当前' : ''}`)
    })
    if (bound !== undefined && !marked) {
      lines.push('', `（当前绑定的是「${boundTitle === '' ? '(未命名)' : boundTitle}」，不在上面这些里）`)
    }
    return lines.join('\n')
  }

  /**
   * 用「标题」而不是 `session-<uuid>` 描述一个绑定的会话：id 是内部实现细节，
   * 对 IM 里的使用者没有意义（标题取不到就只说绑定状态，不退回打印 id）。
   * @param id - 绑定的 DSH 会话 id，或 undefined（未绑定）。
   * @param liveAgent - 该会话在内存里的 agent，或 undefined。
   * @returns 一句人话。
   */
  const describeSession = async (id, liveAgent) => {
    if (id === undefined) return '(未绑定，下条消息会新建)'
    const state = liveAgent === undefined ? '（未在内存中，下条消息会 resume）' : '（活跃）'
    const rows = [{ id, title: '' }]
    await fillTitles(rows)
    const title = rows[0]?.title ?? ''
    return title === '' ? `已绑定${state}` : `「${title}」${state}`
  }

  /**
   * 处理一条斜杠命令。
   * @param input - 原始消息文本（已 trim）。
   * @param chatId - 如流会话 id。
   * @returns `{ handled: true }` 表示已回复完毕；`{ handled: false, text }` 表示按普通消息继续（text 可能被改写，如 `/new 提示词`）。
   */
  const handleCommand = async (input, chatId) => {
    const spaceAt = input.search(/\s/u)
    const cmd = (spaceAt === -1 ? input : input.slice(0, spaceAt)).toLowerCase()
    const arg = spaceAt === -1 ? '' : input.slice(spaceAt).trim()

    if (cmd === '/help' || cmd === '/?') {
      await client.sendText(chatId, helpText())
      return { handled: true }
    }

    // ---- 待答交互（审批 / 模型提问）：`/1` `/2` …，无选项时直接回文字 ----
    const pendingAsk = pendingAsks.get(chatId)
    if (pendingAsk !== undefined) {
      const parsed = parseAnswerInput(input)
      if (parsed.picked !== undefined) {
        log('command-answer', { chatId, picked: parsed.picked })
        pendingAsk.resolve({ picked: parsed.picked })
        return { handled: true }
      }
      if (pendingAsk.expectsText && !input.startsWith('/')) {
        log('command-answer-text', { chatId, chars: input.length })
        pendingAsk.resolve({ text: parsed.text })
        return { handled: true }
      }
    } else if (/^\/(\d+(?:,\d+)*(?:\s+\d+(?:,\d+)*)*)$/u.test(input)) {
      // 没有待答项却收到 `/1` 这种：多半是过期卡片（另一边已经答过，或者超时了）。
      // 给一句提示，别把 "/1" 当正常消息丢给模型。
      log('command-answer-stale', { chatId, input })
      await client.sendText(chatId, '这一项已经在另一边答过了（或已超时），现在没有等待中的审批 / 选项。')
      return { handled: true }
    }

    if (cmd === '/status') {
      const bound = sessions.sessionOf(chatId)
      const liveAgent = bound === undefined ? undefined : ctx.agents.get(bound)
      await client.sendText(chatId, [
        '📌 **当前状态**',
        '',
        `会话：${await describeSession(bound, liveAgent)}`,
        `工作目录：\`${cwd}\``,
      ].join('\n'))
      return { handled: true }
    }

    if (cmd === '/list' || cmd === '/sessions') {
      lastListing = await listSessions()
      const bound = sessions.sessionOf(chatId)
      const rendered = renderSessions(lastListing, bound, await titleOfMissing(bound, lastListing))
      // 记一份渲染结果：IM 里发出去的内容在日志里看不到，排障时只能靠这行还原
      log('command-list', { chatId, count: lastListing.length, bound, preview: rendered.slice(0, 300) })
      await client.sendText(chatId, rendered)
      return { handled: true }
    }

    if (cmd === '/use' || cmd === '/switch' || cmd === '/resume') {
      const index = Number.parseInt(arg, 10)
      const picked = Number.isInteger(index) ? lastListing[index - 1] : undefined
      if (picked === undefined) {
        lastListing = await listSessions()
        const bound = sessions.sessionOf(chatId)
        const rendered = renderSessions(lastListing, bound, await titleOfMissing(bound, lastListing))
        await client.sendText(chatId, `没找到序号「${arg}」。先看看列表：\n\n${rendered}`)
        return { handled: true }
      }
      sessions.bind(chatId, picked.id)
      log('command-use', { chatId, sessionId: picked.id })
      const label = picked.title === '' ? `第 ${index} 个会话` : `「${picked.title}」`
      await client.sendText(chatId, `✅ 已切到${label}\n下一条消息就会进这个会话。`)
      return { handled: true }
    }

    if (cmd === '/end') {
      const bound = sessions.sessionOf(chatId)
      sessions.unbind(chatId)
      log('command-end', { chatId, sessionId: bound })
      await client.sendText(chatId, '🔚 已结束当前绑定。下条消息会开一个新会话（也可以 `/list` + `/use` 切回旧的）。')
      return { handled: true }
    }

    if (cmd === '/new') {
      const bound = sessions.sessionOf(chatId)
      sessions.unbind(chatId)
      log('command-new', { chatId, previousSessionId: bound, hasPrompt: arg !== '' })
      if (arg === '') {
        await client.sendText(chatId, '🆕 好，下条消息会开一个新会话。')
        return { handled: true }
      }
      return { handled: false, text: arg }
    }

    // 未知命令：当普通消息交给模型（避免用户以为发出去的是命令）
    return { handled: false, text: input }
  }

  /**
   * 处理一条已解析的入站消息：绑定/复用会话，把文本投成一次用户回合。
   * @param inbound - parseInbound 返回的 message 结果。
   */
  const handleInbound = async (inbound) => {
    const { chatId, text, messageId } = inbound
    if (!chatId || !text) return
    if (messageId !== undefined) lastInboundId.set(chatId, messageId)
    log('inbound', { chatId, chatType: inbound.chatType, senderId: inbound.senderId, messageId, chars: text.length, preview: text.slice(0, 80) })

    // 命令优先：斜杠开头的先交给命令层，处理完就不再进模型
    let prompt = text
    if (text.trim().startsWith('/')) {
      try {
        const result = await handleCommand(text.trim(), chatId)
        log('command', { chatId, input: text.slice(0, 40), handled: result.handled })
        if (result.handled) return
        prompt = result.text ?? text
      } catch (error) {
        log('command-failed', { chatId, error: describeError(error) })
        await client.sendText(chatId, `❌ 命令处理失败：${String(error?.message ?? error)}`).catch(() => {})
        return
      }
    }

    try {
      // 模型/提供商：create 与 resume 都必须显式给（dsh-bridge 两处都传）。
      // 不给的话回合会立刻以 error 结束 —— 表现为「会话建了/恢复了，但 step 一毫秒就挂」。
      const agentOptions = {}
      try {
        const def = ctx.get?.('agentDefaultModel')?.currentSelection?.()
        if (def?.provider) agentOptions.provider = def.provider
        if (def?.model) agentOptions.model = def.model
        log('agent-options-resolved', { agentOptions, resolved: def !== undefined && def !== null })
      } catch (error) {
        log('default-model-unavailable', { error: String(error?.message ?? error) })
      }
      const withOptions = Object.keys(agentOptions).length > 0 ? { agentOptions } : {}

      // agent preset 组装（等价 Web 会话控制器的 composeAgent / dsh-bridge 的
      // _composeAgentPreset）：create 与 resume 都要带 setup。不带的后果是 agent 的
      // scoped world 不完整 —— 回合能起来、能记 user/message，但 LLM 调用会以
      // TRANSPORT 失败（实测）。
      let composition = { agentPreset: undefined, setup: undefined }
      try {
        const presets = ctx.get?.('agentPresets')
        if (typeof presets?.resolve === 'function' && typeof presets?.mount === 'function') {
          const preset = await presets.resolve(config.agentPreset)
          // 先 acquire 再 mount —— 顺序与官方 dsh-webhook 一致
          await acquirePresetScope(presets, preset?.id)
          composition = {
            agentPreset: preset?.id,
            setup: async (agentCtx) => { await presets.mount(agentCtx, preset?.id) },
          }
        } else {
          log('preset-service-unavailable', {})
        }
      } catch (error) {
        log('preset-compose-failed', { error: describeError(error) })
      }
      log('preset-composed', { agentPreset: composition.agentPreset, hasSetup: composition.setup !== undefined })
      const withSetup = composition.setup === undefined ? {} : { setup: composition.setup }
      const meta = { cwd, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) }

      let agent = undefined
      const known = sessions.sessionOf(chatId)
      if (known !== undefined) agent = ctx.agents.get(known)
      // 宿主重启后，已绑定的会话不在内存里：先尝试 resume，失败再新建。
      if (known !== undefined && agent === undefined && typeof ctx.agents.resume === 'function') {
        try {
          const resumed = await ctx.agents.resume({ resumeSessionId: known, ...withOptions, ...withSetup })
          agent = resumed?.agent
          if (agent !== undefined) log('session-resumed', { chatId, sessionId: known })
        } catch (error) {
          log('resume-failed', { chatId, sessionId: known, error: describeError(error) })
        }
      }

      if (agent === undefined) {
        const sessionId = `session-${globalThis.crypto.randomUUID()}`
        const handle = await ctx.agents.create({
          sessionId,
          meta,
          ...withOptions,
          ...withSetup,
        })
        agent = handle?.agent
        if (agent === undefined) throw new Error('agents.create 未返回 agent')
        const bound = agent.session?.id ?? sessionId
        sessions.bind(chatId, bound)
        log('session-created', { chatId, sessionId: bound, agentOptions, meta })
        logger?.info?.('dsh-ruliu: 为如流会话 %s 新建 DSH 会话 %s', chatId, bound)
      } else {
        log('session-reused', { chatId, sessionId: known })
      }

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      log('followup-delivered', { chatId })
    } catch (error) {
      log('followup-failed', { chatId, error: describeError(error) })
      logger?.warn?.('dsh-ruliu: 投递失败：%s', String(error?.message ?? error))
      await client.sendText(chatId, `❌ 投递到 DSH 失败：${String(error?.message ?? error)}`).catch(() => {})
    }
  }

  // ---- 入站：如流回调路由 ----
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: webhookPath,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed')
        return
      }

      let raw = ''
      try {
        raw = await readBody(req)
      } catch (error) {
        logger?.warn?.('dsh-ruliu: 读取回调请求体失败：%s', String(error?.message ?? error))
        send(res, 413, 'text/plain; charset=utf-8', 'payload too large')
        return
      }
      log('webhook-hit', { contentType: String(req.headers?.['content-type'] ?? ''), bytes: raw.length })

      let parsed
      try {
        parsed = client.parseInbound(req, raw)
      } catch (error) {
        log('parse-threw', { error: String(error?.message ?? error) })
        logger?.warn?.('dsh-ruliu: 入站解析异常：%s', String(error?.message ?? error))
        send(res, 500, 'text/plain; charset=utf-8', 'failed to parse message')
        return
      }

      // 平台要求的应答（challenge 回显 / 403 / 400 / 500）原样返回
      if (parsed?.kind === 'reply') {
        log('respond-reply', { status: parsed.status, body: String(parsed.body).slice(0, 60) })
        // 解密失败 = 插件和如流后台的 AESKey 不一致（典型成因：密钥被重新生成过）。
        // 出站还是通的，所以主动往已知会话发一条告警 —— 否则用户只会看到"发消息没反应"。
        if (parsed.status === 500 && String(parsed.body) === 'decryption failed') {
          log('decrypt-failed', { bytes: raw.length })
          warnDecryptFailure()
        }
        send(res, parsed.status, parsed.contentType, parsed.body)
        return
      }

      // 消息与忽略都先秒回 success，再异步处理 —— 如流会重投，别让它等
      send(res, 200, 'text/plain; charset=utf-8', 'success')
      if (parsed?.kind === 'message') void handleInbound(parsed)
      else if (parsed?.kind === 'ignore') log('ignored', { reason: String(parsed.reason ?? '') })
    },
  }), 'dsh-ruliu: 如流回调路由')

  // ---- 手动注册：设置页「注册回调到如流」按钮打进来的口子 ----
  //
  // 回调路径的同级路径（`/dsh-ruliu/webhook` → `/dsh-ruliu/register`）。只做同源
  // 校验：带 Origin 的请求必须和 Host 一致，挡掉别的站点顺手改注册。这个口子不
  // 回显任何密钥，只返回注册结果。
  const registerPath = `${webhookPath.replace(/\/[^/]*$/u, '')}/register`
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: registerPath,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed')
        return
      }
      const origin = String(req.headers?.origin ?? '')
      const host = String(req.headers?.host ?? '')
      if (origin !== '' && !origin.endsWith(`//${host}`)) {
        log('callback-register-rejected', { origin, host })
        send(res, 403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, message: 'cross-origin request rejected' }))
        return
      }
      let raw = ''
      try {
        raw = await readBody(req)
      } catch {
        /* 空体也允许：用配置/推导出的地址 */
      }
      let payload = {}
      try {
        payload = raw === '' ? {} : JSON.parse(raw)
      } catch {
        payload = {}
      }
      const result = await registerRuliuCallback({
        callbackUrl: typeof payload?.callbackUrl === 'string' ? payload.callbackUrl : '',
        origin: typeof payload?.origin === 'string' ? payload.origin : origin,
        trigger: 'manual',
      })
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(result))
    },
  }), 'dsh-ruliu: 回调注册路由')

  // ---- 审批桥 / 提问桥：如流和 Web 页面**同时**弹，谁先答谁生效 ----
  //
  // `approval/request` 和 `user-questions/request` 都是 waterfall，宿主会把它们转发给
  // 浏览器（dsh-api-remotes），那个转发器比本插件先注册。所以这里用 prepend 站到链首，
  // 但**不抢答**：发一条到如流之后照样调用 next() 让 Web 那路也弹卡片，然后 race 两路。
  // 只有「由如流驱动的会话」才介入；其它会话直接 next()，行为完全不变。
  //
  // 两个细节：
  //  - next() 在"没有别的 answerer"时会立刻给出结论（审批是 'unavailable'，提问是
  //    抛 NO_PROVIDER）。那种结论不代表用户回答了，必须忽略掉继续等如流，否则 race
  //    会被它瞬间判负。
  //  - 如流这路赢了之后，Web 那边的卡片不会自动收掉（没有取消 API），它会自己超时/关闭。
  /** chatId → 待答项：{ expectsText, resolve }。一次只有一个。 */
  const pendingAsks = new Map()
  /** 永不 settle：用来把"没有别的 answerer"这类结论从 race 里排除掉。 */
  const NEVER = new Promise(() => {})

  /**
   * 发一条待答消息到如流，并返回「等回答」的句柄。
   *
   * 故意不设超时：Web GUI 也是"一直等着"的语义。只有回合被取消（signal abort）或
   * 发送失败才收尾 —— 发送失败会让调用方 next() 完全交回 Web。
   * @param chatId - 如流会话 id。
   * @param text - 待答消息正文（自带 `/1`、`/2` 提示）。
   * @param options - { signal, expectsText }。
   * @returns {Promise<{sent: boolean, promise?: Promise, cancel?: () => void}>}
   */
  const askInRuliu = async (chatId, text, options = {}) => {
    try {
      await client.sendText(chatId, text)
    } catch (error) {
      log('ask-send-failed', { chatId, error: describeError(error) })
      return { sent: false }
    }
    let settle
    const promise = new Promise((resolve) => { settle = resolve })
    // 同一个聊天只留一个待答项：旧的按"取消"结算，避免回答张冠李戴
    pendingAsks.get(chatId)?.resolve({})
    const entry = { expectsText: options.expectsText === true }
    entry.resolve = (value) => {
      if (pendingAsks.get(chatId) === entry) pendingAsks.delete(chatId)
      settle({ sent: true, ...value })
    }
    pendingAsks.set(chatId, entry)
    const signal = options.signal
    if (signal !== undefined) {
      if (signal.aborted) entry.resolve({})
      else signal.addEventListener('abort', () => entry.resolve({}), { once: true })
    }
    return { sent: true, promise, cancel: () => entry.resolve({}) }
  }

  /**
   * 把「等 Web 那路」包成 race 候选。
   *
   * Web 那路的两种"非回答"结论必须排除掉，否则 race 会被瞬间判负：
   *  - 审批：没有别的 answerer 时 resolve `'unavailable'`；
   *  - 提问：没有别的 answerer 时 reject `NO_PROVIDER`（还有被取消时的 reject）。
   * 提问的 resolve 一定是真回答（浏览器里点了），所以两种事件的判定不同。
   * @param promise - next() 的返回值。
   * @param options - { fulfilledIsAnswer }：resolve 是否算用户回答。
   * @returns {Promise<{source: 'web', value?: any, error?: any}>}
   */
  const raceWeb = (promise, options = {}) => promise.then(
    (value) => {
      if (options.fulfilledIsAnswer === true) return { source: 'web', value }
      return value === options.noAnswererValue ? NEVER : { source: 'web', value }
    },
    (error) => (options.rejectionIsAnswer === true ? { source: 'web', error } : NEVER),
  )

  ctx.effect(() => ctx.on('approval/request', async (req, next) => {
    const chatId = sessions.chatOf(req?.agent?.session?.id)
    if (chatId === undefined) return next()
    const reason = String(req?.reason ?? req?.displayReason?.zh ?? req?.displayReason?.en ?? '')
    const bridged = await askInRuliu(chatId, `${renderApproval({ toolName: req?.toolName, reason })}\n\n（Web 页面里也有同一张卡片，两边答一边就行）`, { signal: req?.signal })
    if (!bridged.sent) return next()
    const first = await Promise.race([
      // 审批：resolve 的 'unavailable' 表示没有别的 answerer，不算回答；reject 同理
      raceWeb(next(), { noAnswererValue: 'unavailable' }),
      bridged.promise.then((answer) => ({ source: 'im', answer })),
    ])
    if (first.source === 'web') {
      bridged.cancel()
      log('approval-answered', { chatId, toolName: req?.toolName, callId: req?.callId, outcome: first.value, via: 'web' })
      return first.value
    }
    const outcome = buildApprovalOutcome(first.answer.picked) ?? 'cancelled'
    log('approval-answered', { chatId, toolName: req?.toolName, callId: req?.callId, outcome, via: 'ruliu' })
    return outcome
  }, { prepend: true }), 'dsh-ruliu: 审批桥')

  ctx.effect(() => ctx.on('user-questions/request', async (request, next) => {
    const agent = request?.agent
    const chatId = sessions.chatOf(agent?.session?.id)
    if (chatId === undefined) return next()
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return next()
    const expectsText = questions.some((question) => !Array.isArray(question?.options) || question.options.length === 0)
    const bridged = await askInRuliu(chatId, `${renderQuestions(questions)}\n\n（Web 页面里也有同一张卡片，两边答一边就行）`, { signal: request?.signal, expectsText })
    if (!bridged.sent) return next()
    const first = await Promise.race([
      // 提问：resolve 一定是浏览器里的真回答；reject（NO_PROVIDER / 取消）继续等如流
      raceWeb(next(), { fulfilledIsAnswer: true }),
      bridged.promise.then((answer) => ({ source: 'im', answer })),
    ])
    if (first.source === 'web') {
      bridged.cancel()
      log('question-answered', { chatId, via: 'web' })
      return first.value
    }
    const choice = first.answer.picked === undefined
      ? (first.answer.text === undefined ? undefined : { text: first.answer.text })
      : { picked: first.answer.picked }
    const answers = choice === undefined ? [] : buildAnswers(questions, choice)
    if (answers === undefined) return { answers: [] }
    // ask_user_question 默认 120 秒就超时：超时后问题变成 continued，只能用
    // answer() 按"迟到回复"补交；仍在等的问题 answer() 返回 false，交给返回值结算。
    const callId = request?.wait?.callId
    const userQuestions = ctx.get?.('userQuestions')
    if (callId !== undefined && agent !== undefined && typeof userQuestions?.answer === 'function') {
      try {
        if (userQuestions.answer(agent, callId, { answers }) === true) log('question-answered-late', { chatId, callId })
      } catch (error) {
        log('question-answer-failed', { chatId, callId, error: describeError(error) })
      }
    }
    log('question-answered', { chatId, callId, count: answers.length, via: 'ruliu' })
    return { answers }
  }, { prepend: true }), 'dsh-ruliu: 提问桥')

  // ---- 解密失败告警：出站不依赖 AESKey，所以还能把话说明白 ----
  /** 同一类故障 10 分钟最多提醒一次，避免刷屏。 */
  let lastDecryptWarnAt = 0

  /**
   * 如流推来的消息解不开时，主动往已知会话发一条告警。
   *
   * 没有这个的话，用户只会看到「在如流发消息没反应」—— 因为解密失败发生在入站，
   * 模型那边根本不知道有人说过话。
   */
  const warnDecryptFailure = () => {
    const now = Date.now()
    if (now - lastDecryptWarnAt < 10 * 60 * 1000) return
    lastDecryptWarnAt = now
    const chatId = sessions.knownChats()[0]
    if (chatId === undefined) return
    void client.sendText(chatId, '⚠️ 如流推来的消息解不开：插件里的 encodingAESKey 和如流后台「接收消息服务器」里的不一致（多半是密钥被重新生成过）。请在「设置 → 如流」里核对，或打开 autoRegisterCallback 让插件重新注册。')
      .then(() => log('decrypt-warned', { chatId }))
      .catch((error) => log('decrypt-warn-failed', { chatId, error: describeError(error) }))
  }

  // ---- 出站：把 assistant 文本发回如流 ----
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    // 先记活跃时间，且必须在「是否绑定了如流会话」的提前返回之前：
    // /list 的排序对全部会话都要用，不只是本插件建的。
    if (session?.id !== undefined && typeof event?.time === 'number') {
      activityAt.set(session.id, event.time)
    }
    const chatId = sessions.chatOf(session?.id)
    if (chatId === undefined) return
    // 本轮相关事件全记：排障时能看出「回合有没有真的跑起来、为什么结束」
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason
      log('turn-end', {
        chatId,
        kind: reason?.kind ?? '(none)',
        error: describeError(reason?.error),
        reasonRaw: (() => { try { return JSON.stringify(reason).slice(0, 300) } catch { return '(unserializable)' } })(),
      })
    } else if (event?.type !== 'assistant/message') {
      log('session-event', { chatId, type: event?.type })
    }
    if (event?.type !== 'assistant/message') return
    const text = textOfAssistantMessage(event.data?.message)
    if (text === '') return
    log('outbound-attempt', { chatId, chars: text.length })
    void client.sendText(chatId, text, lastInboundId.get(chatId))
      .then(() => log('outbound-sent', { chatId }))
      .catch((error) => {
        log('outbound-failed', { chatId, error: String(error?.message ?? error) })
        logger?.warn?.('dsh-ruliu: 出站发送失败：%s', String(error?.message ?? error))
      })
  }), 'dsh-ruliu: assistant 出站')

  // 插件卸载时释放 preset scope（与 acquirePresetScope 配对）
  ctx.effect(() => () => {
    for (const scope of presetScopes.values()) {
      try { scope?.[Symbol.asyncDispose]?.() } catch { /* best effort */ }
    }
    presetScopes.clear()
  }, 'dsh-ruliu: preset scope cleanup')

  log('mounted', { webhookPath, stateDir, apiHost: config.apiHost ?? '(default)', cwd })

  logger?.info?.('dsh-ruliu: 已挂载，回调 %s，状态目录 %s', webhookPath, stateDir)
}
