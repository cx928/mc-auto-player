// test/fetch-server-jars.js - 下载指定版本的官方服务端 jar（BMCLAPI 优先，失败回退官方源）
// 用法: node test/fetch-server-jars.js 1.20.4 26.3
'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

const ROOT = process.env.MC_TEST_ROOT || 'E:\\Documents\\deepseek-harness\\default-workspace\\mc-test-servers'
const versions = process.argv.slice(2)
if (!versions.length) { console.error('用法: node test/fetch-server-jars.js <版本...>'); process.exit(2) }

function fetchBuf (url, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuf(res.headers.location, timeoutMs).then(resolve, reject)
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('下载超时')))
  })
}

async function officialUrl (version) {
  const man = JSON.parse((await fetchBuf('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).toString())
  const entry = (man.versions || []).find((v) => v.id === version)
  if (!entry) throw new Error(`官方清单里没有版本 ${version}`)
  const detail = JSON.parse((await fetchBuf(entry.url)).toString())
  if (!detail.downloads || !detail.downloads.server) throw new Error(`${version} 没有服务端下载项`)
  return detail.downloads.server.url
}

async function main () {
  for (const v of versions) {
    const dir = path.join(ROOT, v)
    fs.mkdirSync(dir, { recursive: true })
    const jar = path.join(dir, 'server.jar')
    if (fs.existsSync(jar) && fs.statSync(jar).size > 5 * 1024 * 1024) {
      console.log(`[${v}] 已存在 ${(fs.statSync(jar).size / 1048576).toFixed(1)} MB，跳过`)
      continue
    }
    const sources = [
      ['BMCLAPI', `https://bmclapi2.bangbang93.com/version/${v}/server`],
      ['BMCLAPI(备用域名)', `https://bmclapi.bangbang93.com/version/${v}/server`]
    ]
    let ok = false
    for (const [label, url] of sources) {
      try {
        process.stdout.write(`[${v}] 尝试 ${label} ... `)
        const buf = await fetchBuf(url)
        if (buf.length < 5 * 1024 * 1024) throw new Error(`文件太小(${buf.length} 字节)，可能不是 jar`)
        fs.writeFileSync(jar, buf)
        console.log(`成功 ${(buf.length / 1048576).toFixed(1)} MB`)
        ok = true
        break
      } catch (e) {
        console.log('失败: ' + e.message)
      }
    }
    if (!ok) {
      try {
        process.stdout.write(`[${v}] 回退官方源 ... `)
        const url = await officialUrl(v)
        const buf = await fetchBuf(url)
        fs.writeFileSync(jar, buf)
        console.log(`成功 ${(buf.length / 1048576).toFixed(1)} MB`)
        ok = true
      } catch (e) {
        console.log('失败: ' + e.message)
      }
    }
    if (!ok) console.log(`[${v}] ⚠️ 未能下载服务端`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
