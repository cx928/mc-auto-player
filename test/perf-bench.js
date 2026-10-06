// test/perf-bench.js - 性能基准：启动耗时 / 多假人内存与 CPU / 事件循环延迟 / 状态广播体积
//
// 用法: node test/perf-bench.js [假人数=10] [观测秒数=12]
// 需要本地测试服在 127.0.0.1:25566
'use strict'

const { performance, monitorEventLoopDelay } = require('perf_hooks')
const { BotManager } = require('../bot/manager')
const mineflayer = require('mineflayer')

const COUNT = Math.min(Math.max(Number(process.argv[2]) || 10, 1), 20)
const WATCH_SEC = Math.max(Number(process.argv[3]) || 12, 5)
const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.TEST_PORT || 25566)
// MC_MODE=raw 时用裸 mineflayer（不加载 pathfinder/tool/collectblock/AI），用于对照插件栈成本
const MODE = process.env.MC_MODE === 'raw' ? 'raw' : 'full'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const mb = (n) => (n / 1048576).toFixed(1)

// ---------- 对照组：裸 mineflayer ----------
async function runRaw () {
  const t0 = performance.now()
  const bots = []
  for (let i = 1; i <= COUNT; i++) {
    bots.push(mineflayer.createBot({
      host: MC_HOST,
      port: MC_PORT,
      username: 'RawBot' + i,
      auth: 'offline',
      version: false,
      viewDistance: process.env.MC_VIEW_DISTANCE || 'short',
      hideErrors: true
    }))
  }
  let upAt = null
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    if (bots.every((b) => b.entity)) { upAt = performance.now(); break }
  }
  // MC_PHYSICS=off 时关掉客户端物理模拟，用于量化物理循环的开销
  if (process.env.MC_PHYSICS === 'off') {
    for (const b of bots) b.physicsEnabled = false
    await sleep(1000)
  }
  const rss = process.memoryUsage().rss
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  const cpu0 = process.cpuUsage()
  await sleep(WATCH_SEC * 1000)
  const cpu1 = process.cpuUsage(cpu0)
  h.disable()
  for (const b of bots) { try { b.quit() } catch (_) {} }
  return {
    mode: 'raw（裸 mineflayer，无插件）',
    upSec: upAt ? (upAt - t0) / 1000 : null,
    rss,
    cpuMs: (cpu1.user + cpu1.system) / 1000,
    lagMean: h.mean / 1e6,
    lagP99: h.percentile(99) / 1e6,
    bytesPerSec: 0,
    payloadKB: 0,
    logs: 0
  }
}

async function runFull () {
  const t0 = performance.now()
  const manager = new BotManager({ persist: false })

  // 只统计与本基准相关的日志噪音
  let logLines = 0
  manager.on('log', () => { logLines++ })

  let botsPayloadBytes = 0
  manager.on('bots', (list) => { botsPayloadBytes += Buffer.byteLength(JSON.stringify(list)) })

  // 让 manager 正常工作（它会每秒广播一次状态）
  manager.setMaxListeners(0)

  const ids = manager.batchAdd({
    count: COUNT,
    namePrefix: 'PerfBot',
    host: MC_HOST,
    port: MC_PORT,
    version: 'auto',
    auth: 'offline',
    viewDistance: process.env.MC_VIEW_DISTANCE || undefined,
    idleThrottle: process.env.MC_THROTTLE !== 'off'
  })
  const tCreated = performance.now()
  manager.startAll()

  // 等全部上线
  let upAt = null
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const bots = manager.getBots()
    if (bots.length === COUNT && bots.every((b) => b.connected && b.pos)) { upAt = performance.now(); break }
  }

  const rssAfterConnect = process.memoryUsage().rss

  // 预热：等空闲省电生效后再开始测量，避免把连接期/首次物理的开销算进稳态
  await sleep(4000)

  // 观测窗口：按 2 秒切片采样 CPU，取中位数（比单次总时长相较更抗抖动）
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  const bytes0 = botsPayloadBytes
  const logs0 = logLines
  const rates = []
  const slices = Math.max(3, Math.floor(WATCH_SEC / 2))
  for (let i = 0; i < slices; i++) {
    const c0 = process.cpuUsage()
    await sleep(2000)
    const c = process.cpuUsage(c0)
    rates.push((c.user + c.system) / 1000 / 2) // ms/秒
  }
  h.disable()
  const bytes1 = botsPayloadBytes
  const logs1 = logLines

  rates.sort((a, b) => a - b)
  const medianRate = rates[Math.floor(rates.length / 2)]
  const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length
  const cpuMs = avgRate * WATCH_SEC
  const bots = manager.getBots()
  const payload = JSON.stringify(bots)

  manager.shutdown()

  return {
    mode: (process.env.MC_THROTTLE === 'off' ? 'full · 省电 OFF' : 'full · 省电 ON') + '（AutoPlayer + pathfinder/tool/collectblock）',
    upSec: upAt ? (upAt - t0) / 1000 : null,
    createMs: tCreated - t0,
    rss: rssAfterConnect,
    baseRss: rssBefore(),
    cpuMs,
    medianRate,
    avgRate,
    cpuPct: (medianRate / 1000 * 100),
    lagMean: h.mean / 1e6,
    lagP99: h.percentile(99) / 1e6,
    bytesPerSec: (bytes1 - bytes0) / slices / 2,
    payloadKB: Buffer.byteLength(payload) / 1024,
    logs: logs1 - logs0
  }
}

// 进程启动时的 RSS（粗略基线）
let _baseRss = 0
function rssBefore () {
  if (!_baseRss) _baseRss = process.memoryUsage().rss
  return _baseRss
}
rssBefore()

function report (r) {
  console.log('================ 性能基准 ================')
  console.log(`  模式                    : ${r.mode}`)
  console.log(`  假人数量                : ${COUNT}`)
  console.log(`  全部上线耗时            : ${r.upSec ? r.upSec.toFixed(1) + ' 秒' : '未全部上线'}`)
  if (r.createMs !== undefined) console.log(`  建对象耗时              : ${r.createMs.toFixed(0)} ms`)
  console.log(`  连接后 RSS              : ${mb(r.rss)} MB`)
  console.log(`  观测窗口                : ${WATCH_SEC} 秒`)
  console.log(`  CPU 占用（中位/均值）  : ${r.medianRate.toFixed(1)} / ${r.avgRate.toFixed(1)} ms/秒` +
    `   ≈ ${r.cpuPct.toFixed(1)}% 单核   （窗口 ${WATCH_SEC}s，预热 4s，2s 切片取中位）`)
  console.log(`  事件循环延迟 mean/p99   : ${r.lagMean.toFixed(2)} / ${r.lagP99.toFixed(2)} ms`)
  if (r.bytesPerSec) {
    console.log(`  状态广播                : ${(r.bytesPerSec / 1024).toFixed(1)} KB/s   单次负载 ${r.payloadKB.toFixed(2)} KB`)
    console.log(`  日志条数                : ${r.logs} 条 / ${WATCH_SEC} 秒`)
  }
  console.log('==========================================')
}

async function main () {
  const r = MODE === 'raw' ? await runRaw() : await runFull()
  report(r)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
