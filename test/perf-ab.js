// test/perf-ab.js - 单进程内交替对照：量化"客户端物理模拟"的真实开销
//
// 为什么这样做：跨进程比较会被 JIT 预热、GC 时机、连接期突发开销污染，
// 同一配置两次能差 20%。这里在同一个进程里对同一批假人交替开关 bot.physicsEnabled，
// 取各条件的采样中位数，噪声小得多。
//
// 用法: node test/perf-ab.js [假人数=10] [每种条件采样秒数=8] [轮数=3]
'use strict'

const mineflayer = require('mineflayer')

const COUNT = Math.min(Math.max(Number(process.argv[2]) || 10, 1), 20)
const SAMPLE_SEC = Math.max(Number(process.argv[3]) || 8, 4)
const ROUNDS = Math.max(Number(process.argv[4]) || 3, 1)
const MC_HOST = process.env.TEST_HOST || '127.0.0.1'
const MC_PORT = Number(process.env.TEST_PORT || 25566)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function sample (label, ms) {
  const slices = []
  const n = Math.max(2, Math.round(ms / 2000)) // 每片 2 秒
  for (let i = 0; i < n; i++) {
    const c0 = process.cpuUsage()
    await sleep(2000)
    const c = process.cpuUsage(c0)
    slices.push((c.user + c.system) / 1000 / 2)
  }
  slices.sort((a, b) => a - b)
  const med = slices[Math.floor(slices.length / 2)]
  console.log(`    ${label.padEnd(22)} 中位 ${med.toFixed(1).padStart(6)} ms/秒   各切片: ${slices.map((s) => s.toFixed(0)).join(', ')}`)
  return med
}

async function main () {
  console.log(`连接 ${COUNT} 个裸 mineflayer 假人（无插件，隔离物理成本）...`)
  const bots = []
  for (let i = 1; i <= COUNT; i++) {
    bots.push(mineflayer.createBot({
      host: MC_HOST, port: MC_PORT, username: 'AbBot' + i,
      auth: 'offline', version: false, hideErrors: true,
      viewDistance: process.env.MC_VIEW_DISTANCE || 'short'
    }))
  }
  const end = Date.now() + 90000
  while (Date.now() < end && !bots.every((b) => b.entity)) await sleep(500)
  console.log(`  已上线 ${bots.filter((b) => b.entity).length} / ${COUNT}`)

  // 预热：让 JIT 与区块解析稳定下来
  console.log('  预热 6 秒...')
  await sleep(6000)

  const onRates = []
  const offRates = []
  for (let r = 1; r <= ROUNDS; r++) {
    console.log(`  第 ${r} 轮：`)
    for (const b of bots) b.physicsEnabled = false
    await sleep(2500)
    offRates.push(await sample('物理 OFF', SAMPLE_SEC * 1000))

    for (const b of bots) b.physicsEnabled = true
    await sleep(2500)
    onRates.push(await sample('物理 ON', SAMPLE_SEC * 1000))
  }

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const off = med(offRates)
  const on = med(onRates)
  console.log('\n================ 结论 ================')
  console.log(`  物理 OFF 中位: ${off.toFixed(1)} ms/秒  (${(off / 10).toFixed(2)}% 单核)`)
  console.log(`  物理 ON  中位: ${on.toFixed(1)} ms/秒  (${(on / 10).toFixed(2)}% 单核)`)
  console.log(`  物理模拟开销  : ${(on - off).toFixed(1)} ms/秒  ≈ 总开销的 ${(((on - off) / on) * 100).toFixed(0)}%`)
  console.log(`  每个假人      : ${((on - off) / COUNT).toFixed(1)} ms/秒（物理部分）`)
  console.log('======================================')

  for (const b of bots) { try { b.quit() } catch (_) {} }
  await sleep(500)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
