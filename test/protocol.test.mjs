/**
 * dsh-ruliu 协议客户端的离线自测：按规格自己造密文喂进 parseInbound。
 * 不联网、不需要真实凭证。
 *
 * 注意：大整数 id 必须用【字符串拼接】造 JSON 文本，不能用 JS 数字字面量
 * —— 后者在 JS 解析阶段就被截断了（这正是协议里的坑 #1）。
 */
import { createCipheriv, createHash } from 'node:crypto'
import { createRuliuClient } from "../lib/ruliu.mjs"

const KEY_RAW = '0123456789abcdef' // 16 字节 → aes-128-ecb
const AES_KEY_B64URL = Buffer.from(KEY_RAW, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const CHECK_TOKEN = 'tok3nABC'

const client = createRuliuClient({
  appKey: 'testAppKey',
  appSecret: 'testAppSecret',
  checkToken: CHECK_TOKEN,
  encodingAESKey: AES_KEY_B64URL,
}, { warn: (...a) => console.log('  [warn]', ...a), debug: () => {} })

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const enc = (plain) => {
  const c = createCipheriv('aes-128-ecb', Buffer.from(KEY_RAW, 'utf8'), null)
  return Buffer.concat([c.update(plain, 'utf8'), c.final()])
    .toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
const req = (contentType) => ({ headers: { 'content-type': contentType } })

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

console.log('\n[0] 先证明坑是真的：JS 数字字面量会截断')
{
  const truncated = JSON.parse('{"MsgId":1859713223686736431}').MsgId
  check('JSON.parse 确实截断（所以必须正则抠原文）', String(truncated) === '1859713223686736400', String(truncated))
}

console.log('\n[1] challenge（URL 校验）')
{
  const timestamp = '1730000000'
  const rn = 'abc123'
  const echostr = 'echo-me-42'
  const good = new URLSearchParams({ echostr, signature: md5(`${rn}${timestamp}${CHECK_TOKEN}`), timestamp, rn }).toString()
  const r1 = client.parseInbound(req('application/x-www-form-urlencoded'), good)
  check('签名正确 → 200 回显 echostr', r1.kind === 'reply' && r1.status === 200 && r1.body === echostr, JSON.stringify(r1))

  const bad = new URLSearchParams({ echostr, signature: 'deadbeef', timestamp, rn }).toString()
  const r2 = client.parseInbound(req('application/x-www-form-urlencoded'), bad)
  check('签名错误 → 403', r2.kind === 'reply' && r2.status === 403, JSON.stringify(r2))
}

console.log('\n[2] 单聊消息（form + messageJson，含大整数 id）')
{
  const BIG = '1859713223686736431'
  const plain = `{"MsgType":"text","FromUserId":"chengbo05","FromUserName":"程波","Content":"你好，帮我看看这个 bug","CreateTime":"1730000000","MsgId":${BIG}}`
  const form = new URLSearchParams({ messageJson: JSON.stringify({ Encrypt: enc(plain) }) }).toString()
  const r = client.parseInbound(req('application/x-www-form-urlencoded'), form)
  check('解析出 message', r.kind === 'message', JSON.stringify(r))
  check('chatId = private:chengbo05', r.chatId === 'private:chengbo05', r.chatId)
  check('文本正确', r.text === '你好，帮我看看这个 bug', r.text)
  check('大整数 id 精确', r.messageId === BIG, `${r.messageId} (期望 ${BIG})`)
}

console.log('\n[3] 群聊消息（text/plain 整体密文）')
{
  const BIG = '1859713223686736999'
  const plain = `{"eventtype":"MESSAGE_RECEIVE","groupid":123456789,"fromid":"300010331","message":{"header":{"fromuserid":"zhangsan","toid":123456789,"totype":"GROUP","msgtype":"text","messageid":${BIG}},"body":[{"type":"TEXT","content":"hello "},{"type":"AT","name":"MyBot","robotid":123},{"type":"TEXT","content":"world"},{"type":"replyData","content":"被引用的原文","messageid":1858880144601632519}]},"time":1730000000000}`
  const r = client.parseInbound(req('text/plain'), enc(plain))
  check('解析出 message', r.kind === 'message', JSON.stringify(r))
  check('chatId = group:123456789', r.chatId === 'group:123456789', r.chatId)
  check('只拼 TEXT 块、跳过 AT/replyData', r.text === 'hello world', r.text)
  check('取的是 header.messageid 而不是 replyData 的', r.messageId === BIG, `${r.messageId} (期望 ${BIG})`)
}

console.log('\n[4] 重投去重')
{
  const BIG = '1859713223686736888'
  const plain = `{"MsgType":"text","FromUserId":"u1","Content":"hi","MsgId":${BIG}}`
  const form = new URLSearchParams({ messageJson: JSON.stringify({ Encrypt: enc(plain) }) }).toString()
  const a = client.parseInbound(req('application/x-www-form-urlencoded'), form)
  const b = client.parseInbound(req('application/x-www-form-urlencoded'), form)
  check('第一次是 message', a.kind === 'message', JSON.stringify(a))
  check('第二次被判定重复', b.kind === 'ignore' && b.reason === 'duplicate', JSON.stringify(b))
}

console.log('\n[5] 异常输入')
{
  check('未知 Content-Type → 400', client.parseInbound(req('application/json'), '{}').status === 400)
  const r = client.parseInbound(req('application/x-www-form-urlencoded'), new URLSearchParams({ messageJson: '{"Encrypt":""}' }).toString())
  check('缺 Encrypt → 400', r.kind === 'reply' && r.status === 400, JSON.stringify(r))
  const r2 = client.parseInbound(req('text/plain'), 'not-a-cipher')
  check('解密失败 → 500', r2.kind === 'reply' && r2.status === 500, JSON.stringify(r2))
}

console.log('\n[6] 非文本消息被忽略')
{
  const plain = '{"MsgType":"image","FromUserId":"u2","PicUrl":"https://x/y.png","MsgId":1859713223686736777}'
  const form = new URLSearchParams({ messageJson: JSON.stringify({ Encrypt: enc(plain) }) }).toString()
  const r = client.parseInbound(req('application/x-www-form-urlencoded'), form)
  check('图片消息 → ignore', r.kind === 'ignore', JSON.stringify(r))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
