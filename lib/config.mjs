import z from '@deepseek-ai/schemastery'

// A single volatile snapshot makes every save atomic for the running transport.
// Secret roles also redact values from schema defaults and inherited/user layers.
export const Config = z.object({
  enabled: z.boolean().default(false),
  appKey: z.string().role('secret'),
  appSecret: z.string().role('secret'),
  agentId: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  checkToken: z.string().role('secret'),
  encodingAESKey: z.string().role('secret'),
  apiHost: z.string().default('https://api.im.baidu.com'),
  webhookPath: z.string().default('/dsh-ruliu/webhook'),
  // 如流服务器能访问到的完整回调地址；留空则按「浏览器 origin → DSH_WEB_URL →
  // 探测到的内网地址」推导。见 lib/callback.mjs 的 deriveCallbackURL。
  publicCallbackUrl: z.string().default(''),
  cwd: z.string().default(''),
  msgType: z.union(['text', 'md']).default('text'),
  agentPreset: z.string(),
  stateDir: z.string(),
}).volatile()

export function validateConfiguration(config) {
  let endpoint
  try { endpoint = new URL(config.apiHost) } catch { throw new Error('接口地址必须是有效的 HTTP 或 HTTPS 地址。') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('接口地址必须使用 HTTP 或 HTTPS，且不包含用户名、密码、查询参数或片段。')
  }
  if (!/^\/(?!\/)[^?#\s]*$/u.test(config.webhookPath)) throw new Error('回调路径必须以单个 / 开头，且不包含空格、查询参数或片段。')
  if (!config.enabled) return
  // 真正必须由用户提供的只有应用凭证这两项：如流只发这两个。
  for (const [field, label] of Object.entries({ appKey: 'AppKey', appSecret: 'AppSecret' })) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') throw new Error(`启用如流前请填写 ${label}。`)
  }
  // checkToken / encodingAESKey 留空时由插件随机生成并调 updateReCallUrl 注册到如流
  // （token 和 AESKey 本来就是调用方生成后告诉如流的，不是如流下发的）。填了才校验格式。
  const aes = String(config.encodingAESKey ?? '').trim()
  if (aes !== '' && (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(aes) || ![16, 24, 32].includes(Buffer.from(aes, 'base64url').length))) {
    throw new Error('消息加密 AES Key 格式不正确，请填写如流平台提供的 Base64 密钥，或留空由插件生成。')
  }
  // 机器人 ID 可选：设置页写的是「可留空」，客户端把留空转成 unset，发送路径也是有值
  // 才带 agentid（lib/ruliu.mjs）。之前这里强制正整数，和另外三处口径冲突 —— 表现是
  // 提示说可留空、真留空却存不下去。填了仍然必须是正整数（schema 先卡一道，这里是
  // 最后一道防线）。
  if (config.agentId !== undefined && (!Number.isSafeInteger(config.agentId) || config.agentId <= 0)) {
    throw new Error('机器人 Agent ID 必须是正整数，或留空。')
  }
}
