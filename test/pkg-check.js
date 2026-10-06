// test/pkg-check.js - 验证"打包后"的产物是否真的能跑（不是验证源码）
// 用法:
//   node test/pkg-check.js <可执行文件> cli     # 命令行版：连服务器、发言、查状态
//   node test/pkg-check.js <可执行文件> webui   # WebUI 版：起服务、测页面与 API
'use strict'

const http = require('http')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const exe = process.argv[2]
const kind = process.argv[3] || 'cli'
const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = process.env.TEST_PORT || '25566'
const WEB_PORT = Number(process.env.WEB_PORT || 8712)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

function httpGet (p) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${WEB_PORT}${p}`, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ code: res.statusCode, body: d }))
    }).on('error', () => resolve({ code: 0, body: '' }))
  })
}

function httpPost (p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {})
    const req = http.request(`http://127.0.0.1:${WEB_PORT}${p}`, {
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

async function checkCli () {
  const count = Number(process.env.PKG_COUNT || 1)
  // PKG_HOST_WITH_PORT=1 时把端口写在 --host 里（用户最容易踩的写法），验证自动拆分
  const withPortInHost = process.env.PKG_HOST_WITH_PORT === '1'
  console.log(`启动打包后的可执行文件: ${exe}` + (count > 1 ? `（多假人模式，${count} 个）` : ''))
  const cliArgs = ['--host', withPortInHost ? `${MC_HOST}:${MC_PORT}` : MC_HOST, '--user', 'PkgBot', '--version', '1.21.11']
  if (!withPortInHost) cliArgs.push('--port', MC_PORT)
  if (count > 1) cliArgs.push('--count', String(count))
  const child = spawn(exe, cliArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d) })
  child.stderr.on('data', (d) => { err += d.toString() })

  await sleep(11000)
  check('打包后的程序能启动并打印用法', out.includes('命令行模式'))
  if (withPortInHost) {
    check('地址里的端口被正确识别（横幅显示正确的 host:port）',
      out.includes(`目标服务器: ${MC_HOST}:${MC_PORT}`), (out.match(/目标服务器:[^\n]*/) || [''])[0].trim())
  }
  check('能连接 1.21.11 服务器', out.includes('登录成功'))
  check('能生成到世界', out.includes('已生成到世界中'))

  if (count > 1) {
    child.stdin.write('/bots\n')
    await sleep(2500)
    const names = [...out.matchAll(/PkgBot(\d+)/g)].map(m => m[1])
    const uniq = new Set(names)
    check(`多假人模式：${count} 个假人同时在线`, uniq.size >= count, '看到编号: ' + [...uniq].join(','))
  }

  child.stdin.write('打包版发言测试\n')
  await sleep(2500)
  check('能发送聊天', out.includes('打包版发言测试'))

  child.stdin.write('/status\n')
  await sleep(2500)
  check('状态查询返回 JSON', out.includes('"connected": true'))

  child.stdin.write('/quit\n')
  await sleep(2000)
  check('能正常退出', child.exitCode !== null || out.includes('连接结束'))
  try { child.kill() } catch (_) {}
  if (err) console.log('stderr: ' + err.slice(0, 400))
}

async function checkWebui () {
  console.log(`启动打包后的 WebUI 可执行文件: ${exe}`)
  const child = spawn(exe, ['--port', String(WEB_PORT), '--bind', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MC_SETTINGS: path.join(os.tmpdir(), 'mc-pkg-check-settings.json') }
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(d) })
  child.stderr.on('data', (d) => { out += d.toString() })
  await sleep(3000)

  check('服务成功启动', out.includes('WebUI 模式'))
  const page = await httpGet('/')
  check('控制面板页面可访问', page.code === 200 && page.body.includes('MC 自动玩家'), `状态=${page.code}`)
  const st = await httpGet('/api/state')
  let stj = {}
  try { stj = JSON.parse(st.body) } catch (_) {}
  check('状态接口可用', st.code === 200 && Array.isArray(stj.bots), st.body.slice(0, 60))

  const addRes = await httpPost('/api/addBot', { name: 'WebPkgBot', host: MC_HOST, port: Number(MC_PORT), version: '1.21.11', auth: 'offline' })
  let id = null
  try { id = JSON.parse(addRes.body).id } catch (_) {}
  check('通过网页添加假人', !!id, 'id=' + id)

  await httpPost('/api/startBot', { id })
  await sleep(12000)
  const st2 = await httpGet('/api/state')
  let found = null
  try { found = (JSON.parse(st2.body).bots || []).find((x) => x.id === id) } catch (_) {}
  check('通过网页控制假人上线成功', !!(found && found.connected && found.health === 20),
    found ? `connected=${found.connected} health=${found.health} user=${found.name}` : '未找到假人')

  await httpPost('/api/action', { id, name: 'chat', args: { msg: '来自打包版 WebUI' } })
  await sleep(1500)
  await httpPost('/api/stopBot', { id })
  await sleep(2000)
  const st3 = await httpGet('/api/state')
  let found3 = null
  try { found3 = (JSON.parse(st3.body).bots || []).find((x) => x.id === id) } catch (_) {}
  check('通过网页断开成功', !!(found3 && found3.connected === false))
  check('断开后服务仍存活', (await httpGet('/')).code === 200)

  try { child.kill() } catch (_) {}
}

async function main () {
  if (!exe) { console.error('用法: node test/pkg-check.js <可执行文件> [cli|webui]'); process.exit(2) }
  if (kind === 'cli') await checkCli()
  else await checkWebui()

  const failed = results.filter(r => !r.ok)
  console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) failed.forEach(f => console.log('  失败: ' + f.name))
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
