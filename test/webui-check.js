// test/webui-check.js - 验证 WebUI 版：页面、状态 API、SSE 实时推送
// 用法：node test/webui-check.js
'use strict'

const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const PORT = 8699
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

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
    const req = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ code: res.statusCode, body: d }))
    })
    req.on('error', () => resolve({ code: 0, body: '' }))
    req.write(data)
    req.end()
  })
}

// 订阅 SSE，收集收到的事件类型
function openSse (seen) {
  const req = http.get(BASE + '/api/events', (res) => {
    if (res.statusCode !== 200) { seen.status = res.statusCode; return }
    seen.status = 200
    res.on('data', (chunk) => {
      const text = chunk.toString()
      const m = /"type":"([a-z-]+)"/g
      let x
      while ((x = m.exec(text))) seen.types.add(x[1])
    })
  })
  req.on('error', () => {})
  return req
}

async function main () {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'web', 'server.js'), '--port', String(PORT)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MC_SETTINGS: path.join(os.tmpdir(), 'mc-webui-check-settings.json') }
  })
  let srvOut = ''
  server.stdout.on('data', (d) => { srvOut += d.toString() })
  server.stderr.on('data', (d) => { srvOut += d.toString() })
  await sleep(2000)

  const page = await get('/')
  check('控制面板页面可访问', page.code === 200 && page.body.includes('MC 自动玩家'), `状态=${page.code}`)

  const css = await get('/style.css')
  const js = await get('/app.js')
  check('静态资源可访问', css.code === 200 && js.code === 200, `css=${css.code} js=${js.code}`)

  const pathTraversal = await get('/../package.json')
  check('拒绝路径穿越请求', pathTraversal.code === 400 || pathTraversal.code === 404, `状态=${pathTraversal.code}`)

  const st = await get('/api/state')
  let stJson = {}
  try { stJson = JSON.parse(st.body) } catch (e) {}
  check('状态接口返回 JSON', st.code === 200 && Array.isArray(stJson.bots) && typeof stJson.ai === 'object',
    st.body.slice(0, 80))

  // SSE：订阅后触发一个会产生日志的动作，应收到 log 事件
  const seen = { status: 0, types: new Set() }
  const sseReq = openSse(seen)
  await sleep(600)
  check('SSE 连接建立', seen.status === 200, `状态=${seen.status}`)

  await post('/api/addBot', { name: 'UiTemp', host: '127.0.0.1', port: 25566, version: '1.21.11' }) // 会写日志 -> 触发 log 事件
  await sleep(1200)
  check('SSE 能收到实时事件', seen.types.has('log') || seen.types.has('bots'),
    '收到类型: ' + [...seen.types].join(','))

  const action = await post('/api/no-such-action', {})
  check('未知动作返回 404 而非崩溃', action.code === 404, `状态=${action.code}`)

  const alive = await get('/api/state')
  check('服务在异常请求后仍存活', alive.code === 200)

  sseReq.destroy()
  server.kill()

  const failed = results.filter(r => !r.ok).length
  console.log(`\n通过 ${results.length - failed} / ${results.length}`)
  if (failed && srvOut) console.log('服务端输出:\n' + srvOut.slice(-800))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
