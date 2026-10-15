/**
 * 命令层联调脚本：往**正在运行的** dsh 的 webhook 路由注入斜杠命令，
 * 看插件是否按预期处理。命令不进模型，不烧 token。
 *
 * 需要真实凭证（要和 profile 里配的一致），所以从环境变量读，不写进仓库：
 *
 *   RULIU_AES_KEY='<encodingAESKey>' \
 *   RULIU_CHECK_TOKEN='<checkToken>' \
 *   RULIU_FROM_USER='<你的如流 uid>' \
 *   node test/commands.test.mjs /list /status
 *
 * ⚠️ 注入的 FromUserId 会被当成真实用户，机器人会把回复**真的发到那个如流会话**里。
 * 也正因如此：别随手注入 `/use` —— 它会把那个聊天重新绑到别的 DSH 会话上。
 *
 * 环境变量：
 *   RULIU_WEBHOOK      默认 http://127.0.0.1:8080/dsh-ruliu/webhook
 *   RULIU_AES_KEY      必填，encodingAESKey（原始 22 位）
 *   RULIU_CHECK_TOKEN  必填，回调验证 token
 *   RULIU_FROM_USER    默认 zhangruihao
 *   RULIU_STATE_DIR    默认 $DSH_HOME/profiles/web/.dsh-ruliu（用来读日志）
 */
import { createCipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AES_KEY_STR = process.env.RULIU_AES_KEY ?? ''
const CHECK_TOKEN = process.env.RULIU_CHECK_TOKEN ?? ''
const FROM_USER = process.env.RULIU_FROM_USER ?? 'zhangruihao'
const WEBHOOK = process.env.RULIU_WEBHOOK ?? 'http://127.0.0.1:8080/dsh-ruliu/webhook'
const STATE_DIR = process.env.RULIU_STATE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web', '.dsh-ruliu')
const commands = process.argv.slice(2)

if (AES_KEY_STR === '' || CHECK_TOKEN === '') {
  console.error('缺 RULIU_AES_KEY / RULIU_CHECK_TOKEN，见文件头注释')
  process.exit(2)
}
if (commands.length === 0) {
  console.error('至少给一个要注入的命令，例如：node test/commands.test.mjs /list')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const key = Buffer.from(AES_KEY_STR.replaceAll('-', '+').replaceAll('_', '/') + '==', 'base64')
const encrypt = (plain) => {
  const c = createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
  return Buffer.concat([c.update(plain, 'utf8'), c.final()])
    .toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
const post = (body) => fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body,
  signal: AbortSignal.timeout(10000),
})

// 1. 先探活：路由挂上了才继续
const ts = String(Math.floor(Date.now() / 1000))
const rn = 'probe'
let mounted = false
for (let i = 1; i <= 5; i++) {
  try {
    const r = await post(new URLSearchParams({
      echostr: 'probe', signature: md5(`${rn}${ts}${CHECK_TOKEN}`), timestamp: ts, rn,
    }).toString())
    if (r.status === 200 && (await r.text()) === 'probe') { mounted = true; break }
  } catch { /* 路由还没挂上，重试 */ }
  await sleep(2000)
}
if (!mounted) { console.error(`✗ 路由没挂上或验签不过：${WEBHOOK}`); process.exit(1) }
console.log(`✓ 路由已挂载 ${WEBHOOK}`)

// 2. 逐条注入
let seq = 0
for (const text of commands) {
  seq += 1
  const bigId = `18598${String(Date.now()).slice(-13)}${seq}`
  const plain = `{"MsgType":"text","FromUserId":"${FROM_USER}","FromUserName":"${FROM_USER}",`
    + `"Content":"${text}","CreateTime":"${Math.floor(Date.now() / 1000)}","MsgId":${bigId}}`
  const r = await post(new URLSearchParams({ messageJson: JSON.stringify({ Encrypt: encrypt(plain) }) }).toString())
  console.log(`✓ 注入 ${text} -> HTTP ${r.status} ${(await r.text()).slice(0, 20)}`)
  await sleep(3000)
}

// 3. 打日志尾巴（命令类回复不写 outbound-attempt，看 command 事件即可）
await sleep(4000)
console.log(`\n插件日志（${join(STATE_DIR, 'log.ndjson')} 最近 12 行）：`)
try {
  for (const line of readFileSync(join(STATE_DIR, 'log.ndjson'), 'utf8').trim().split('\n').slice(-12)) {
    console.log('   ', line.slice(0, 200))
  }
} catch (error) {
  console.log('    (读不到日志：', error.message, ')')
}
