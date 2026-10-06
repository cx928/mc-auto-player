// test/quickstart-webui-check.js - 验证 WebUI 上的「一键挂机 / 预设 / 版本自动探测」
// 需要本地测试服在 127.0.0.1:25566
'use strict'

const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')

const PORT = 8716
const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.TEST_PORT || 25566)
const SETTINGS = path.join(os.tmpdir(), 'mc-webui-quick-settings.json')
const BASE = `http://127.0.0.1:${PORT}`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function get (p) {
  return new Promise((resolve) => {
    http.get(BASE + p, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ code: res.statusCode, body: d }))
    }).on('error', () => resolve({ code: 0, body: '' }))
  })
}
function post (p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {})
    const req = http.request(BASE + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ code: res.statusCode, body: d }))
    })
    req.on('error', () => resolve({ code: 0, body: '' }))
    req.write(data); req.end()
  })
}
const j = (s) => { try { return JSON.parse(s.body) } catch (_) { return {} } }

async function main () {
  fs.rmSync(SETTINGS, { force: true })
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'web', 'server.js'), '--port', String(PORT), '--bind', '127.0.0.1'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MC_SETTINGS: SETTINGS }
  })
  let srvOut = ''
  server.stdout.on('data', (d) => { srvOut += d.toString() })
  server.stderr.on('data', (d) => { srvOut += d.toString() })
  await sleep(2500)

  // 1. 状态接口带上版本清单 / 预设 / 正版状态
  const st = j(await get('/api/state'))
  check('状态接口返回版本清单', !!(st.versions && st.versions.all), st.versions ? `共 ${st.versions.all.length} 个正式版` : '缺失')
  check('版本清单含 1.12 与 26.3', !!(st.versions && st.versions.all.some((v) => v.version === '1.12') &&
    st.versions.all.some((v) => v.version === '26.3')))
  check('版本清单标出官方测试过的版本', !!(st.versions && st.versions.recommended && st.versions.recommended.includes('1.12.2')))
  check('状态接口返回预设与正版状态', Array.isArray(st.presets) && typeof st.microsoft === 'object')

  // 2. 保存预设
  const sp = await post('/api/savePreset', { name: '测试服', host: MC_HOST, port: MC_PORT, version: 'auto', auth: 'offline' })
  check('保存预设接口可用', sp.code === 200 && !!(j(sp).preset), JSON.stringify(j(sp).preset || {}))
  const st2 = j(await get('/api/state'))
  check('预设已出现在状态里', st2.presets.length === 1 && st2.presets[0].name === '测试服')

  // 3. 一键挂机（用预设，版本自动探测）
  const qs = await post('/api/quickStart', { presetName: '测试服', count: 2, namePrefix: 'WQ' })
  const ids = j(qs).ids || []
  check('一键挂机接口返回假人 id', ids.length === 2, 'ids=' + ids.join(','))

  let ok = false
  for (let i = 0; i < 30 && !ok; i++) {
    await sleep(1000)
    const s = j(await get('/api/state'))
    const list = (s.bots || []).filter((b) => ids.includes(b.id))
    ok = list.length === 2 && list.every((b) => b.connected)
    if (ok) {
      check('两个假人自动上线成功', true)
      check('自动探测出版本并回传到界面', list.every((b) => b.detectedVersion === '1.21.11'),
        list.map((b) => `${b.name}=${b.detectedVersion || '?'}(协议${b.protocolVersion || '?'}) 模式=${b.versionMode}`).join(' '))
      check('假人版本模式标记为自动探测', list.every((b) => b.version === 'auto'))
    }
  }
  if (!ok) check('两个假人自动上线成功', false, '30 秒内未全部上线')

  // 4. 名字去重：再来一批应该续号
  await post('/api/quickStart', { presetName: '测试服', count: 2, namePrefix: 'WQ' })
  await sleep(2500)
  const st3 = j(await get('/api/state'))
  const names = (st3.bots || []).map((b) => b.name).sort()
  check('名字自动去重（第二批续号不重名）', new Set(names).size === names.length, names.join(','))

  // 5. 预设持久化
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch (_) {}
  check('预设写入了配置文件', !!(saved && saved.presets && saved.presets.length === 1))

  server.kill()
  await sleep(500)
  fs.rmSync(SETTINGS, { force: true })

  const failed = results.filter(r => !r.ok)
  console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    failed.forEach(f => console.log('  失败: ' + f.name))
    console.log('--- 服务端输出 ---\n' + srvOut.split('\n').slice(-15).join('\n'))
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
