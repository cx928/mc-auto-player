// test/multiversion-check.js - 多版本真实服务端实测
// 对每个版本的官方服务端：启动 → 用本项目的 AutoPlayer（版本自动探测）连接 → 校验版本/生成/寻路 → 关服
// 用法: node test/multiversion-check.js [版本...]   例: node test/multiversion-check.js 1.12.2 26.3
'use strict'

const path = require('path')
const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
const AutoPlayer = require('../bot/auto-player')
const { NEWEST_TESTED } = require('../bot/versions')

const ROOT = process.env.MC_TEST_ROOT || 'E:\\Documents\\deepseek-harness\\default-workspace\\mc-test-servers'
const JAVA = process.env.MC_JAVA || 'java'

const ALL = [
  { mc: '1.12.2', dir: '1.12.2', port: 25570 },
  { mc: '1.16.5', dir: '1.16.5', port: 25571 },
  { mc: '1.20.4', dir: '1.20.4', port: 25572 },
  { mc: '26.1', dir: '26.1', port: 25574 },
  { mc: '26.3', dir: '26.3', port: 25573 }
]

const want = process.argv.slice(2)
const targets = want.length ? ALL.filter((t) => want.includes(t.mc)) : ALL

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []

async function waitFor (fn, timeoutMs, step = 500) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (await fn()) return true } catch (_) {}
    await sleep(step)
  }
  return false
}

async function testOne (t) {
  const dir = path.join(ROOT, t.dir)
  if (!fs.existsSync(path.join(dir, 'server.jar'))) {
    console.log(`\n=== ${t.mc} === 跳过：缺少服务端 jar`)
    results.push({ mc: t.mc, ok: false, note: '缺少服务端 jar' })
    return
  }

  console.log(`\n=== 实测 ${t.mc}（端口 ${t.port}）===`)
  let out = ''
  // stdin 用 pipe，方便发 stop 指令优雅关服（否则进程会残留占着端口）
  const server = spawn(JAVA, ['-Xmx1G', '-jar', 'server.jar', 'nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => { out += d.toString() })
  server.stderr.on('data', (d) => { out += d.toString() })

  const stopServer = async () => {
    try { server.stdin.write('stop\n') } catch (_) {}
    const exited = await waitFor(() => server.exitCode !== null, 20000, 500)
    if (!exited && server.pid) {
      try { spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }) } catch (_) {}
    }
    await sleep(1500)
  }

  const ready = await waitFor(() => /Done \(/.test(out), 150000, 1000)
  if (!ready) {
    console.log('  服务端 150 秒内未就绪，输出末尾：')
    console.log(out.split('\n').slice(-12).map((l) => '    ' + l).join('\n'))
    await stopServer()
    results.push({ mc: t.mc, ok: false, note: '服务端未启动' })
    return
  }
  console.log('  服务端已就绪')

  // 用产品代码连接：默认版本留 auto（让 mineflayer 自动探测）；可用 MC_FORCE_VERSION 指定版本
  const player = new AutoPlayer()
  const logs = []
  const forceVersion = process.env.MC_FORCE_VERSION
  player.on('log', (l) => { logs.push(l); if (/error|warn|服务器版本|登录成功|生成到世界/.test(l)) console.log('    ' + l) })
  player.start({
    host: '127.0.0.1',
    port: t.port,
    username: `Ver${t.mc.replace(/\./g, '')}Bot`,
    auth: 'offline',
    version: forceVersion || 'auto'
  })

  const spawned = await waitFor(() => player.running && player.bot && player.bot.entity, 60000, 500)
  const row = { mc: t.mc, ok: false, note: '' }

  if (!spawned) {
    row.note = '连接或生成失败'
    console.log('  连接失败，日志末尾：' + logs.slice(-4).join(' | '))
  } else {
    const detected = player.bot.version
    const proto = player.bot.protocolVersion
    console.log(`  已连上：探测版本=${detected} 协议=${proto}`)
    const verOk = detected === t.mc
    // 允许"版本回退"：探测到超出上游支持范围的版本时，程序会自动用最新支持版本重试
    const fallbackOk = !verOk && detected === NEWEST_TESTED
    row.detected = detected
    row.protocol = proto
    row.versionOk = verOk

    // 寻路验证（旧版本上 pathfinder 是否可用）
    const p0 = player.bot.entity.position.clone()
    player.walkTo(Math.round(p0.x + 10), Math.round(p0.y), Math.round(p0.z + 10))
    const moved = await waitFor(() => {
      const p = player.bot && player.bot.entity ? player.bot.entity.position : null
      return !!(p && p.distanceTo(p0) > 5)
    }, 40000, 500)
    row.moved = moved
    const dist = player.bot && player.bot.entity ? player.bot.entity.position.distanceTo(p0).toFixed(1) : '?'
    console.log(`  寻路移动距离: ${dist} 格`)

    // 聊天验证
    let chatted = false
    try { player.sendChat(`版本实测 ${t.mc}`); chatted = true } catch (_) {}
    row.chat = chatted

    row.ok = spawned && (verOk || fallbackOk) && moved && chatted
    row.fallback = fallbackOk
    row.note = verOk
      ? '全部通过'
      : (fallbackOk ? `版本超范围，自动回退到 ${detected} 后连上（需服务端 ViaVersion/ViaBackwards）` : `版本不符：期望 ${t.mc} 得到 ${detected}`)
  }

  player.stop()
  await sleep(1200)
  await stopServer()
  results.push(row)
}

async function main () {
  for (const t of targets) await testOne(t)

  console.log('\n================ 多版本实测汇总 ================')
  console.log('  版本      结果    探测版本   协议   寻路   说明')
  for (const r of results) {
    console.log(`  ${String(r.mc).padEnd(8)}  ${(r.ok ? '✅ 通过' : '❌ 失败').padEnd(6)}  ${String(r.detected || '-').padEnd(9)}  ${String(r.protocol || '-').padEnd(5)}  ${String(r.moved === undefined ? '-' : (r.moved ? 'ok' : 'fail')).padEnd(5)}  ${r.note}`)
  }
  const failed = results.filter(r => !r.ok).length
  console.log(`\n通过 ${results.length - failed} / ${results.length}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
