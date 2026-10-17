window.__ModuleLoader__.load({
  id: 'dsh-ruliu',
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
    'use strict'
    
    const React = require('react')
    const {
      SettingsForm, SettingsSecretField, SettingsValueField, Checkbox, Button,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'dsh-ruliu'
    const SECRETS = ['appKey', 'appSecret', 'checkToken', 'encodingAESKey']
    const VALUES = ['enabled', 'agentId', 'apiHost', 'webhookPath', 'cwd', 'msgType']
    const DEFAULTS = Object.freeze({
      enabled: false, apiHost: 'https://api.im.baidu.com',
      webhookPath: '/dsh-ruliu/webhook', cwd: '', msgType: 'text',
    })
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
    const effective = (view, key) => view?.value?.[key] ?? DEFAULTS[key]
    const format = (value) => value === undefined ? '' : String(value)
    
    /** No redacted section is ever spread into a replacement or a draft. */
    function buildMutation(base, draft) {
      const ops = []
      for (const key of VALUES) {
        if (!own(draft, key)) continue
        const text = draft[key]
        let value = text
        if (key === 'enabled') value = Boolean(text)
        else if (key === 'agentId') {
          const trimmed = String(text).trim()
          if (trimmed === '') {
            if (effective(base, key) !== undefined) ops.push({ op: 'unset', path: [key] })
            continue
          }
          value = Number(trimmed)
          if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value)) {
            throw new Error('机器人 ID 必须是安全范围内的非负整数，或留空。')
          }
        } else if (key !== 'cwd') {
          value = String(text).trim()
          if (value === '') value = DEFAULTS[key]
        }
        if (key === 'msgType' && !['text', 'md'].includes(value)) throw new Error('消息类型只能是 text 或 md。')
        if (key === 'webhookPath' && (!value.startsWith('/') || value.startsWith('//') || /[?#\s]/.test(value))) {
          throw new Error('回调路径必须以单个 / 开头，且不含空白、查询或片段。')
        }
        if (key === 'apiHost') {
          let valid = false
          try { valid = ['http:', 'https:'].includes(new URL(value).protocol) } catch {}
          if (!valid) throw new Error('API 地址必须是有效的 HTTP 或 HTTPS URL。')
        }
        if (value !== effective(base, key)) ops.push({ op: 'set', path: [key], value })
      }
      for (const key of SECRETS) {
        if (typeof draft[key] === 'string' && draft[key].trim() !== '') {
          ops.push({ op: 'set', path: [key], value: draft[key] })
        }
      }
      return ops
    }
    
    function callbackURL(origin, path) {
      const route = String(path || DEFAULTS.webhookPath).trim()
      if (!route.startsWith('/') || route.startsWith('//') || /[?#\s]/.test(route)) return ''
      return origin ? origin.replace(/\/$/, '') + route : ''
    }
    
    /** Local snapshot store: drafts stay fenced to the revision at their first edit. */
    class RuliuSettingsController {
      constructor(remote, mirror) {
        this.remote = remote
        this.mirror = mirror
        this.listeners = new Set()
        this.draft = {}
        this.base = undefined
        this.latest = undefined
        this.document = undefined
        this.loading = false
        this.saving = false
        this.error = ''
        this.success = false
        this.conflict = false
        this.disposed = false
        this.generation = 0
        this.getSnapshot = () => this.snapshot
        this.subscribe = (listener) => {
          this.listeners.add(listener)
          return () => this.listeners.delete(listener)
        }
        this.publish()
      }
    
      publish() {
        if (this.disposed) return
        let ops = [], invalid = ''
        try { ops = buildMutation(this.base, this.draft) } catch (error) { invalid = error.message }
        this.snapshot = {
          base: this.base, latest: this.latest, draft: { ...this.draft },
          available: Boolean(this.latest), loading: this.loading, saving: this.saving,
          writable: this.document?.writable === true,
          dirty: ops.length > 0 || Boolean(invalid), invalid, error: this.error,
          conflict: this.conflict, success: this.success,
        }
        for (const listener of this.listeners) listener()
      }
    
      acceptDocument(document, rebase = false) {
        this.document = document
        this.latest = document?.namespaces?.find((row) => row.ns === NS)
        if (rebase || !Object.keys(this.draft).length) this.base = this.latest
        this.publish()
      }
    
      /** Mirror is shared on loopback; LAN's memory mirror falls back to Remote. */
      async load(rebase = false) {
        if (this.disposed || this.saving) return false
        const generation = ++this.generation
        this.loading = true
        this.error = ''
        this.success = false
        this.publish()
        try {
          const response = await this.remote.describe()
          if (this.disposed || generation !== this.generation) return false
          if (!response.ok) throw new Error(response.error?.message || '远程设置读取被拒绝。')
          this.acceptDocument(response.value, rebase)
          if (rebase) this.conflict = false
          // acceptView only folds a namespace into an already populated mirror.
          if (this.latest) this.mirror?.acceptView(this.latest)
          return true
        } catch (error) {
          if (!this.disposed && generation === this.generation) {
            this.error = `加载失败：${error?.message || String(error)}。草稿已保留。`
          }
          return false
        } finally {
          if (!this.disposed && generation === this.generation) {
            this.loading = false
            this.publish()
          }
        }
      }
    
      edit(key, text) {
        if (!VALUES.includes(key) && !SECRETS.includes(key)) return
        if (this.saving || !this.latest || !this.document?.writable) return
        if (!Object.keys(this.draft).length) this.base = this.latest
        this.draft = { ...this.draft, [key]: text }
        const unchanged = SECRETS.includes(key)
          ? String(text).trim() === ''
          : key === 'enabled' ? text === effective(this.base, key) : text === format(effective(this.base, key))
        if (unchanged) delete this.draft[key]
        if (!Object.keys(this.draft).length) this.base = this.latest
        this.error = ''
        this.success = false
        this.publish()
      }
    
      discard() {
        if (this.saving) return
        this.draft = {}
        this.base = this.latest
        this.error = ''
        this.success = false
        this.conflict = false
        this.publish()
      }
    
      async save() {
        if (this.disposed || this.saving || this.loading || this.conflict || !this.latest || !this.document?.writable) return false
        let ops
        try { ops = buildMutation(this.base, this.draft) } catch (error) {
          this.error = error.message
          this.publish()
          return false
        }
        if (!ops.length) return false
        // Freeze the fence from the accepted view on which these drafts began.
        const revision = this.base?.revision
        if (typeof revision !== 'number') {
          this.error = '设置版本不可用，请重新加载。草稿已保留。'
          this.publish()
          return false
        }
        this.saving = true
        this.success = false
        this.error = ''
        this.publish()
        try {
          const response = await this.remote.mutate(NS, ops, revision)
          if (this.disposed) return false
          if (!response.ok) {
            this.conflict = response.error?.code === 'settings/conflict'
            this.error = this.conflict
              ? '设置已被其他位置修改。草稿已保留，请重新加载后检查并再次保存。'
              : `保存被拒绝：${response.error?.message || '远程未接受设置'}。草稿已保留。`
            return false
          }
          ++this.generation // Ignore any describe that began before this commit.
          this.loading = false
          this.draft = {} // Including every write-only secret draft.
          this.base = this.latest = response.value
          this.document = { ...this.document, namespaces: this.document.namespaces.map((row) => row.ns === NS ? response.value : row) }
          this.conflict = false
          this.success = true
          this.mirror?.acceptView(response.value)
          return true
        } catch (error) {
          if (!this.disposed) this.error = `保存失败：${error?.message || String(error)}。草稿已保留，可重试。`
          return false
        } finally {
          this.saving = false
          this.publish()
        }
      }
    
      start() {
        const sync = () => {
          const view = this.mirror?.getSnapshot().view
          if (view) this.acceptDocument(view)
        }
        this.offMirror = this.mirror?.subscribe(sync)
        sync()
        Promise.resolve(this.mirror?.ensure()).catch(() => {})
        return this.load()
      }
    
      dispose() {
        this.disposed = true
        ++this.generation
        this.offMirror?.()
        this.draft = {}
        this.listeners.clear()
      }
    }
    
    const secretCopy = {
      appKey: ['AppKey', '来源：如流开放平台的应用详情页。'],
      appSecret: ['AppSecret', '来源：如流开放平台同一应用的详情页；填写原始值，无需手动 MD5。'],
      checkToken: ['checkToken（回调校验 Token）', '来源：如流开放平台「接收消息服务器」；两边须填写同一 Token。'],
      encodingAESKey: ['AESKey（消息加密 Key）', '来源：如流开放平台「接收消息服务器」的 EncodingAESKey。'],
    }
    const layout = { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720, color: 'var(--dsw-alias-label-primary)' }
    const hintStyle = { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 }
    
    function RuliuSettingsSection({ controller }) {
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
      const [copyState, setCopyState] = React.useState('')
      const disabled = !state.writable || state.saving || state.loading
      const displayed = (key) => own(state.draft, key) ? state.draft[key] : effective(state.base, key)
      const url = callbackURL(globalThis.location?.origin || '', displayed('webhookPath'))
      const valueField = (key, label, hint, extra = {}) => h(SettingsValueField, {
        key, id: `ruliu-${key}`, label, hint, disabled,
        text: format(displayed(key)), overridden: false,
        invalid: key === 'agentId' && Boolean(state.invalid?.includes('机器人 ID')),
        invalidLabel: state.invalid, onEdit: (text) => controller.edit(key, text), ...extra,
      })
      const configured = (key) => state.latest?.secrets?.some((entry) => entry.path.length === 1 && entry.path[0] === key && entry.set) === true
      const copy = async () => {
        try {
          if (!globalThis.navigator?.clipboard?.writeText) throw new Error('当前浏览器未开放剪贴板，请选中地址手动复制。')
          await globalThis.navigator.clipboard.writeText(url)
          setCopyState('回调 URL 已复制。')
        } catch (error) { setCopyState(error?.message || '复制失败，请选中地址手动复制。') }
      }
      return h('section', { style: layout, 'aria-label': '如流设置' },
        h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 500 } }, '如流'),
        h('p', { style: hintStyle }, '填写如流机器人的 ID 与应用凭证，连接如流消息和 DSH 会话。'),
        state.loading && h('p', { role: 'status', style: hintStyle }, '正在加载如流设置…'),
        state.error && h('p', { role: 'alert', style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary)' } }, state.error),
        state.success && h('p', { role: 'status', style: { ...hintStyle, color: 'var(--dsw-alias-state-success-primary)' } }, '如流设置已保存。'),
        h('div', null, h(Button, {
          type: 'button', variant: 'secondary', disabled: state.loading || state.saving,
          onClick: () => controller.load(true),
        }, state.conflict ? '重新加载（保留草稿）' : '重新加载')),
        h(SettingsForm, {
          labels: {
            unavailable: state.loading ? '正在加载…' : '如流插件尚未提供设置，请确认 Host 已加载 dsh-ruliu 后重新加载。',
            readOnly: '当前部署的设置为只读，无法保存。', save: '保存', saving: '保存中…', saveFailed: '',
          },
          state: { ...state, dirty: state.dirty && state.writable, invalid: Boolean(state.invalid) || state.conflict || state.loading },
          onSave: () => controller.save(), onDiscard: () => controller.discard(),
        },
        h(Checkbox, { checked: Boolean(displayed('enabled')), disabled, label: '启用如流机器人', onChange: (checked) => controller.edit('enabled', checked) }),
        valueField('agentId', '机器人 ID（Agent ID）', '来源：如流开放平台的机器人 / 应用详情页；可留空 —— 留空时发消息不带 agentid。', { numeric: true }),
        ...SECRETS.map((key) => h(SettingsSecretField, {
          key, id: `ruliu-${key}`, label: secretCopy[key][0],
          hint: `${secretCopy[key][1]} 留空保留当前值，输入新值后保存以替换。`,
          disabled, text: state.draft[key] || '', configured: configured(key),
          stateLabel: configured(key) ? '已配置（Host）' : '未配置',
          onEdit: (text) => controller.edit(key, text),
        })),
        !SECRETS.every(configured) && h('p', { role: 'status', style: hintStyle }, '凭证尚未配置完整；启用前请填写四项凭证。'),
        h('details', null,
          h('summary', { style: { cursor: 'pointer', marginBottom: 12 } }, '高级设置'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
            valueField('apiHost', 'API 地址', '默认 https://api.im.baidu.com；可填写当前部署使用的如流 API 地址。'),
            valueField('webhookPath', '回调路径', '默认 /dsh-ruliu/webhook；保存后须与如流后台回调地址一致。'),
            valueField('cwd', '会话工作目录', '填写 DSH Host 上的工作目录；留空使用 Host 默认目录。'),
            valueField('msgType', '消息类型', '填写 text（纯文本）或 md（Markdown）；默认 text。'),
          )),
        state.invalid && h('p', { role: 'alert', style: hintStyle }, state.invalid),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('label', { htmlFor: 'ruliu-callback-url' }, '回调 URL'),
          h('input', { id: 'ruliu-callback-url', readOnly: true, value: url, 'aria-label': '回调 URL', onFocus: (event) => event.target.select(), style: { width: '100%', boxSizing: 'border-box', color: 'inherit', background: 'var(--dsw-alias-settings-card-fill)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: 10 } }),
          h('div', null, h(Button, { type: 'button', variant: 'secondary', disabled: !url, onClick: copy }, '复制回调 URL')),
          h('p', { style: hintStyle }, '地址按当前浏览器 origin 与回调路径生成；路径修改后请先保存。请确保如流服务器能访问该地址；本机 localhost / 127.0.0.1 通常不可达。'),
          copyState && h('p', { role: 'status', style: hintStyle }, copyState),
        )),
      )
    }
    
    const inject = ['slots', 'configForms', 'remote', 'remote.settings']
    function apply(ctx) {
      const controller = new RuliuSettingsController(ctx.remote.settings, ctx.configForms.describe())
      ctx.effect(() => {
        controller.start()
        const refresh = () => controller.load()
        const off = [
          ctx.remote.$on('settings/document-updated', refresh),
          ctx.on('connection/reset', refresh),
        ]
        return () => { for (const dispose of off) dispose(); controller.dispose() }
      }, 'dsh-ruliu: settings state')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'ruliu', order: 45, label: () => '如流',
        inject: () => ({ controller }),
      }, RuliuSettingsSection))
    }
    
    module.exports = { inject, apply, buildMutation, callbackURL, RuliuSettingsController }
    return module.exports;
  }
});
