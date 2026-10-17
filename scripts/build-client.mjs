import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLIENT_EXTERNALS = Object.freeze([
  'react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives',
])

/** Wrap the handwritten CommonJS face without adding a bundler or timestamps. */
export function buildClient(source) {
  if (typeof source !== 'string') throw new TypeError('Client source must be text')
  // This source deliberately uses only literal, synchronous external imports.
  if (/\bimport\s*(?:\(|[\w*{'"])/u.test(source)) throw new Error('Client source must use CommonJS require only')
  const calls = [...source.matchAll(/\brequire\s*\(([^)]*)\)/gu)]
  const mentions = [...source.matchAll(/\brequire\b/gu)]
  if (calls.length !== mentions.length) throw new Error('Client require must be a direct literal call')
  for (const [, argument] of calls) {
    const match = /^\s*(['"])([^'"\n]+)\1\s*$/u.exec(argument)
    if (!match || !CLIENT_EXTERNALS.includes(match[2])) {
      throw new Error(`Undeclared client external: ${argument.trim()}`)
    }
  }
  return `window.__ModuleLoader__.load({\n  id: 'dsh-ruliu',\n  factory(require) {\n    const module = { exports: {} };\n    const exports = module.exports;\n${source.replace(/\r\n?/gu, '\n').trimEnd().split('\n').map((line) => `    ${line}`).join('\n')}\n    return module.exports;\n  }\n});\n`
}

export function build({ check = false } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const source = readFileSync(resolve(root, 'client/settings.cjs'), 'utf8')
  const artifact = buildClient(source)
  // Check syntax offline without executing the factory or touching Host APIs.
  new Function('window', artifact)
  if (check) return artifact
  // 两份产物必须同源：
  //   1) lib/client.js —— package.json 的 `./client`，正常安装时用这份；
  //   2) ui/lib/client.js —— link 开发环境里 profile 按 `ui/index.mjs` 单独挂的
  //      settings companion（绕过 dsh-ruliu 的 client 元数据负缓存）。
  // 只生成其中一份会出现「宿主发的是新的、页面渲染的是旧的」这种漂移，实测踩过。
  const outputs = [resolve(root, 'lib/client.js')]
  if (existsSync(resolve(root, 'ui/package.json'))) outputs.push(resolve(root, 'ui/lib/client.js'))
  for (const output of outputs) {
    const previous = existsSync(output) ? readFileSync(output, 'utf8') : undefined
    if (previous !== artifact) {
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, artifact, 'utf8')
    }
  }
  return artifact
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  build({ check })
  console.log(check ? 'dsh-ruliu client source validated (no files written).' : 'Built lib/client.js and ui/lib/client.js deterministically.')
}
