// test/fetch-via-plugins.js - 给测试服下载 ViaVersion + ViaBackwards（用于验证"新版服务器 + 旧版客户端"）
// 用法: node test/fetch-via-plugins.js <目标服务端目录> <目标MC版本>
'use strict'

const fs = require('fs')
const path = require('path')

const dir = process.argv[2]
const mcVersion = process.argv[3] || '26.3'
if (!dir) { console.error('用法: node test/fetch-via-plugins.js <服务端目录> [MC版本]'); process.exit(2) }

const pluginsDir = path.join(dir, 'plugins')

async function pickAndDownload (project) {
  const listRes = await fetch(`https://api.modrinth.com/v2/project/${project}/version`, {
    headers: { 'User-Agent': 'mc-auto-player-test/0.1 (github.com/cx928/mc-auto-player)' }
  })
  if (!listRes.ok) throw new Error(`Modrinth 查询 ${project} 失败: HTTP ${listRes.status}`)
  const versions = await listRes.json()
  // 优先挑声明支持目标 MC 版本的，其次挑最新的
  const fit = versions.find((v) => (v.game_versions || []).includes(mcVersion)) || versions[0]
  const file = (fit.files || []).find((f) => f.primary) || (fit.files || [])[0]
  if (!file) throw new Error(`${project} 没有可下载文件`)
  const buf = await fetch(file.url, { headers: { 'User-Agent': 'mc-auto-player-test/0.1' } }).then((r) => {
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`)
    return r.arrayBuffer()
  })
  fs.mkdirSync(pluginsDir, { recursive: true })
  const out = path.join(pluginsDir, file.filename)
  fs.writeFileSync(out, Buffer.from(buf))
  console.log(`  ${project}: ${file.filename} (${(Buffer.from(buf).length / 1048576).toFixed(1)} MB, 支持 ${(fit.game_versions || []).slice(-3).join('/')})`)
  return out
}

async function main () {
  console.log(`为 ${dir} 下载 Via 插件（目标版本 ${mcVersion}）...`)
  for (const p of ['viaversion', 'viabackwards']) {
    try { await pickAndDownload(p) } catch (e) { console.log(`  ${p} 失败: ${e.message}`) }
  }
  const got = fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : []
  console.log('plugins 目录: ' + (got.join(', ') || '（空）'))
}

main().catch((e) => { console.error(e); process.exit(1) })
