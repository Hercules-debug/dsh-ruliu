# dsh-ruliu

把**百度如流（InfoFlow）**接到 DeepSeek Harness：在如流里给机器人发消息就能驱动 DSH 会话，DSH 的回复自动回推到如流。

- 入站：如流开放平台的**回调（webhook）模式**，注册一个 HTTP 路由接收消息
- 出站：assistant 的文本回复发回单聊/群聊（群聊带引用回复）
- 交互：一组斜杠命令（`/new` `/list` `/use` `/end` `/status`），命令优先于对话
- 零额外依赖：只用 `node:crypto` + 全局 `fetch`，不需要装官方 SDK

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-ruliu
```

bundle 默认 `enabled: false`（不会自己启动）。启用要在 profile 的 `cordis.patch.yml` 里覆盖配置 —— 见下。

## 配置

安装并重新加载 DSH 后，在 Web UI 的 **设置 → 如流** 中填写应用凭证与回调密钥，使用方式和填写 API Key 类似。页面里的四项密钥是密码输入框，只显示“已配置”，不会回显原文；保存时留空表示保留已有密钥。

设置页提供以下字段：AppKey、AppSecret、回调校验 Token、消息加密 AES Key（这四项必填），机器人 Agent ID（可选），以及接口地址、回调路径、工作目录和消息类型。页面还会根据当前 DSH 地址生成可复制的回调 URL。

如果当前 DSH 是已经运行的旧版本，安装新版本后需要让插件重新加载一次；本地 link 开发环境还需要加载仓库里的 settings companion。正常从新版本安装时，客户端设置页面随插件一起加载。

首次安装或无法使用图形设置页时，也可以把 [配置模板](examples/cordis.patch.yml) 合并到 `${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml`，但个人凭证不要提交到 GitHub。

找到下面这段，把尖括号里的内容替换成你自己的值：

```yaml
- id: dsh-ruliu
  config:
    enabled: true
    appKey: '<这里填如流开放平台的 AppKey>'
    appSecret: '<这里填如流开放平台的 AppSecret>'
    agentId: 123456                 # 机器人 Agent ID，只填数字；不需要可以留空
    checkToken: '<这里填回调校验 Token>'
    encodingAESKey: '<这里填消息加密 AES Key，通常是 22 位>'
    apiHost: 'https://api.im.baidu.com'
    webhookPath: '/dsh-ruliu/webhook'
    cwd: '/path/to/your/workspace'
    msgType: 'text'
```

必须填写的值一共有四项：

| 配置项 | 填什么 | 从哪里获取 |
|---|---|---|
| `appKey` | 如流应用 AppKey | 如流开放平台的应用详情页 |
| `appSecret` | 如流应用 AppSecret | 同一个应用详情页；插件会自动计算接口所需的 md5，不要手动加密 |
| `checkToken` | 回调校验 Token | 如流开放平台「接收消息服务器」配置页；自己生成并填入两边也可以 |
| `encodingAESKey` | 消息加密 AES Key | 如流开放平台「接收消息服务器」配置页；通常是 22 位字符串 |

`agentId`（机器人 ID）**可选**：留空时发消息不带 `agentid` 字段，只影响部分需要它的接口。

`appKey` 和 `appSecret` 是如流**发给你的**应用凭证（用来换 `app_access_token` 发消息）；
`checkToken` 和 `encodingAESKey` 不是平台发给你的值，而是**回调模式下的双方约定值** ——
如流推送事件时会用它们签名、加密，所以必须在如流后台和本插件里填成一样的，
没法从 AppKey/AppSecret 推导出来。它们也不是本项目生成的值，不要把真实值提交到 GitHub。

| 字段 | 必需 | 说明 |
|---|---|---|
| `apiHost` | 可选 | 默认 `https://api.im.baidu.com`；百度内网机器通常使用 `http://apiin.im.baidu.com` |
| `webhookPath` | 可选 | 默认 `/dsh-ruliu/webhook`，要和如流后台填的一致 |
| `cwd` | 可选 | 新建 DSH 会话的工作目录，改成 DSH 实际运行的目录 |
| `msgType` | 可选 | 出站消息类型，`text`（默认）或 `md` |

**机器地址也要填**：在如流后台「接收消息服务器」里，把回调 URL 填成下面的形式，把 `<机器内网IP>` 换成运行 DSH 的机器 IP：

```text
http://<机器内网IP>:8080/dsh-ruliu/webhook
```

例如 DSH 机器内网 IP 是 `10.10.20.35`，就填：

```text
http://10.10.20.35:8080/dsh-ruliu/webhook
```

这里的机器 IP 必须是如流服务器能访问到的地址，不能填 `127.0.0.1` 或 `localhost`。如果 DSH 不是监听 8080 端口，还要把 URL 中的端口改成实际端口。

如流会先发一次 `echostr` 校验（插件按 `md5(rn + timestamp + checkToken)` 验签并原样回显），通过后才开始推消息。

## 行为

- **会话映射**：一个如流会话（单聊对端 / 群）↔ 一个 DSH 会话，映射存在 `<profile>/.dsh-ruliu/sessions.json`。首次收到消息时用 `ctx.agents.create()` 建会话，之后复用。
- **投递**：`agent.followup(createUserMessage({...}))`，即正常的一次用户回合。
- **回推**：订阅 `session/event` 的 `assistant/message`，取文本块拼接后发出（群聊带 `reply.messageid` 做引用回复）。
- **秒回**：回调先回 `200 success` 再异步处理，避免如流重投。
- **去重**：按消息 id 做 5 分钟窗口去重（如流会重投）。
- **大整数精度**：`messageid` 超过 2^53-1，插件从**解密后的 JSON 原文**用正则抠取，不走 `JSON.parse`。

## 命令

在如流里直接发（命令优先于对话，都不进模型、不烧 token）：

| 命令 | 作用 |
|---|---|
| `/new [提示词]` | 开一个新会话，可带首条提示词 |
| `/list`（别名 `/sessions`） | 列出最近的会话，最多 10 条 |
| `/use <序号>`（`/switch`、`/resume`） | 把本聊天切到 `/list` 里的第 N 个会话 |
| `/end` | 结束当前绑定，下条消息开新会话 |
| `/status` | 看当前绑定的会话与工作目录 |
| `/help`（`/?`） | 显示帮助 |

`/list` 的输出长这样：

```
🗂 **最近的会话**（用 `/use <序号>` 切换）

1. 测试如流与DSH链路
2. 我要做数字人的表情控制，让 ← 当前
3. 8010端口下载文件夹网页
```

**按「最近活跃」排序，不打印时间和活跃标记**：排序口径取自 `sessionController.list()` 的
`updatedAt`（= `max(createdAt, 最后一次用户消息时间)`），和 Web 侧边栏完全一致 —— 所以刚从
如流或 Web 任一侧聊过的会话就会排到第 1 条。该服务不可用时退回本插件自己从 `session/event`
攒的时间戳，再不行才按创建时间。时间和「🟢 活跃」都不打印：IM 是窄屏，这两项会把标题挤到
换行，而「活跃」本来就是排序依据，标出来是冗余信息。

**`← 当前` 标的是本聊天真正绑定的那条会话**：如流这边一个聊天只绑一条会话，而 `/list` 列的是
整个工作区的会话，两者不是一回事。注意只有**用户敲进来的消息**会推进活跃时间（审批、上下文注入
这类事件不算），所以「我刚点了下这个窗口」不一定等于「这个会话变成最近活跃」。绑定会话如果已经
掉出最近 10 条，`/list` 会在末尾补一行「当前绑定的是『标题』」，不会让它凭空消失。

**列表里不打印 `session-<uuid>`**：那是 DSH 的内部实现细节，IM 里的使用者读不出信息量也用不上
—— 切换靠序号。会话 id 只出现在 `<profile>/.dsh-ruliu/log.ndjson` 的 `command-list` /
`command-use` 事件里（`command-list` 还会带上渲染结果的 `preview` 和 `bound`），排查问题时看
日志即可。`/status` 同理，显示的是会话标题而不是 id。

**会话标题**：`/list` 会用 `sessionQuery.readTitleSnapshots()` 给历史会话补标题（软取，
拿不到就显示 `(未命名)`，不影响主流程）。

## 已验证 / 未验证

**已验证**：

- 协议层（`test/protocol.test.mjs`，离线自测、按规格自造密文、不需要真实凭证）：
  echostr 验签与回显、错误签名 403、单聊解析、群聊解析、文本块拼接（跳过 AT/replyData）、
  大整数 id 精确、重投去重、未知 Content-Type/缺 Encrypt/解密失败的 400/500 分支、非文本消息忽略。
- 端到端（真实凭证 + 内网如流）：`test/commands.test.mjs` 往活路由注入命令，
  `/help` `/status` `/list` 的收发、会话映射复用、出站回推均通。

**未验证**：真实报文的字段全貌、群聊 @ 语义、图片/文件消息、websocket 模式。

## 已知限制（v0.1）

- 只有 **webhook 模式**；websocket 模式（官方 SDK，无需公网回调）未实现
- **没有审批桥**：工具调用需要审批时不会推到如流，仍走 Web GUI
- **不做媒体**：图片/语音/文件消息只记日志并忽略
- 出站只发文本/markdown，不发图片/文件/卡片
- 一个如流会话同一时刻只绑一个 DSH 会话（用 `/use` 切，不能并发）

## 排错

- **回调 403**：`checkToken` 与后台不一致。
- **回调 500 / decryption failed**：`encodingAESKey` 不对（注意它是 Base64URLSafe，原始 22 位）。
- **回调 400 unsupported content type**：请求没带正确的 `Content-Type`，或后台推的不是这三种形态。
- **发消息失败**：看 `Authorization: Bearer-<token>`（连字符）与 `code:"ok"`（字符串）判定；
  出站走的是宿主进程的 fetch，若 `api.im.baidu.com` 在内网直连而宿主装了代理，
  需要把该域名加进代理的直连名单（`no_proxy` / 插件的 `noProxy`）。
- **插件没挂上**：`enabled: true` 且 `appKey`/`appSecret` 都非空，否则日志会写
  `dsh-ruliu: 凭证不全（需要 appKey + appSecret），通道未挂载`。
- **改完代码不生效**：profile 的 `hmr` 行要把插件目录加进 `config.root`，
  否则模块不会被监听（默认只监听 profile 配置）。改完 HMR 直接换模块，
  **不用重启 dsh**（重启会掐断如流这条线）。

## 实战记录（真实凭证 + 内网环境打通时踩的坑）

按出现顺序，每个都花了一轮排查：

1. **内联 `createUserMessage` 时漏了 `role: 'user'`**（最隐蔽的一个）
   表现：回合启动、记录 `user/message`，然后 LLM 调用以
   `DeepSeek Messages transport failed (code=TRANSPORT)` 失败并重试 5 次。
   根因：序列化历史时 `message.role === undefined` → provider 里
   `previous?.role === wireRole` 在**首条消息**上即成立（`undefined === undefined`）
   → 接着读 `previous.content` 抛 TypeError。
   定位方法：给 `dsh-llm-deepseek` 里 TRANSPORT 包装处临时插一行 `console.error`
   把被包住的 cause 打出来（本次就是这么找到的）。

2. **`create` 与 `resume` 都必须显式带 `agentOptions`（provider/model）**
   缺模型时回合第一步直接失败。

3. **preset 要组装**：`agentPresets.resolve` → `acquireScope` → `mount`
   （照官方 `dsh-webhook` 的顺序），否则 agent 的 scoped world 不完整。

4. **`sessionPersistence` 必须写进 `inject`**：Cordis 对未注入的服务属性直接抛
   `cannot get property "sessionPersistence" without inject`，而 `?.` 拦不住属性访问本身。
   表现是 `/list` 恒抛、只剩内存里的活跃会话，持久化的历史一条都列不出来。

5. **出站请求必须绕过代理**：`apiin.im.baidu.com` 走代理会返回 502。
   关键：bypass 列表由**代理插件的 `noProxy` 配置**决定，它**覆盖**启动脚本里的
   `no_proxy` env —— 所以要把 `.im.baidu.com,im.baidu.com` 写进插件的 `noProxy`，
   只写 env 不够。

6. **WS 模式在本机不可用**：端点分配接口返回公网
   `ws://infoflow-open-gateway.baidu.com/ws`（不可达）；内网网关
   `infoflow-open-gateway.weiyun.baidu.com` 只服务端点分配、不服务 WS
   （`/ws`、`/open/ws`、`/open/ws/connect`、`/im/ws` 全 404）；走代理握手被掐。
   ⇒ 只能用 webhook 模式。

**排障入口**：`<profile>/.dsh-ruliu/log.ndjson` —— 插件自己写的结构化日志，
每行 `{at, event, detail}`，覆盖 mounted / webhook-hit / inbound /
agent-options-resolved / preset-composed / session-created|resumed|reused /
followup-delivered|failed / turn-end / outbound-attempt|sent|failed。

> 注：命令类回复（`/list`、`/status` …）走的是 `client.sendText`，**不写**
> `outbound-attempt`（只有 assistant 消息那条路径写），所以日志里看不到它们，
> 别误判成"没发出去"。
